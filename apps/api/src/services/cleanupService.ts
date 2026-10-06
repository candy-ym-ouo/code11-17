import type { CleanupAction, MediaKind } from '@heirloom/shared';
import type { Item, ItemMedia, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { AppError } from '../http/errors';
import { logger } from '../logger';
import { exists, moveBetweenTiers, remove } from '../storage/local';
import * as audit from './auditService';
import type { ActorMeta } from './mediaService';
import { getEffectivePolicies } from './storagePolicyService';
import { decideForKey, DAY_MS } from './policyDecision';

type Db = Prisma.TransactionClient | typeof prisma;

interface CandidateRow extends ItemMedia {
  item: Pick<Item, 'id' | 'status' | 'title'>;
}

export interface PreviewOptions {
  kinds?: MediaKind[];
  note?: string | null;
  /** 自动降冷：只产生 tier 动作（永不删除），无需人工确认 */
  tierOnly?: boolean;
}

export interface PlannedKey {
  storageKey: string;
  kind: MediaKind;
  action: CleanupAction;
  bytes: bigint;
  reason: string;
  media: CandidateRow[];
}

/**
 * 计算清理计划。决策以「内容对象（storageKey）」为单位：
 * 同一份去重文件可能挂在多个条目上，必须整组同进同退，否则会出现「记录说在热层、文件已在冷层」。
 */
export async function buildPlan(familyId: string, opts: PreviewOptions, now = new Date()): Promise<PlannedKey[]> {
  const policies = await getEffectivePolicies(familyId);
  const enabledKinds = new Set(
    policies.filter((p) => p.enabled).map((p) => p.kind),
  );
  const kinds = opts.kinds ?? ['image', 'audio', 'document'];
  const policyByKind = new Map(policies.map((p) => [p.kind, p]));

  const rows = (await prisma.itemMedia.findMany({
    where: {
      deletedAt: null,
      kind: { in: kinds },
      item: { familyId, deletedAt: null, status: { not: 'trashed' } },
    },
    include: { item: { select: { id: true, status: true, title: true } } },
    orderBy: { createdAt: 'asc' },
  })) as CandidateRow[];

  // 按 storageKey 分组（同家庭内容寻址去重的不同引用）
  const groups = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    if (!enabledKinds.has(row.kind)) continue;
    const list = groups.get(row.storageKey) ?? [];
    list.push(row);
    groups.set(row.storageKey, list);
  }

  const planned: PlannedKey[] = [];

  for (const [storageKey, refs] of groups) {
    const kind = refs[0]!.kind;
    const policy = policyByKind.get(kind)!;
    const decision = decideForKey(
      {
        kind: policy.kind,
        enabled: true, // 已按 enabledKinds 过滤
        hotDays: policy.hotDays,
        maxAgeDays: policy.maxAgeDays,
        onlyArchived: policy.onlyArchived,
      },
      refs.map((r) => ({ itemStatus: r.item.status, tier: r.tier, createdAt: r.createdAt })),
      now,
      { tierOnly: opts.tierOnly },
    );
    if (!decision) continue;
    planned.push({
      storageKey,
      kind,
      action: decision.action,
      bytes: refs[0]!.byteSize,
      reason: decision.reason,
      media: refs,
    });
  }

  // 先删后降：同一对象不会同时落入两类；按释放空间从大到小排，方便人工预读
  planned.sort((a, b) => (a.action === b.action ? (a.bytes < b.bytes ? 1 : -1) : a.action === 'delete' ? -1 : 1));
  return planned;
}

interface CreateRunOptions extends PreviewOptions {
  actorId: string;
  familyId: string;
}

