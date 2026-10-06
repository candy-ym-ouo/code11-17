import type { ItemMedia, MediaKind, Prisma } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import { AppError, badRequest, conflict } from '../http/errors';
import { logger } from '../logger';
import { isColdKey, moveKey, remove, toColdKey, toHotKey } from '../storage/local';
import {
  buildPlan,
  type KindPolicy,
  type MediaSnapshot,
  type PlanAction,
  type PlannerResult,
  type Quota,
} from '../storage/planner';
import * as audit from './auditService';
import type { ActorMeta } from './familyService';
import { ensurePolicies, getQuotaLimits } from './storageSettingsService';

type Db = Prisma.TransactionClient;

const ACTION_KINDS = ['demote', 'unlink', 'purge'] as const;

/** 物理迁移的咨询锁键空间（Postgres pg_advisory_xact_lock 的 32bit key 前缀约定）。 */
const ADVISORY_KEYSPACE = 0x53_54_4f_00; // 'STO\0'

// ───────────────────────── 快照装配 ─────────────────────────

function rowToSnapshot(m: ItemMedia & { item: { status: string; deletedAt: Date | null } | null }): MediaSnapshot {
  // 行自身软删，或所属条目进了回收站，都视作「逻辑已删」，进入保留期计时
  const deletedAt = m.deletedAt ?? (m.item?.status === 'trashed' ? m.item.deletedAt : null);
  return {
    id: m.id,
    itemId: m.itemId,
    kind: m.kind,
    tier: m.tier,
    byteSize: Number(m.byteSize),
    protected: false, // 单条保护位目前不在表上；类型级保护在策略里表达
    deletedAt: deletedAt ? deletedAt.getTime() : null,
    lastAccessedAt: m.lastAccessedAt.getTime(),
    createdAt: m.createdAt.getTime(),
    storageKey: m.storageKey,
    thumbKey: m.thumbKey,
    largeKey: m.largeKey,
    transcodeKey: m.transcodeKey,
    waveformKey: m.waveformKey,
  };
}

async function loadSnapshots(familyId: string, db: Db | typeof prisma = prisma): Promise<MediaSnapshot[]> {
  const rows = await db.itemMedia.findMany({
    where: { item: { familyId } },
    include: { item: { select: { status: true, deletedAt: true } } },
  });
  return rows.map(rowToSnapshot);
}

async function loadPolicyRows(familyId: string, db: Db | typeof prisma = prisma): Promise<KindPolicy[]> {
  const rows = await db.storagePolicy.findMany({ where: { familyId } });
  return rows.map((r) => ({
    kind: r.kind,
    hotMaxIdleDays: r.hotMaxIdleDays,
    coldRetentionDays: r.coldRetentionDays,
    protected: r.protected,
  }));
}

// ───────────────────────── 预演 ─────────────────────────

export interface PreviewInput {
  familyId: string;
  maxActions?: number;
  now?: number;
}

/** 纯只读预演：不落库、不动文件。 */
export async function previewFamily(input: PreviewInput): Promise<PlannerResult> {
  const [media, policies, limits] = await Promise.all([
    loadSnapshots(input.familyId),
    loadPolicyRows(input.familyId),
    getQuotaLimits(input.familyId),
  ]);
  const quota: Quota = limits;
  return buildPlan({
    media,
    policies,
    quota,
    now: input.now ?? Date.now(),
    maxActions: input.maxActions,
  });
}

export interface CreatePlanInput extends PreviewInput {
  actorId: string;
  trigger: 'manual' | 'quota_change' | 'daily_maintenance' | 'api';
  reason?: string | null;
  meta?: ActorMeta;
}

