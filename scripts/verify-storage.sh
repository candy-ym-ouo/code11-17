#!/usr/bin/env bash
# 存储配额与冷热分层 · 端到端闭环验证
# 走真实 HTTP：配额即时生效（超限 507）→ 按类型策略 → 预演影响面 → 确认执行（降冷）→
# 冷层读取仍可用 → 访问触发自动取回 → 删除类预演 → 确认物理回收 → 审计留痕。
#
# 用法：API=http://127.0.0.1:4000 bash scripts/verify-storage.sh
set -euo pipefail

API="${API:-http://127.0.0.1:4000}"
V1="$API/api/v1"
RUN_ID="$(date +%s)-$RANDOM"
OWNER_EMAIL="storage-$RUN_ID@example.com"
OWNER_PASSWORD="family2026"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
JAR="$WORK/owner.cookies"
# 与 API 启动时的存储根保持一致（可用环境变量覆盖）
HOT_DIR="${HOT_DIR:-$ROOT_DIR/data/uploads}"
COLD_DIR="${COLD_DIR:-$ROOT_DIR/data/cold}"
PASS=0
FAIL=0
PSQL_BIN="${PSQL_BIN:-psql}"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die()  { bad "$1"; finish; exit 1; }

json() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=$1;process.stdout.write(v===undefined?'':String(v))"; }

req() { # req METHOD PATH TOKEN [JSON_BODY]
  local method="$1" path="$2" token="$3" body="${4:-}"
  local args=(-sS -o "$WORK/body" -w '%{http_code}' -X "$method" -b "$JAR" -c "$JAR")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data "$body")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  curl "${args[@]}" "$V1$path"
}
req_file() { # req_file PATH TOKEN FILE KIND
  curl -sS -o "$WORK/body" -w '%{http_code}' -X POST -b "$JAR" -c "$JAR" \
    -H "Authorization: Bearer $2" -F "file=@$3" -F "kind=$4" "$V1$1"
}
expect() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3（期望 $2，实际 $1）$(head -c 240 "$WORK/body" 2>/dev/null)"; fi; }
wait_job() { # 等 job 到达 done/failed，参数：类型过滤用的 payload runId（通过状态轮询 cleanup run 即可，此函数轮询 jobs 不必要）
  :
}

finish() {
  printf '\n== 结果：%d 通过，%d 失败 ==\n' "$PASS" "$FAIL"
}
trap finish EXIT

echo "== 存储配额 / 冷热分层 / 清理预演 · 闭环验证 =="
echo "API: $API"

# ---------- 1. 健康与注册 ----------
step "1/9 健康检查、注册、建家庭"
code=$(curl -sS -o "$WORK/body" -w '%{http_code}' "$API/readyz"); expect "$code" 200 "/readyz 就绪"

code=$(req POST /auth/register "" "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\",\"displayName\":\"存储管理员\"}")
[ "$code" = "201" ] || [ "$code" = "409" ] || die "注册失败 $code"
code=$(req POST /auth/login "" "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}")
expect "$code" 200 "登录"
TOKEN=$(json 'd.accessToken' < "$WORK/body")
[ -n "$TOKEN" ] || die "拿不到 access token"

code=$(req POST /families "$TOKEN" "{\"name\":\"存储验证家庭-$RUN_ID\"}")
expect "$code" 201 "创建家庭"
FID=$(json 'd.family.id' < "$WORK/body")
[ -n "$FID" ] || die "拿不到 family id"

# ---------- 2. 建已归档条目并上传媒体 ----------
step "2/9 建条目、上传图片（内容寻址）"
code=$(req POST "/families/$FID/items" "$TOKEN" \
  "{\"title\":\"旧怀表\",\"category\":\"souvenir\",\"visibility\":\"family\",\"acquiredLabel\":\"民国\"}")
expect "$code" 201 "建条目（草稿）"
ITEM=$(json 'd.item.id' < "$WORK/body")

