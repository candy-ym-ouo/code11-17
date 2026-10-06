#!/usr/bin/env bash
# 家庭存储分层与保留策略的运维入口。
#
# 用法：
#   bash scripts/storage.sh tier [familyId]   # 投递冷热分层/保留期任务（全量或指定家庭）
#   bash scripts/storage.sh plans [familyId]  # 查看最近的预演单（动作与影响面在 result/impact）
#   bash scripts/storage.sh quota [familyId]  # 查看家庭配额与实际用量
#
# 修改策略/配额与「预演 → 确认 → 执行」请走管理 API（前端「存储管理」页），
# 脚本只做触发与观察，不直接改数据，避免绕过审计。
set -euo pipefail

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
require_db

cmd="${1:-tier}"

case "$cmd" in
  tier)
    family="${2:-}"
    STAMP="$(date +%Y%m%d%H%M%S)"
    JOB_ID="manual-tier-$STAMP"
    if [ -n "$family" ]; then
      payload="{\"trigger\":\"manual\",\"familyId\":\"$family\"}"
    else
      payload='{"trigger":"manual_all"}'
    fi
    info "投递分层任务 $JOB_ID ${family:+（家庭 $family）}"
    psql "$PG_URL" -q -c "
INSERT INTO jobs (id, type, family_id, payload, status, attempts, max_attempts, progress, created_at, updated_at)
VALUES ('$JOB_ID', 'storage_tier', ${family:-NULL}, '$payload'::jsonb, 'queued', 0, 1, 0, now(), now());
"
    info "等待执行（最多 180 秒）"
    for _ in $(seq 1 60); do
      st="$(pg_query "select status from jobs where id='$JOB_ID'")"
      case "$st" in done|failed) break;; esac
      sleep 3
    done
    psql "$PG_URL" -x -c "select id, status, result, last_error from jobs where id='$JOB_ID';"
    ;;

  plans)
    family="${2:-}"
    if [ -n "$family" ]; then
      where="where family_id='$family'"
    else
      where=""
    fi
    psql "$PG_URL" -c "
select id, family_id, status, trigger, created_at, applied_at,
       jsonb_array_length(actions) as actions
from storage_plans $where
order by created_at desc limit 20;"
    ;;

  quota)
    family="${2:-}"
    if [ -z "$family" ]; then
      fail "quota 子命令需要 familyId"
    fi
    psql "$PG_URL" -c "
with u as (
  select
    coalesce(sum(case when m.tier='hot' then m.byte_size else 0 end), 0) as hot_used,
    coalesce(sum(case when m.tier='cold' then m.byte_size else 0 end), 0) as cold_used,
    coalesce(sum(m.byte_size), 0) as total_used
  from item_media m
  join items i on i.id = m.item_id
  where i.family_id='$family' and m.deleted_at is null and i.deleted_at is null
),
q as (
  select coalesce(hot_bytes_limit, 0) as hot_limit, coalesce(total_bytes_limit, 0) as total_limit
  from storage_quotas where family_id='$family'
)
select
  (select hot_limit from q) as hot_bytes_limit,
  (select total_limit from q) as total_bytes_limit,
  hot_used, cold_used, total_used
from u;"
    ;;

  *)
    warn "未知命令：$cmd"
    echo "可用命令：tier [familyId] | plans [familyId] | quota <familyId>"
    exit 1
    ;;
esac