/** 预演并持久化一张可审计的预演单。 */
export async function createStoredPlan(input: CreatePlanInput) {
  const plan = await previewFamily(input);
  const ttlMs = config.STORAGE_PLAN_TTL_HOURS * 3_600_000;
  return prisma.$transaction(async (tx) => {
    if (input.trigger !== 'daily_maintenance') await ensurePolicies(input.familyId, input.actorId, tx);
    const stored = await tx.storagePlan.create({
      data: {
        familyId: input.familyId,
        status: 'open',
        trigger: input.trigger,
        actions: plan.actions as unknown as Prisma.InputJsonValue,
        impact: impactOf(plan, input.reason ?? null) as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(plan.generatedAt + ttlMs),
        createdBy: input.actorId,
      },
    });
    await audit.record(
      {
        familyId: input.familyId,
        actorId: input.actorId,
        action: 'storage.plan_create',
        targetType: 'storage_plan',
        targetId: stored.id,
        diff: {
          trigger: input.trigger,
          reason: input.reason ?? null,
          actions: plan.summary,
          unresolved: plan.unresolvedViolations,
        } as unknown as Prisma.InputJsonValue,
        ...(input.meta ?? {}),
      },
      tx,
    );
    return { planId: stored.id, plan };
  });
}

function impactOf(p: PlannerResult, reason: string | null) {
  return {
    reason,
    generatedAt: new Date(p.generatedAt).toISOString(),
    current: p.current,
    projected: p.projected,
    quota: p.quota,
    unresolvedViolations: p.unresolvedViolations,
    summary: p.summary,
  };
}

// ───────────────────────── 执行（并发安全核心） ─────────────────────────

export interface ActionOutcome {
  actionId: string;
  type: PlanAction['type'];
  status: 'done' | 'skipped';
  detail: unknown;
}

export interface ApplyResult {
  planId: string;
  status: 'applied' | 'failed';
  outcomes: ActionOutcome[];
  appliedAt: string;
}

export class StalePlanError extends AppError {
  constructor(message: string, details?: unknown) {
    super('CONFLICT', message, details);
  }
}

/**
 * 原子认领一张预演单：open（或上次执行中断的 failed）且未过期才能认领。
 * UPDATE … WHERE 条件更新构成 CAS，两个执行者只有一个能拿到 count=1。
 * failed 单允许重试：每个动作在执行时都会重新校验文件/行状态，重复执行幂等。
 */
async function claimPlan(tx: Db, planId: string, familyId: string, actorId: string): Promise<boolean> {
  const res = await tx.$executeRaw`
    UPDATE storage_plans
    SET applied_by = ${actorId}, status = 'open', updated_at = now()
    WHERE id = ${planId} AND family_id = ${familyId} AND status IN ('open', 'failed')
      AND expires_at > now() AND applied_by IS NULL
  `;
  return res === 1;
}