/** 预演：把影响面落库为 CleanupRun（状态 preview=待确认），确认时严格照此执行。 */
export async function createPreviewRun({ actorId, familyId, ...opts }: CreateRunOptions, meta: ActorMeta) {
  const now = new Date();
  const plan = await buildPlan(familyId, opts, now);
  const policies = await getEffectivePolicies(familyId);

  const tier = plan.filter((p) => p.action === 'tier');
  const del = plan.filter((p) => p.action === 'delete');
  const sum = (list: PlannedKey[]) => list.reduce((acc, p) => acc + p.bytes, 0n);
  const countRefs = (list: PlannedKey[]) => list.reduce((acc, p) => acc + p.media.length, 0);

  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.cleanupRun.create({
      data: {
        familyId,
        status: 'preview',
        policySnapshot: {
          tierOnly: Boolean(opts.tierOnly),
          kinds: opts.kinds ?? ['image', 'audio', 'document'],
          policies: policies.map((p) => ({
            kind: p.kind,
            enabled: p.enabled,
            hotDays: p.hotDays,
            maxAgeDays: p.maxAgeDays,
            onlyArchived: p.onlyArchived,
            isDefault: p.isDefault,
          })),
        } as Prisma.InputJsonValue,
        cutoffAt: now,
        note: opts.note ?? null,
        totalFiles: countRefs(plan),
        totalBytes: sum(plan),
        tierFiles: countRefs(tier),
        tierBytes: sum(tier),
        deleteFiles: countRefs(del),
        deleteBytes: sum(del),
        createdBy: actorId,
        expiresAt: new Date(now.getTime() + config.CLEANUP_PREVIEW_TTL_HOURS * 3600 * 1000),
      },
    });
    if (plan.length) {
      await tx.cleanupItem.createMany({
        data: plan.flatMap((p) =>
          p.media.map((m) => ({
            runId: created.id,
            mediaId: m.id,
            itemId: m.item.id,
            kind: p.kind,
            action: p.action,
            byteSize: p.bytes,
            reason: p.reason,
          })),
        ),
      });
    }
    await audit.record(
      {
        familyId,
        actorId,
        action: 'storage.cleanup_preview',
        targetType: 'cleanup_run',
        targetId: created.id,
        diff: {
          note: opts.note ?? null,
          totalFiles: created.totalFiles,
          totalBytes: Number(created.totalBytes),
          tierFiles: created.tierFiles,
          deleteFiles: created.deleteFiles,
        } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return created;
  });

  return { run, plan };
}

/** 组装预演影响面（含受影响条目明细），供界面展示。 */
export async function getRunWithItems(runId: string, familyId: string) {
  const run = await prisma.cleanupRun.findFirst({ where: { id: runId, familyId } });
  if (!run) throw new AppError('NOT_FOUND', '清理计划不存在');
  const items = await prisma.cleanupItem.findMany({
    where: { runId },
    orderBy: [{ action: 'asc' }, { byteSize: 'desc' }],
    include: { media: { select: { originalName: true, mimeType: true, sha256: true, tier: true } } },
  });
  return { run, items };
}

export async function listRuns(familyId: string, limit = 30) {
  return prisma.cleanupRun.findMany({
    where: { familyId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, Math.max(1, limit)),
  });
}

