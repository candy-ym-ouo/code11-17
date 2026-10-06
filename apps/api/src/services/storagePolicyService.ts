import type { MediaKind, StorageTier } from '@heirloom/shared';
import type { Prisma, StoragePolicy } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';

/** 系统默认的分层/保留策略（家庭未单独配置时使用，也用于首次补齐）。0 天表示立即可降冷，null 表示不做该动作。 */
export function defaultPolicyFor(kind: MediaKind): {
  hotDays: number | null;
  maxAgeDays: number | null;
  onlyArchived: boolean;
  enabled: boolean;
} {
  // 热层 0 天 = 一满足归档条件即可降冷；保留期 0 天在默认配置里视为「永不自动删」（必须显式给正数才会删）
  const hot = (n: number): number | null => n;
  const maxAge = (n: number): number | null => (n > 0 ? n : null);
  switch (kind) {
    case 'image':
      return {
        hotDays: hot(config.POLICY_IMAGE_HOT_DAYS),
        maxAgeDays: maxAge(config.POLICY_IMAGE_MAX_AGE_DAYS),
        onlyArchived: true,
        enabled: true,
      };
    case 'audio':
      return {
        hotDays: hot(config.POLICY_AUDIO_HOT_DAYS),
        maxAgeDays: maxAge(config.POLICY_AUDIO_MAX_AGE_DAYS),
        onlyArchived: true,
        enabled: true,
      };
    case 'document':
      return {
        hotDays: hot(config.POLICY_DOCUMENT_HOT_DAYS),
        maxAgeDays: maxAge(config.POLICY_DOCUMENT_MAX_AGE_DAYS),
        onlyArchived: true,
        enabled: true,
      };
  }
}

export interface EffectivePolicy extends StoragePolicy {
  /** true 表示这一行来自系统默认而不是家庭自定义 */
  isDefault: boolean;
}

/** 读取家庭对每种媒体的有效策略：有自定义用自定义，否则回退默认。 */
export async function getEffectivePolicies(familyId: string): Promise<EffectivePolicy[]> {
  const rows = await prisma.storagePolicy.findMany({ where: { familyId } });
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return (['image', 'audio', 'document'] as MediaKind[]).map((kind) => {
    const custom = byKind.get(kind);
    if (custom) return { ...custom, isDefault: false };
    const d = defaultPolicyFor(kind);
    return {
      id: `default-${kind}`,
      familyId,
      kind,
      hotDays: d.hotDays,
      maxAgeDays: d.maxAgeDays,
      onlyArchived: d.onlyArchived,
      enabled: d.enabled,
      updatedBy: 'system',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      isDefault: true,
    };
  });
}

export interface PolicyInput {
  kind: MediaKind;
  hotDays: number | null;
  maxAgeDays: number | null;
  onlyArchived: boolean;
  enabled: boolean;
}

/** 批量 upsert 家庭策略。同一事务内完成，保证一次提交整体生效。 */
export async function savePolicies(
  familyId: string,
  userId: string,
  inputs: PolicyInput[],
  db: Prisma.TransactionClient = prisma,
): Promise<void> {
  for (const input of inputs) {
    if (input.hotDays !== null && input.maxAgeDays !== null && input.maxAgeDays <= input.hotDays) {
      // 保留期必须比热层期长，否则「降冷」永远不会发生
      throw Object.assign(new Error('总保留天数必须大于热层保留天数'), { status: 400 });
    }
    await db.storagePolicy.upsert({
      where: { familyId_kind: { familyId, kind: input.kind } },
      create: {
        familyId,
        kind: input.kind,
        hotDays: input.hotDays,
        maxAgeDays: input.maxAgeDays,
        onlyArchived: input.onlyArchived,
        enabled: input.enabled,
        updatedBy: userId,
      },
      update: {
        hotDays: input.hotDays,
        maxAgeDays: input.maxAgeDays,
        onlyArchived: input.onlyArchived,
        enabled: input.enabled,
        updatedBy: userId,
      },
    });
  }
}

export function defaultQuotaBytes(): bigint | null {
  return config.DEFAULT_STORAGE_QUOTA_GB > 0
    ? BigInt(Math.round(config.DEFAULT_STORAGE_QUOTA_GB * 1024 ** 3))
    : null;
}

export interface QuotaView {
  quotaBytes: bigint | null;
  warnRatio: number;
  isDefault: boolean;
}

export async function getQuota(familyId: string): Promise<QuotaView> {
  const row = await prisma.storageQuota.findUnique({ where: { familyId } });
  if (!row) return { quotaBytes: defaultQuotaBytes(), warnRatio: 0.9, isDefault: true };
  return { quotaBytes: row.quotaBytes, warnRatio: Number(row.warnRatio), isDefault: false };
}

export type TierCounts = Record<MediaKind, number>;
export type TierBytes = Record<MediaKind, bigint>;

export interface UsageBreakdown {
  /** 活的（未软删）媒体按逻辑引用计的合计（同一文件被多处引用会重复计） */
  logicalBytes: bigint;
  /** 配额约束的量：活媒体去重（同一 storageKey 只算一份）后的字节数；删除即释放 */
  physicalBytes: bigint;
  bytesByKind: TierBytes;
  countByKind: TierCounts;
  bytesByTier: Record<StorageTier, bigint>;
  countByTier: Record<StorageTier, number>;
  /** 已软删媒体的逻辑体量（含仍被活引用的去重对象），仅供界面提示，不计入配额 */
  trashBytes: bigint;
  trashCount: number;
  mediaCount: number;
}

/**
 * 用量统计。配额只约束「活媒体去重」后的字节，因此软删/策略清理后立即释放配额；
 * 回收站里仍占盘的体量单列展示，物理回收由 trash_purge / storage_gc 兜底。
 */
export async function getUsage(familyId: string): Promise<UsageBreakdown> {
  const live = await prisma.itemMedia.findMany({
    where: { deletedAt: null, item: { familyId } },
    select: { kind: true, byteSize: true, tier: true, storageKey: true },
  });
  const trashed = await prisma.itemMedia.findMany({
    where: { deletedAt: { not: null }, item: { familyId } },
    select: { byteSize: true },
  });

  const bytesByKind = { image: 0n, audio: 0n, document: 0n } as TierBytes;
  const countByKind = { image: 0, audio: 0, document: 0 } as TierCounts;
  const bytesByTier = { hot: 0n, cold: 0n } as Record<StorageTier, bigint>;
  const countByTier = { hot: 0, cold: 0 } as Record<StorageTier, number>;
  // 每个去重对象取一份字节（同 key 同大小，按 sha256 内容寻址天然一致）
  const objectBytes = new Map<string, bigint>();

  let logicalBytes = 0n;
  for (const m of live) {
    logicalBytes += m.byteSize;
    bytesByKind[m.kind] += m.byteSize;
    countByKind[m.kind] += 1;
    bytesByTier[m.tier] += m.byteSize;
    countByTier[m.tier] += 1;
    if (!objectBytes.has(m.storageKey)) objectBytes.set(m.storageKey, m.byteSize);
  }

  let physicalBytes = 0n;
  for (const bytes of objectBytes.values()) physicalBytes += bytes;

  const trashBytes = trashed.reduce((acc, m) => acc + m.byteSize, 0n);

  return {
    logicalBytes,
    physicalBytes,
    bytesByKind,
    countByKind,
    bytesByTier,
    countByTier,
    trashBytes,
    trashCount: trashed.length,
    mediaCount: live.length,
  };
}