export async function applyStoredPlan(
  planId: string,
  familyId: string,
  actorId: string,
  meta: ActorMeta = {},
): Promise<ApplyResult> {
  const outcomes: ActionOutcome[] = [];
  const appliedAt = new Date();

  const claimed = await prisma.$transaction((tx) => claimPlan(tx, planId, familyId, actorId));
  if (!claimed) {
    const plan = await prisma.storagePlan.findUnique({ where: { id: planId } });
    if (!plan || plan.familyId !== familyId) throw badRequest('预演单不存在');
    if (plan.status === 'applied') throw conflict('预演单已执行完成，不能重复执行');
    if (plan.expiresAt.getTime() < Date.now()) throw conflict('预演单已过期，请重新预演');
    throw conflict('预演单正在被另一个任务执行，或状态不允许执行');
  }

  const plan = await prisma.storagePlan.findUniqueOrThrow({ where: { id: planId } });
  const actions = plan.actions as unknown as PlanAction[];

  try {
    // 每个动作各自一个事务 + 物理文件操作；单动作失败即整单标 failed 并中止，
    // 已完成的动作不回滚（都是幂等操作，重试安全）。
    for (const action of actions) {
      if (!ACTION_KINDS.includes(action.type)) throw new Error(`未知动作类型: ${String(action.type)}`);
      const outcome = await runAction(familyId, action, actorId, meta);
      outcomes.push(outcome);
    }

    await prisma.$transaction(async (tx) => {
      await tx.storagePlan.update({
        where: { id: planId },
        data: { status: 'applied', appliedAt, result: { outcomes } as unknown as Prisma.InputJsonValue },
      });
      await audit.record(
        {
          familyId,
          actorId,
          action: 'storage.plan_apply',
          targetType: 'storage_plan',
          targetId: planId,
          diff: { count: outcomes.length, trigger: plan.trigger } as unknown as Prisma.InputJsonValue,
          ...meta,
        },
        tx,
      );
    });
    return { planId, status: 'applied', outcomes, appliedAt: appliedAt.toISOString() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.storagePlan.update({
      where: { id: planId },
      data: {
        status: 'failed',
        // 释放认领标记：单动作都幂等，修复后可基于同一预演单重新执行
        appliedBy: null,
        result: { outcomes, error: message, failedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue,
      },
    });
    logger.error({ planId, err: message }, '存储预演单执行失败');
    throw err;
  }
}

async function runAction(
  familyId: string,
  action: PlanAction,
  actorId: string,
  meta: ActorMeta,
): Promise<ActionOutcome> {
  if (action.type === 'demote') return demoteAction(familyId, action, actorId, meta);
  if (action.type === 'purge') return purgeAction(familyId, action, actorId, meta);
  return unlinkAction(familyId, action, actorId, meta);
}

function advisoryKeyFor(storageKey: string): number {
  // 把 key 散列到 32bit；与固定命名空间组合成两个 int，供 pg_advisory_xact_lock(int, int)。
  let h = 2166136261;
  for (let i = 0; i < storageKey.length; i += 1) {
    h ^= storageKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/**
 * 降冷。顺序经过并发推演后刻意固定为：
 *   1) 事务内对该 storageKey 加事务级咨询锁（同 key 的 demote / 回暖 / unlink 全部串行）；
 *   2) 重读所有共享行，确认仍为 hot 且仍然存在（预演后可能被改动/删除）；
 *   3) 物理 move（幂等，目标存在即成功）；
 *   4) 同事务把所有共享行 tier 改 cold，写审计。
 * 文件操作在事务提交前完成：若事务回滚，冷目录会留下孤儿文件，由现有 storage_gc 扫描回收（安全侧）。
 */
async function demoteAction(
  familyId: string,
  action: PlanAction,
  actorId: string,
  meta: ActorMeta,
): Promise<ActionOutcome> {
  const key = action.storageKey!;
  const lockKey = advisoryKeyFor(key);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_KEYSPACE}, ${lockKey})`;
    // 家庭行锁：与上传事务（assertUploadWithinQuota 同样锁家庭行）串行，
    // 杜绝「上传判定原片在热层」与「原片被搬到冷层」交错。
    await tx.$executeRaw`SELECT 1 FROM families WHERE id = ${familyId} FOR UPDATE`;
    const rows = await tx.itemMedia.findMany({ where: { storageKey: key, item: { familyId } } });
    const hotRows = rows.filter((r) => r.tier === 'hot');
    if (rows.length === 0) return { actionId: action.id, type: 'demote', status: 'skipped', detail: '媒体行已不存在' };
    if (hotRows.length === 0) return { actionId: action.id, type: 'demote', status: 'skipped', detail: '已经是冷层' };

    const coldKey = toColdKey(key);
    const moveResult = await moveKey(key, coldKey);

    await tx.itemMedia.updateMany({
      where: { storageKey: key, tier: 'hot' },
      data: { tier: 'cold', tieredAt: new Date() },
    });
    await audit.record(
      {
        familyId,
        actorId,
        action: 'storage.demote',
        targetType: 'media',
        targetId: action.mediaId,
        diff: {
          reason: action.reason,
          source: action.source,
          storageKey: key,
          coldKey,
          rows: hotRows.length,
          bytes: action.bytes,
        } as unknown as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return { actionId: action.id, type: 'demote', status: 'done', detail: { rows: hotRows.length, moveResult } };
  });
}

/** 回暖（promote）：读取冷文件时触发。与 demote 共用咨询锁，保证两个方向不会交错。 */
export async function promoteIfCold(media: ItemMedia): Promise<'promoted' | 'unchanged'> {
  if (media.tier !== 'cold') return 'unchanged';
  const key = media.storageKey;
  const lockKey = advisoryKeyFor(key);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_KEYSPACE}, ${lockKey})`;
    const rows = await tx.itemMedia.findMany({
      where: { storageKey: key },
      include: { item: { select: { familyId: true } } },
    });
    const coldRows = rows.filter((r) => r.tier === 'cold');
    if (coldRows.length === 0) return 'unchanged';
    const hotKey = toHotKey(key);
    await moveKey(key, hotKey);
    await tx.itemMedia.updateMany({
      where: { storageKey: key, tier: 'cold' },
      data: { tier: 'hot', tieredAt: null, lastAccessedAt: new Date() },
    });
    await audit.record(
      {
        familyId: coldRows[0]!.item.familyId,
        actorId: coldRows[0]!.createdBy,
        action: 'storage.promote',
        targetType: 'media',
        targetId: coldRows[0]!.id,
        diff: { storageKey: key, rows: coldRows.length, reason: 'cold_access' } as unknown as Prisma.InputJsonValue,
      },
      tx,
    );
    return 'promoted';
  });
}

