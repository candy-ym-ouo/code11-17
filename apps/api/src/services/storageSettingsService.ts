import type { MediaKind, Prisma } from '@prisma/client';
import { KIND_ORDER, defaultPolicies, type KindPolicy } from '../storage/planner';
import { config } from '../config';
import { prisma } from '../db';
import { badRequest } from '../http/errors';
import type { ActorMeta } from './familyService';
import * as audit from './auditService';

type Db = Prisma.TransactionClient;

export interface PolicyView extends KindPolicy {
  updatedAt: string;
}

export interface QuotaView {
  hotBytesLimit: number | null;
  totalBytesLimit: number | null;
  updatedAt: string | null;
  /** true 表示该家庭从未设置过配额，以下数字来自系统默认 */
  isDefault: boolean;
}

function toView(row: {
  kind: MediaKind;
  hotMaxIdleDays: number | null;
  coldRetentionDays: number | null;
  protected: boolean;
  updatedAt: Date;
}): PolicyView {
  return {
    kind: row.kind,
    hotMaxIdleDays: row.hotMaxIdleDays,
    coldRetentionDays: row.coldRetentionDays,
    protected: row.protected,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 确保某家庭三类默认策略都存在（幂等）。
 * 家庭创建时调用；任何读路径也可兜底调用，保证「无缓存即时生效」语义下数据始终齐备。
 */
export async function ensurePolicies(familyId: string, actorId: string, db: Db = prisma): Promise<void> {
  const defaults = defaultPolicies();
  const existing = await db.storagePolicy.findMany({ where: { familyId } });
  const have = new Set(existing.map((r) => r.kind));
  if (existing.length === KIND_ORDER.length) return;
  await db.storagePolicy.createMany({
    data: defaults
      .filter((p) => !have.has(p.kind))
      .map((p) => ({
        familyId,
        kind: p.kind,
        hotMaxIdleDays: p.hotMaxIdleDays,
        coldRetentionDays: p.coldRetentionDays,
        protected: p.protected,
        updatedBy: actorId,
      })),
  });
}

/** 建家庭时播种：三类策略 +（若配置了默认配额）一行配额。 */
export async function seedFamilyStorage(familyId: string, actorId: string, db: Db): Promise<void> {
  await ensurePolicies(familyId, actorId, db);
  const hotDefault = config.STORAGE_DEFAULT_HOT_QUOTA_BYTES;
  const totalDefault = config.STORAGE_DEFAULT_TOTAL_QUOTA_BYTES;
  if (hotDefault > 0 || totalDefault > 0) {
    await db.storageQuota.upsert({
      where: { familyId },
      create: {
        familyId,
        hotBytesLimit: hotDefault > 0 ? BigInt(hotDefault) : null,
        totalBytesLimit: totalDefault > 0 ? BigInt(totalDefault) : null,
        updatedBy: actorId,
      },
      update: {}, // 已存在时不覆盖管理员配置
    });
  }
}

export async function listPolicies(familyId: string): Promise<PolicyView[]> {
  // 读路径不写库；若尚未播种（老库迁移后第一次访问），用系统默认补齐视图，下一次写时落库。
  const rows = await prisma.storagePolicy.findMany({ where: { familyId } });
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return defaultPolicies().map((p) => {
    const row = byKind.get(p.kind);
    return row
      ? toView(row)
      : { ...p, updatedAt: new Date(0).toISOString() };
  });
}

function assertDays(v: number | null | undefined, field: string): void {
  if (v === null || v === undefined) return;
  if (!Number.isInteger(v) || v < 1 || v > 36_500) {
    throw badRequest(`${field} 必须是 1–36500 之间的整数，或显式传 null 表示不限制`);
  }
}

/**
 * 更新某类媒体的保留策略。保存即在同一事务里写审计，且所有读路径直接查库，
 * 因此下一次规划/上传立刻按新策略执行——不需要重启、不经过缓存。
 */
export async function updatePolicy(
  actorId: string,
  familyId: string,
  kind: MediaKind,
  patch: { hotMaxIdleDays?: number | null; coldRetentionDays?: number | null; protected?: boolean },
  meta: ActorMeta,
): Promise<PolicyView> {
  assertDays(patch.hotMaxIdleDays, 'hotMaxIdleDays');
  assertDays(patch.coldRetentionDays, 'coldRetentionDays');

  return prisma.$transaction(async (tx) => {
    await ensurePolicies(familyId, actorId, tx);
    const before = await tx.storagePolicy.findUniqueOrThrow({ where: { familyId_kind: { familyId, kind } } });
    const updated = await tx.storagePolicy.update({
      where: { familyId_kind: { familyId, kind } },
      data: {
        hotMaxIdleDays: patch.hotMaxIdleDays === undefined ? undefined : patch.hotMaxIdleDays,
        coldRetentionDays: patch.coldRetentionDays === undefined ? undefined : patch.coldRetentionDays,
        protected: patch.protected === undefined ? undefined : patch.protected,
        updatedBy: actorId,
      },
    });
    await audit.record(
      {
        familyId,
        actorId,
        action: 'storage.policy_update',
        targetType: 'storage_policy',
        targetId: kind,
        diff: audit.diffOf(
          {
            hotMaxIdleDays: before.hotMaxIdleDays,
            coldRetentionDays: before.coldRetentionDays,
            protected: before.protected,
          },
          {
            hotMaxIdleDays: updated.hotMaxIdleDays,
            coldRetentionDays: updated.coldRetentionDays,
            protected: updated.protected,
          },
        ),
        ...meta,
      },
      tx,
    );
    return toView(updated);
  });
}

export async function getQuota(familyId: string): Promise<QuotaView> {
  const row = await prisma.storageQuota.findUnique({ where: { familyId } });
  if (!row) {
    return {
      hotBytesLimit: config.STORAGE_DEFAULT_HOT_QUOTA_BYTES || null,
      totalBytesLimit: config.STORAGE_DEFAULT_TOTAL_QUOTA_BYTES || null,
      updatedAt: null,
      isDefault: true,
    };
  }
  return {
    hotBytesLimit: row.hotBytesLimit === null ? null : Number(row.hotBytesLimit),
    totalBytesLimit: row.totalBytesLimit === null ? null : Number(row.totalBytesLimit),
    updatedAt: row.updatedAt.toISOString(),
    isDefault: false,
  };
}

/** 内部使用：取原始配额（含 null），供规划器。 */
export async function getQuotaLimits(familyId: string, db: Db = prisma) {
  const row = await db.storageQuota.findUnique({ where: { familyId } });
  return {
    hotBytesLimit:
      row?.hotBytesLimit != null
        ? Number(row.hotBytesLimit)
        : config.STORAGE_DEFAULT_HOT_QUOTA_BYTES || null,
    totalBytesLimit:
      row?.totalBytesLimit != null
        ? Number(row.totalBytesLimit)
        : config.STORAGE_DEFAULT_TOTAL_QUOTA_BYTES || null,
  };
}

export interface QuotaPatch {
  hotBytesLimit?: number | null;
  totalBytesLimit?: number | null;
  reason?: string | null;
}

/**
 * 更新配额（PATCH 语义：省略的字段保持不变；显式 null 取消限制）。
 * 行锁 + 事务内合并，杜绝两个管理员并发改配额时的「丢失更新」；
 * 返回值带 before/after，由调用方决定是否立即执行分层收敛。
 */
export async function updateQuota(
  actorId: string,
  familyId: string,
  patch: QuotaPatch,
  meta: ActorMeta,
): Promise<{ before: QuotaView; after: QuotaView }> {
  return prisma.$transaction(async (tx) => {
    // SELECT … FOR UPDATE：并发的两次配额修改串行化，后到者在锁内读到的是前一次的结果
    const existing = await tx.$queryRaw<{ family_id: string; hot_bytes_limit: bigint | null; total_bytes_limit: bigint | null }[]>`
      SELECT family_id, hot_bytes_limit, total_bytes_limit
      FROM storage_quotas
      WHERE family_id = ${familyId}
      FOR UPDATE
    `;
    const cur = existing[0];
    const num = (v: bigint | null | undefined) => (v == null ? null : Number(v));
    const fallbackHot = config.STORAGE_DEFAULT_HOT_QUOTA_BYTES || null;
    const fallbackTotal = config.STORAGE_DEFAULT_TOTAL_QUOTA_BYTES || null;
    const beforeView: QuotaView = cur
      ? { hotBytesLimit: num(cur.hot_bytes_limit), totalBytesLimit: num(cur.total_bytes_limit), updatedAt: null, isDefault: false }
      : { hotBytesLimit: fallbackHot, totalBytesLimit: fallbackTotal, updatedAt: null, isDefault: true };

    const nextHot = patch.hotBytesLimit === undefined ? beforeView.hotBytesLimit : patch.hotBytesLimit;
    const nextTotal =
      patch.totalBytesLimit === undefined ? beforeView.totalBytesLimit : patch.totalBytesLimit;

    if (nextHot !== null && nextTotal !== null && nextHot > nextTotal) {
      throw badRequest('热层配额不能大于总配额（热层是总容量的子集）');
    }

    await tx.storageQuota.upsert({
      where: { familyId },
      create: {
        familyId,
        hotBytesLimit: nextHot === null ? null : BigInt(nextHot),
        totalBytesLimit: nextTotal === null ? null : BigInt(nextTotal),
        updatedBy: actorId,
      },
      update: {
        hotBytesLimit: nextHot === null ? null : BigInt(nextHot),
        totalBytesLimit: nextTotal === null ? null : BigInt(nextTotal),
        updatedBy: actorId,
      },
    });

    await audit.record(
      {
        familyId,
        actorId,
        action: 'storage.quota_update',
        targetType: 'storage_quota',
        targetId: familyId,
        diff: audit.diffOf(
          { hotBytesLimit: beforeView.hotBytesLimit, totalBytesLimit: beforeView.totalBytesLimit },
          { hotBytesLimit: nextHot, totalBytesLimit: nextTotal, reason: patch.reason ?? null },
        ),
        ...meta,
      },
      tx,
    );

    const afterView: QuotaView = {
      hotBytesLimit: nextHot,
      totalBytesLimit: nextTotal,
      updatedAt: new Date().toISOString(),
      isDefault: false,
    };
    return { before: beforeView, after: afterView };
  });
}