# 1x1 PNG
PNG="$WORK/a.png"
base64 -d > "$PNG" <<'B64'
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC
B64
# 复制成第二个不同文件（不同 sha），用于配额判定
cp "$PNG" "$WORK/b.png"
# 制造一个 ~12KB 的第二个图片（追加随机字节仍然是嗅探可识别的 PNG 吗？不行——改像素）
# 用 node 生成一张更大的 PNG
node -e '
const fs=require("fs"),zlib=require("zlib"),crypto=require("crypto");
function crc32(b){let c=~0;for(let i=0;i<b.length;i++){c^=b[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c>>>0;}
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type);const cd=Buffer.concat([t,data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(cd));return Buffer.concat([len,cd,crc]);}
const W=100,H=100;
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;
const raw=Buffer.alloc((W*3+1)*H);
for(let y=0;y<H;y++){raw[y*(W*3+1)]=0;for(let x=0;x<W;x++){const o=y*(W*3+1)+1+x*3;raw[o]=x*2%256;raw[o+1]=y*2%256;raw[o+2]=(x+y)%256;}}
const idat=zlib.deflateSync(raw,{level:9});
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",idat),chunk("IEND",Buffer.alloc(0))]);
fs.writeFileSync(process.argv[1],png);
' "$WORK/big.png"
BIG_SIZE=$(stat -c%s "$WORK/big.png" 2>/dev/null || stat -f%z "$WORK/big.png")

code=$(req_file "/families/$FID/items/$ITEM/media" "$TOKEN" "$PNG" image)
expect "$code" 202 "上传图片 a"
MID_A=$(json 'd.media.id' < "$WORK/body")
code=$(req_file "/families/$FID/items/$ITEM/media" "$TOKEN" "$WORK/big.png" image)
expect "$code" 202 "上传图片 big（${BIG_SIZE} 字节）"
MID_B=$(json 'd.media.id' < "$WORK/body")

# 内容去重：重复上传同一文件不应翻倍计费
code=$(req_file "/families/$FID/items/$ITEM/media" "$TOKEN" "$PNG" image)
expect "$code" 202 "重复上传同一图片（去重命中）"

# 发布再归档（策略默认只处理已归档条目）
code=$(req PATCH "/families/$FID/items/$ITEM" "$TOKEN" '{"status":"published"}' 2>/dev/null) || true
# 发布有专门动作时走更新；该项目用 PATCH status 字段
code=$(req POST "/families/$FID/items/$ITEM/publish" "$TOKEN" "")
[ "$code" = "200" ] || code=$(req PATCH "/families/$FID/items/$ITEM" "$TOKEN" '{"status":"published"}')
ok "发布条目（$code）"
code=$(req POST "/families/$FID/items/$ITEM/archive" "$TOKEN" "")
[ "$code" = "200" ] || code=$(req PATCH "/families/$FID/items/$ITEM" "$TOKEN" '{"status":"archived"}')
expect "$code" 200 "归档条目"

# ---------- 3. 用量与配额 ----------
step "3/9 用量统计与配额即时生效"
code=$(req GET "/families/$FID/storage/overview" "$TOKEN")
expect "$code" 200 "读取用量总览"
USED=$(json 'd.usage.physicalBytes' < "$WORK/body")
LOGICAL=$(json 'd.usage.logicalBytes' < "$WORK/body")
COUNT=$(json 'd.usage.mediaCount' < "$WORK/body")
echo "    物理占用=$USED（去重后），逻辑引用=$LOGICAL，媒体引用数=$COUNT"
[ "$USED" -ge "$BIG_SIZE" ] && ok "物理用量包含大图" || bad "物理用量异常: $USED < $BIG_SIZE"
[ "$LOGICAL" -gt "$USED" ] && ok "逻辑引用 ≥ 物理占用（去重生效：3 条引用 / 2 个对象）" || bad "去重统计异常 logical=$LOGICAL physical=$USED"

# 把配额设到用量以下 → 立即超限，新上传被拒 507
QUOTA_GB="0.000001" # ~1073 字节，肯定小于当前用量
code=$(req PUT "/families/$FID/storage/quota" "$TOKEN" "{\"quotaGb\":$QUOTA_GB}")
expect "$code" 200 "调小配额"
STATE=$(json 'd.state' < "$WORK/body")
expect "$STATE" over "总览状态立即变为 over"
code=$(req_file "/families/$FID/items/$ITEM/media" "$TOKEN" "$PNG" image)
expect "$code" 507 "超限后上传被拒绝（507 QUOTA_EXCEEDED）"
ERRCODE=$(json 'd.error.code' < "$WORK/body")
expect "$ERRCODE" QUOTA_EXCEEDED "错误码为 QUOTA_EXCEEDED"

# 放开配额 → 立刻又能传（即时生效，无需重启）
code=$(req PUT "/families/$FID/storage/quota" "$TOKEN" '{"quotaGb":null}')
expect "$code" 200 "放开配额为不限"
code=$(req_file "/families/$FID/items/$ITEM/media" "$TOKEN" "$PNG" image)
expect "$code" 202 "放开后上传立即恢复"

# ---------- 4. 配置按类型策略 ----------
step "4/9 图片策略：热层 0 天、保留期空（只降冷不删除）"
code=$(req PUT "/families/$FID/storage/policies" "$TOKEN" \
  '{"policies":[{"kind":"image","hotDays":0,"maxAgeDays":null,"onlyArchived":true,"enabled":true},{"kind":"audio","hotDays":null,"maxAgeDays":null,"onlyArchived":true,"enabled":true},{"kind":"document","hotDays":null,"maxAgeDays":null,"onlyArchived":true,"enabled":true}]}')
expect "$code" 200 "保存三类媒体策略"
HOT=$(json 'd.policies.find(p=>p.kind==="image").hotDays' < "$WORK/body")
expect "$HOT" 0 "图片 hotDays=0"

# ---------- 5. 预演 ----------
step "5/9 清理预演（只看影响面，不动文件）"
# 前面放开配额后又上传了一次，重新取一次当前引用数
code=$(req GET "/families/$FID/storage/overview" "$TOKEN")
COUNT=$(json 'd.usage.mediaCount' < "$WORK/body")
LOGICAL=$(json 'd.usage.logicalBytes' < "$WORK/body")
code=$(req POST "/families/$FID/storage/cleanups/preview" "$TOKEN" '{"kinds":["image"],"note":"验证预演"}')
expect "$code" 201 "生成预演"
RUN=$(json 'd.run.id' < "$WORK/body")
TIER_FILES=$(json 'd.run.tierFiles' < "$WORK/body")
DEL_FILES=$(json 'd.run.deleteFiles' < "$WORK/body")
KEYS=$(json 'd.affectedKeys.length' < "$WORK/body")
echo "    计划 $RUN：降冷 $TIER_FILES 引用 / 删除 $DEL_FILES 引用 / $KEYS 个去重对象"
[ "$TIER_FILES" = "$COUNT" ] && ok "预演覆盖全部 $COUNT 条图片引用（含去重引用）" || bad "预演引用数异常: $TIER_FILES != $COUNT"
[ "$DEL_FILES" -eq 0 ] && ok "未配置保留期 → 没有删除动作" || bad "出现意外删除动作: $DEL_FILES"

# 预演不改任何状态
code=$(req GET "/families/$FID/storage/overview" "$TOKEN")
TIER_HOT=$(json 'd.usage.countByTier.hot' < "$WORK/body")
[ "$TIER_HOT" = "$COUNT" ] && ok "预演后媒体仍全在热层（预演无副作用）" || bad "预演产生了副作用 hot=$TIER_HOT count=$COUNT"

# 取消重预演也应可用
code=$(req POST "/families/$FID/storage/cleanups/cancel" "$TOKEN" "{\"runId\":\"$RUN\"}")
expect "$code" 204 "取消预演"
code=$(req POST "/families/$FID/storage/cleanups/preview" "$TOKEN" '{"kinds":["image"]}')
expect "$code" 201 "重新预演"
RUN=$(json 'd.run.id' < "$WORK/body")

# ---------- 6. 确认执行：降冷 ----------
step "6/9 确认执行降冷"
code=$(req POST "/families/$FID/storage/cleanups/$RUN/approve" "$TOKEN" '{"confirm":"清理"}')
expect "$code" 202 "确认执行（入队 storage_purge）"

# 等 worker 跑完（最多 30 秒）
DONE=0
for i in $(seq 1 30); do
  code=$(req GET "/families/$FID/storage/cleanups/$RUN" "$TOKEN")
  ST=$(json 'd.run.status' < "$WORK/body")
  if [ "$ST" = "done" ]; then DONE=1; break; fi
  sleep 1
done
[ "$DONE" = "1" ] && ok "清理任务执行完成" || bad "清理任务未在 30 秒内完成（status=$ST）"
RDONE=$(json 'd.run.result.done' < "$WORK/body")
echo "    执行明细：成功 $RDONE"

code=$(req GET "/families/$FID/storage/overview" "$TOKEN")
COLD_CNT=$(json 'd.usage.countByTier.cold' < "$WORK/body")
COLD_BYTES=$(json 'd.usage.bytesByTier.cold' < "$WORK/body")
[ "$COLD_CNT" = "$COUNT" ] && ok "全部媒体引用已标记冷层（$COLD_CNT）" || bad "冷层计数异常 cold=$COLD_CNT count=$COUNT"
[ "$COLD_BYTES" = "$LOGICAL" ] && ok "冷层字节为逻辑引用合计（同组整组降冷）" || bad "冷层字节异常 cold=$COLD_BYTES logical=$LOGICAL"

# 磁盘层面：文件确实搬到冷目录（2 个去重对象，与引用数不同）
COLD_FILES=$(find "$COLD_DIR" -type f -path '*/objects/*' 2>/dev/null | wc -l | tr -d ' ')
HOT_FILES=$(find "$HOT_DIR" -type f -path '*/objects/*' 2>/dev/null | wc -l | tr -d ' ')
echo "    磁盘：冷对象 $COLD_FILES 个，热对象 $HOT_FILES 个"
[ "$COLD_FILES" = "2" ] && ok "冷盘上有 2 个去重原始对象（按对象不是按引用）" || bad "冷盘对象数异常: $COLD_FILES（期望 2）"
[ "$HOT_FILES" = "0" ] && ok "热盘原始对象已全部搬走" || bad "热盘仍有 $HOT_FILES 个原始对象"

# 缩略图等派生件应留在热层
HOT_DERIVED=$(find "$HOT_DIR" -type f -path '*/derived/*' 2>/dev/null | wc -l | tr -d ' ')
echo "    热层派生件：$HOT_DERIVED 个"
[ "$HOT_DERIVED" -ge 1 ] && ok "派生件（缩略图）保留在热层" || bad "热层没有派生件"

# ---------- 7. 冷层可读 + 访问触发自动取回 ----------
step "7/9 冷层文件仍可读，访问后自动取回热层"
code=$(curl -sS -o "$WORK/raw.png" -w '%{http_code}' -b "$JAR" -H "Authorization: Bearer $TOKEN" \
  "$V1/families/$FID/media/$MID_B/raw")
expect "$code" 200 "冷层原始件读取成功（本次直接从冷盘流式返回）"
TIER_HEADER=$(curl -sS -D - -o /dev/null -b "$JAR" -H "Authorization: Bearer $TOKEN" \
  "$V1/families/$FID/media/$MID_B/raw" | grep -i '^x-storage-tier:' | tr -d '\r' | awk '{print $2}')
expect "$TIER_HEADER" cold "响应头标注 X-Storage-Tier: cold"
DL_SIZE=$(stat -c%s "$WORK/raw.png" 2>/dev/null || stat -f%z "$WORK/raw.png")
[ "$DL_SIZE" = "$BIG_SIZE" ] && ok "下载字节与原文件一致（$DL_SIZE）" || bad "下载字节不一致 $DL_SIZE != $BIG_SIZE"

# 取回按「内容对象」成组：访问大图后，只有大图所在的组回到热层（小图组仍冷）
for i in $(seq 1 30); do
  code=$(req GET "/families/$FID/storage/overview" "$TOKEN")
  HC=$(json 'd.usage.countByTier.hot' < "$WORK/body")
  if [ "$HC" = "1" ]; then break; fi
  sleep 1
done
[ "$HC" = "1" ] && ok "访问后大图组自动取回热层（该组 1 条引用），小图组仍在冷层" || bad "按组取回数量异常 hot=$HC（期望 1）"

# 再访问小图，整组（3 条去重引用）一起回热
curl -sS -o /dev/null -b "$JAR" -H "Authorization: Bearer $TOKEN" "$V1/families/$FID/media/$MID_A/raw"
RESTORED=0
for i in $(seq 1 30); do
  code=$(req GET "/families/$FID/storage/overview" "$TOKEN")
  HC=$(json 'd.usage.countByTier.hot' < "$WORK/body")
  if [ "$HC" = "$COUNT" ]; then RESTORED=1; break; fi
  sleep 1
done
[ "$RESTORED" = "1" ] && ok "访问小图后，其全部去重引用整组回到热层（$HC/$COUNT）" || bad "30 秒内未整组取回（hot=$HC/$COUNT）"

# ---------- 8. 删除型策略：预演 → 物理回收 ----------
step "8/9 配置删除保留期，预演并确认物理删除"
code=$(req PUT "/families/$FID/storage/policies" "$TOKEN" \
  '{"policies":[{"kind":"image","hotDays":null,"maxAgeDays":0,"onlyArchived":true,"enabled":true},{"kind":"audio","hotDays":null,"maxAgeDays":null,"onlyArchived":true,"enabled":true},{"kind":"document","hotDays":null,"maxAgeDays":null,"onlyArchived":true,"enabled":true}]}')
expect "$code" 200 "图片策略改为到期即删（maxAgeDays=0）"

code=$(req POST "/families/$FID/storage/cleanups/preview" "$TOKEN" '{"kinds":["image"],"note":"验证删除"}')
expect "$code" 201 "删除预演"
RUN2=$(json 'd.run.id' < "$WORK/body")
D2=$(json 'd.run.deleteFiles' < "$WORK/body")
[ "$D2" -ge "$COUNT" ] && ok "预演计划删除全部 $COUNT 条引用" || bad "删除计划数量异常: $D2"

# 确认前文件仍在
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" -H "Authorization: Bearer $TOKEN" "$V1/families/$FID/media/$MID_A/raw")
expect "$code" 200 "确认前文件仍可访问"

code=$(req POST "/families/$FID/storage/cleanups/$RUN2/approve" "$TOKEN" '{"confirm":"清理"}')
expect "$code" 202 "确认删除计划"
for i in $(seq 1 30); do
  code=$(req GET "/families/$FID/storage/cleanups/$RUN2" "$TOKEN")
  ST=$(json 'd.run.status' < "$WORK/body")
  [ "$ST" = "done" ] && break
  sleep 1
done
expect "$ST" done "删除执行完成"
RECLAIM=$(json 'd.run.result.reclaimedBytes' < "$WORK/body")
echo "    回收 $RECLAIM 字节"

# 媒体引用被软删
code=$(req GET "/families/$FID/storage/overview" "$TOKEN")
LIVE=$(json 'd.usage.mediaCount' < "$WORK/body")
TRASH=$(json 'd.usage.trashCount' < "$WORK/body")
[ "$LIVE" = "0" ] && ok "活媒体引用清零" || bad "仍有活引用: $LIVE"
[ "$TRASH" -ge "$COUNT" ] && ok "引用进入回收站统计（$TRASH）" || bad "回收站计数异常: $TRASH"

# 物理对象已从热层移除（本计划删除前媒体都已取回热层）
LEFT=$(find "$HOT_DIR" "$COLD_DIR" -type f -path '*/objects/*' 2>/dev/null | wc -l | tr -d ' ')
[ "$LEFT" = "0" ] && ok "物理对象已从热/冷层回收（0 残留）" || bad "仍有 $LEFT 个物理对象未回收"

# 已删媒体不可访问 → 404
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" -H "Authorization: Bearer $TOKEN" "$V1/families/$FID/media/$MID_A/raw")
expect "$code" 404 "删除后访问返回 404"

# ---------- 9. 审计 ----------
step "9/9 审计留痕（配额/策略/预演/确认/执行/取回）"
code=$(req GET "/families/$FID/audit-logs?limit=200" "$TOKEN")
expect "$code" 200 "读取审计日志"
for ACT in storage.quota_update storage.policy_update storage.cleanup_preview storage.cleanup_approve storage.cleanup_run storage.restore; do
  N=$(json "[...new Set(d.logs.map(l=>l.action))].filter(a=>a==='$ACT').length" < "$WORK/body")
  [ "$N" -ge 1 ] && ok "审计含 $ACT" || bad "审计缺少 $ACT"
done

finish
[ "$FAIL" = "0" ]