/**
 * purge 超期媒体行。带条件校验，防止「预演后、执行前」条目被从回收站恢复：
 * 只有行仍处于删除状态（行 deletedAt 非空，或条目仍是 trashed）才删除。
 */
async function purgeAction(
  familyId: string,
  action: PlanAction,
  actorId: string,
  meta: ActorMeta,
): Promise<ActionOutcome> {
  const lockKey = advisoryKeyFor(action.storageKey!);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_KEYSPACE}, ${lockKey})`;
    const m = await tx.itemMedia.findFirst({
      where: { id: action.mediaId, item: { familyId } },
      include: { item: { select: { status: true, deletedAt: true } } },
    });
    if (!m) return { actionId: action.id, type: 'purge', status: 'skipped', detail: '行已不存在' };
    const stillDead = m.deletedAt !== null || m.item.status === 'trashed';
    if (!stillDead) {
      // 条目在预演后被恢复：放弃删除，仅记录跳过
      return { actionId: action.id, type: 'purge', status: 'skipped', detail: '条目已从回收站恢复' };
    }
    await tx.itemMedia.delete({ where: { id: m.id } });
    await audit.record(
      {
        familyId,
        actorId,
        action: 'storage.purge',
        targetType: 'media',
        targetId: m.id,
        diff: {
          reason: action.reason,
          kind: m.kind,
          bytes: action.bytes,
          storageKey: m.storageKey,
        } as unknown as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return { actionId: action.id, type: 'purge', status: 'done', detail: { storageKey: m.storageKey } };
  });
}

/**
 * unlink 物理文件。删除前在事务内重新做一次引用计数（咨询锁保护），
 * 只有没有任何媒体行（含软删/回收站保留期内行）引用该 key 时才真正 remove，
 * 杜绝「预演后出现了新的同 sha 上传」导致的误删。
 *
 * 注意物理位置：降冷后数据库里 storage_key 仍是热层逻辑 key，但原片物理上在 cold/ 目录，
 * 因此原片要同时尝试热/冷两个位置；派生文件始终在热层。
 */
async function unlinkAction(
  familyId: string,
  action: PlanAction,
  actorId: string,
  meta: ActorMeta,
): Promise<ActionOutcome> {
  const keys = action.keys ?? [];
  const removed: string[] = [];
  const retained: string[] = [];
  for (const key of keys) {
    const lockKey = advisoryKeyFor(key);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_KEYSPACE}, ${lockKey})`;
      const holders = await countHolders(tx, key);
      if (holders > 0) {
        retained.push(key); // 预演后又有人引用（恢复/重新上传），放弃删除
        return;
      }
      const physicalKeys = resolvePhysicalKeys(key);
      for (const physical of physicalKeys) {
        await remove(physical); // remove 对不存在的路径是幂等 no-op
      }
      removed.push(key);
      await audit.record(
        {
          familyId,
          actorId,
          action: 'storage.unlink',
          targetType: 'storage_object',
          targetId: null,
          diff: { storageKey: key, physicalKeys, reason: action.reason } as unknown as Prisma.InputJsonValue,
          ...meta,
        },
        tx,
      );
    });
  }
  return {
    actionId: action.id,
    type: 'unlink',
    status: retained.length === 0 ? 'done' : 'skipped',
    detail: { removed, retained },
  };
}