/** 确认入口：校验计划仍有效，置为 approved 并返回（真正执行交给 worker，避免长请求超时）。 */
export async function approveRun(runId: string, familyId: string, actorId: string, meta: ActorMeta) {
  const run = await prisma.cleanupRun.findFirst({ where: { id: runId, familyId } });
  if (!run) throw new AppError('NOT_FOUND', '清理计划不存在');
  if (run.status !== 'preview') {
    throw new AppError('CONFLICT', `该计划当前状态为 ${run.status}，不能确认执行`);
  }
  if (run.expiresAt && run.expiresAt.getTime() < Date.now()) {
    await prisma.cleanupRun.update({ where: { id: runId }, data: { status: 'expired' } });
    throw new AppError('PREVIEW_EXPIRED', '预演已过期（策略可能已变化），请重新预演后再执行');
  }

  const itemCount = await prisma.cleanupItem.count({ where: { runId, state: 'pending' } });

  await prisma.$transaction(async (tx) => {
    await tx.cleanupRun.update({ where: { id: runId }, data: { status: 'approved', approvedBy: actorId } });
    await audit.record(
      {
        familyId,
        actorId,
        action: 'storage.cleanup_approve',
        targetType: 'cleanup_run',
        targetId: runId,
        diff: { files: itemCount, bytes: Number(run.totalBytes) } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    await tx.job.create({
      data: { familyId, type: 'storage_purge', payload: { runId } as Prisma.InputJsonValue },
    });
  });
  return runId;
}

export async function cancelRun(runId: string, familyId: string, actorId: string, meta: ActorMeta): Promise<void> {
  const run = await prisma.cleanupRun.findFirst({ where: { id: runId, familyId } });
  if (!run) throw new AppError('NOT_FOUND', '清理计划不存在');
  if (run.status !== 'preview') throw new AppError('CONFLICT', '只有待确认的预演可以取消');
  await prisma.$transaction(async (tx) => {
    await tx.cleanupRun.update({ where: { id: runId }, data: { status: 'canceled', canceledAt: new Date() } });
    await audit.record(
      {
        familyId,
        actorId,
        action: 'storage.cleanup_cancel',
        targetType: 'cleanup_run',
        targetId: runId,
        ...meta,
      },
      tx,
    );
  });
}

/** 还有多少活引用指向某个存储 key（在指定家庭内；key 本身按家庭隔离）。 */
async function liveRefsForKey(db: Db, familyId: string, key: string): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n
    FROM item_media im JOIN items i ON i.id = im.item_id
    WHERE i.family_id = ${familyId} AND im.deleted_at IS NULL AND im.storage_key = ${key}
  `;
  return Number(rows[0]?.n ?? 0);
}

interface ExecResult {
  done: number;
  skipped: number;
  failed: number;
  reclaimedBytes: bigint;
}

/**
 * 执行一份已批准的计划。逐条核对当前真实状态（文件可能已被更早的清理/手动删除处理过），
 * 因此「预演」与「执行」之间发生的变化都表现为 skipped，而不是报错或误删。
 */
export async function executeRun(runId: string): Promise<ExecResult> {
  const run = await prisma.cleanupRun.findUnique({ where: { id: runId } });
  if (!run) throw new AppError('NOT_FOUND', '清理计划不存在');
  if (run.status !== 'approved') throw new AppError('CONFLICT', `计划状态 ${run.status}，不可执行`);

  const items = await prisma.cleanupItem.findMany({ where: { runId }, include: { media: true } });
  const result: ExecResult = { done: 0, skipped: 0, failed: 0, reclaimedBytes: 0n };
  const details: Record<string, unknown>[] = [];

  const tierGroups = new Map<string, typeof items>();
  const deleteGroups = new Map<string, typeof items>();
  for (const ci of items) {
    const bucket = ci.action === 'tier' ? tierGroups : deleteGroups;
    const list = bucket.get(ci.media.storageKey) ?? [];
    list.push(ci);
    bucket.set(ci.media.storageKey, list);
  }

  // ---- 降冷：仅当该对象的所有活引用都在本计划内，才搬文件并整组更新 tier ----
  for (const [key, group] of tierGroups) {
    try {
      const liveCount = await liveRefsForKey(prisma, run.familyId, key);
      const pendingRows = group.filter((g) => g.state === 'pending');
      if (liveCount !== pendingRows.length) {
        for (const g of pendingRows) {
          await markItem(g.id, 'skipped', '同一文件仍被不在本次计划内的条目引用，已跳过降冷');
          result.skipped += 1;
        }
        continue;
      }
      if (!(await exists(key, 'hot'))) {
        if (await exists(key, 'cold')) {
          await prisma.itemMedia.updateMany({ where: { storageKey: key, deletedAt: null }, data: { tier: 'cold', tierChangedAt: new Date() } });
          for (const g of pendingRows) await markItem(g.id, 'done', '文件已在冷层，仅同步状态');
          result.done += pendingRows.length;
        } else {
          for (const g of pendingRows) {
            await markItem(g.id, 'skipped', '热层与冷层都找不到文件');
            result.skipped += 1;
          }
        }
        continue;
      }
      await moveBetweenTiers(key, 'hot', 'cold');
      await prisma.itemMedia.updateMany({ where: { storageKey: key, deletedAt: null }, data: { tier: 'cold', tierChangedAt: new Date() } });
      for (const g of pendingRows) await markItem(g.id, 'done', '已降到冷层');
      result.done += pendingRows.length;
      details.push({ action: 'tier', key, media: pendingRows.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : '降冷失败';
      logger.error({ err, runId, key }, '降冷失败');
      for (const g of group) {
        if (g.state === 'pending') {
          await markItem(g.id, 'failed', message);
          result.failed += 1;
        }
      }
    }
  }

  // ---- 删除：先软删全部计划内引用；没有活引用后才回收磁盘（原始件 + 派生件）----
  for (const [key, group] of deleteGroups) {
    try {
      const pendingRows = group.filter((g) => g.state === 'pending');
      const mediaIds = pendingRows.map((g) => g.mediaId);
      const liveBefore = await liveRefsForKey(prisma, run.familyId, key);
      if (liveBefore !== pendingRows.length) {
        for (const g of pendingRows) {
          await markItem(g.id, 'skipped', '同一文件仍被不在本次计划内的条目引用，只跳过物理删除');
          result.skipped += 1;
        }
        continue;
      }
      await prisma.itemMedia.updateMany({ where: { id: { in: mediaIds } }, data: { deletedAt: new Date() } });

      const remaining = await liveRefsForKey(prisma, run.familyId, key);
      let removedBytes = 0n;
      if (remaining === 0) {
        // 只回收原始件；缩略图/转码等派生件仍被刚软删的墓碑行引用（回收站保留期内可恢复说明），
        // 不在此刻删——等 trash_purge 硬删行之后，由每日 storage_gc 统一回收孤儿派生件。
        await Promise.all([remove(key, 'hot').catch(() => undefined), remove(key, 'cold').catch(() => undefined)]);
        removedBytes = pendingRows[0]?.media.byteSize ?? 0n;
        result.reclaimedBytes += removedBytes;
      }
      for (const g of pendingRows) await markItem(g.id, 'done', remaining === 0 ? '已删除并回收磁盘空间' : '引用已移除，磁盘对象仍被其他记录引用');
      result.done += pendingRows.length;
      details.push({ action: 'delete', key, media: pendingRows.length, removedBytes: Number(removedBytes) });
    } catch (err) {
      const message = err instanceof Error ? err.message : '删除失败';
      logger.error({ err, runId, key }, '清理删除失败');
      for (const g of group) {
        if (g.state === 'pending') {
          await markItem(g.id, 'failed', message);
          result.failed += 1;
        }
      }
    }
  }

  await prisma.cleanupRun.update({
    where: { id: runId },
    data: {
      status: 'done',
      executedAt: new Date(),
      result: {
        done: result.done,
        skipped: result.skipped,
        failed: result.failed,
        reclaimedBytes: Number(result.reclaimedBytes),
        details,
      } as Prisma.InputJsonValue,
    },
  });
  await audit.recordSoft({
    familyId: run.familyId,
    actorId: run.approvedBy ?? run.createdBy,
    action: 'storage.cleanup_run',
    targetType: 'cleanup_run',
    targetId: runId,
    diff: result as unknown as Prisma.InputJsonValue,
  });
  return result;
}

async function markItem(id: string, state: string, detail: string): Promise<void> {
  await prisma.cleanupItem.update({ where: { id }, data: { state, detail } });
}

/**
 * 单个冷层媒体手动/访问触发的取回热层。同一 storageKey 的整组引用一起恢复。
 * actorId 为 null 表示系统自动触发（没有真实操作人，不写审计，避免违反外键）。
 */
export async function restoreMediaToHot(
  actorId: string | null,
  familyId: string,
  mediaId: string,
  meta: ActorMeta & { automatic?: boolean },
): Promise<{ moved: boolean; bytes: number }> {
  const media = await prisma.itemMedia.findFirst({
    where: { id: mediaId, item: { familyId, deletedAt: null } },
  });
  if (!media) throw new AppError('NOT_FOUND', '媒体不存在');

  if (media.tier === 'hot' && (await exists(media.storageKey, 'hot'))) {
    return { moved: false, bytes: 0 };
  }
  if (!(await exists(media.storageKey, 'cold'))) {
    throw new AppError('CONFLICT', '冷层找不到该文件，可能已被清理或冷盘未挂载');
  }
  const size = await moveBetweenTiers(media.storageKey, 'cold', 'hot');
  await prisma.itemMedia.updateMany({
    where: { storageKey: media.storageKey, item: { familyId } },
    data: { tier: 'hot', tierChangedAt: new Date() },
  });
  if (actorId) {
    await audit.recordSoft({
      familyId,
      actorId,
      action: 'storage.restore',
      targetType: 'item_media',
      targetId: mediaId,
      diff: { automatic: Boolean(meta.automatic), bytes: size } as Prisma.InputJsonValue,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }
  return { moved: true, bytes: size };
}

/** 每日自动降冷：对所有家庭跑 tierOnly 计划并立即执行（非破坏性，删除永远需要人工确认）。 */
export async function runAutoTierSweep(): Promise<{ families: number; moved: number }> {
  const families = await prisma.family.findMany({ where: { deletedAt: null }, select: { id: true, createdBy: true } });
  let moved = 0;
  for (const family of families) {
    try {
      const { run, plan } = await createPreviewRun(
        { actorId: family.createdBy, familyId: family.id, tierOnly: true, note: '每日自动降冷（系统）' },
        {},
      );
      if (plan.length === 0) {
        await prisma.cleanupRun.update({ where: { id: run.id }, data: { status: 'canceled', canceledAt: new Date() } });
        continue;
      }
      await prisma.cleanupRun.update({ where: { id: run.id }, data: { status: 'approved', approvedBy: family.createdBy } });
      const res = await executeRun(run.id);
      moved += res.done;
    } catch (err) {
      logger.error({ err, familyId: family.id }, '自动降冷失败');
    }
  }
  return { families: families.length, moved };
}