/** 内容寻址原片可能在热层或冷层；派生文件（derived/）只有热层一个位置。 */
function resolvePhysicalKeys(key: string): string[] {
  const parts = key.split('/');
  const isOriginal = parts.length >= 3 && parts[2] === 'objects';
  return isOriginal ? [key, toColdKey(key)] : [key];
}

async function countHolders(tx: Db, key: string): Promise<number> {
  const [a, b, c, d, e] = await Promise.all([
    tx.itemMedia.count({ where: { storageKey: key } }),
    tx.itemMedia.count({ where: { thumbKey: key } }),
    tx.itemMedia.count({ where: { largeKey: key } }),
    tx.itemMedia.count({ where: { transcodeKey: key } }),
    tx.itemMedia.count({ where: { waveformKey: key } }),
  ]);
  return a + b + c + d + e;
}

// ───────────────────────── 上传配额（即时拦截） ─────────────────────────

export class QuotaExceededError extends AppError {
  constructor(
    message: string,
    readonly which: 'total' | 'hot',
    readonly limitBytes: number,
    readonly usedBytes: number,
  ) {
    super('FILE_TOO_LARGE', message, { which, limitBytes, usedBytes });
    this.name = 'QuotaExceededError';
  }
}

/**
 * 上传落盘前的配额校验。在创建媒体行的同一事务内调用，靠家庭行锁串行化同一家庭的并发上传：
 * 两个并发上传不会同时通过「还有空间」的判断（避免超卖）。
 * 内容寻址命中（文件已存在、不新增物理占用）由调用方先判定后跳过本检查。
 */
export async function assertUploadWithinQuota(tx: Db, familyId: string, kind: MediaKind, addBytes: number): Promise<void> {
  if (!config.STORAGE_QUOTA_ENFORCE_UPLOAD) return;
  const limits = await getQuotaLimits(familyId, tx);
  // 锁家庭行，序列化同家庭并发上传
  await tx.$executeRaw`SELECT family_id FROM families WHERE id = ${familyId} FOR UPDATE`;

  const agg = await tx.itemMedia.aggregate({
    where: { item: { familyId, deletedAt: null }, deletedAt: null },
    _sum: { byteSize: true },
  });
  const totalUsed = Number(agg._sum.byteSize ?? 0n);
  if (limits.totalBytesLimit !== null && totalUsed + addBytes > limits.totalBytesLimit) {
    throw new QuotaExceededError(
      `家庭总存储配额不足（已用 ${totalUsed} 字节，本次需要 ${addBytes}），请联系管理员清理或扩容`,
      'total',
      limits.totalBytesLimit,
      totalUsed,
    );
  }
  const hotAgg = await tx.itemMedia.aggregate({
    where: { item: { familyId, deletedAt: null }, deletedAt: null, tier: 'hot' },
    _sum: { byteSize: true },
  });
  const hotUsed = Number(hotAgg._sum.byteSize ?? 0n);
  if (limits.hotBytesLimit !== null && hotUsed + addBytes > limits.hotBytesLimit) {
    throw new QuotaExceededError(
      `热层存储配额不足（已用 ${hotUsed} 字节）。可先在「存储管理」里执行降冷，或联系管理员调整配额`,
      'hot',
      limits.hotBytesLimit,
      hotUsed,
    );
  }
  void kind;
}

// ───────────────────────── 访问时间（节流回写） ─────────────────────────

/**
 * 媒体原片被读取时回写 last_accessed_at（决定闲置降冷的时间）。
 * 节流：距上次回写不足 STORAGE_ACCESS_TOUCH_MIN_MS 就跳过，避免每次播放都产生写事务。
 */
export async function touchAccessed(mediaId: string): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE item_media
      SET last_accessed_at = now()
      WHERE id = ${mediaId}
        AND last_accessed_at < now() - make_interval(secs => ${config.STORAGE_ACCESS_TOUCH_MIN_MS / 1000})
    `;
  } catch (err) {
    // 访问时间只是分层启发信息，回写失败不影响读取
    logger.warn({ err, mediaId }, 'last_accessed_at 回写失败');
  }
}

// ───────────────────────── 配额变更后的即时收敛 ─────────────────────────

/**
 * 配额/策略变更后的即时收敛：投递一个家庭级 storage_tier 任务（worker 默认 2s 内领取）。
 * 配额修改本身已在独立事务提交，对上传拦截立刻生效；这里的降冷只负责把存量热文件搬走。
 * 自动任务只执行规划器给出的动作：demote（降冷）与 purge（仅针对回收站超期行，删除策略
 * 本就是管理员配置的保留策略）；活跃数据永远不会被自动删除。
 * 返回即时预演投影，供调用方展示「预计会发生什么」；真实结果看任务与审计日志。
 */
export async function reconcileAfterQuotaChange(
  familyId: string,
  actorId: string,
  _meta: ActorMeta = {},
): Promise<{ jobId: string | null; preview: { actions: number; demote: number; purge: number; unresolved: number } }> {
  const preview = await previewFamily({ familyId });
  const jobId = await enqueueStorageTier(familyId, 'quota_change');
  return {
    jobId,
    preview: {
      actions: preview.actions.length,
      demote: preview.summary.demote,
      purge: preview.summary.purge,
      unresolved: preview.unresolvedViolations.length,
    },
  };
}

/**
 * 入队一个分层任务并去重：同一家庭已有 queued/running 的 storage_tier 时不重复入队。
 * familyId=null 表示全量任务（每日任务），按「payload 不含 familyId」判重。
 * 用 INSERT … SELECT … WHERE NOT EXISTS 保证并发入队也不会插出两条。
 */
export async function enqueueStorageTier(familyId: string | null, trigger: string): Promise<string | null> {
  const id = `tier-${familyId ?? 'all'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = JSON.stringify({ familyId, trigger });
  const rows = await prisma.$executeRaw`
    INSERT INTO jobs (id, family_id, type, payload, status, attempts, max_attempts, progress, run_after, created_at, updated_at)
    SELECT ${id},
           ${familyId}::text,
           'storage_tier'::"JobType",
           ${payload}::jsonb,
           'queued', 0, 1, 0, now(), now(), now()
    WHERE NOT EXISTS (
      SELECT 1 FROM jobs
      WHERE type = 'storage_tier'
        AND status IN ('queued', 'running')
        AND (
          (${familyId}::text IS NULL AND payload->>'familyId' IS NULL)
          OR payload->>'familyId' = ${familyId}::text
        )
    )
  `;
  return rows === 1 ? id : null;
}

export async function listPlans(familyId: string, limit = 20) {
  return prisma.storagePlan.findMany({
    where: { familyId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, Math.max(1, limit)),
  });
}

export async function getPlan(familyId: string, planId: string) {
  const plan = await prisma.storagePlan.findFirst({ where: { id: planId, familyId } });
  if (!plan) throw badRequest('预演单不存在');
  return plan;
}

/** 作废一张未执行的预演单（open/failed → expired）。已应用的单子不能作废。 */
export async function discardPlan(familyId: string, planId: string, actorId: string, meta: ActorMeta) {
  return prisma.$transaction(async (tx) => {
    const plan = await tx.storagePlan.findFirst({ where: { id: planId, familyId } });
    if (!plan) throw badRequest('预演单不存在');
    if (plan.status === 'applied') throw conflict('已执行的预演单不能作废');
    if (plan.status === 'expired') return plan;
    const updated = await tx.storagePlan.update({
      where: { id: planId },
      data: { status: 'expired', appliedBy: null },
    });
    await audit.record(
      {
        familyId,
        actorId,
        action: 'storage.plan_discard',
        targetType: 'storage_plan',
        targetId: planId,
        diff: { previousStatus: plan.status } as unknown as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return updated;
  });
}

export function isColdObjectKey(key: string): boolean {
  return isColdKey(key);
}
