import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { badRequest } from '../http/errors';
import * as audit from './auditService';
import type { ActorMeta } from './mediaService';
import {
  getQuota,
  getUsage,
  savePolicies,
  type PolicyInput,
  type QuotaView,
  type UsageBreakdown,
} from './storagePolicyService';
import type { FamilyContext } from './permissionService';

const GB = 1024 ** 3;

export interface StorageOverview {
  quota: {
    quotaBytes: number | null;
    warnRatio: number;
    isDefault: boolean;
  };
  usage: {
    logicalBytes: number;
    physicalBytes: number;
    mediaCount: number;
    trashBytes: number;
    trashCount: number;
    bytesByKind: Record<string, number>;
    countByKind: Record<string, number>;
    bytesByTier: Record<string, number>;
    countByTier: Record<string, number>;
  };
  /** over=true 表示当前已超限（配额改小的即时后果）；warning=true 表示接近上限 */
  state: 'ok' | 'warning' | 'over';
}

function stateOf(usage: UsageBreakdown, quota: QuotaView): StorageOverview['state'] {
  if (quota.quotaBytes === null) return 'ok';
  if (usage.physicalBytes > quota.quotaBytes) return 'over';
  if (usage.physicalBytes >= (quota.quotaBytes * BigInt(Math.round(quota.warnRatio * 1000))) / 1000n) return 'warning';
  return 'ok';
}

export async function getOverview(familyId: string): Promise<StorageOverview> {
  const [quota, usage] = await Promise.all([getQuota(familyId), getUsage(familyId)]);
  return {
    quota: { quotaBytes: quota.quotaBytes === null ? null : Number(quota.quotaBytes), warnRatio: quota.warnRatio, isDefault: quota.isDefault },
    usage: {
      logicalBytes: Number(usage.logicalBytes),
      physicalBytes: Number(usage.physicalBytes),
      mediaCount: usage.mediaCount,
      trashBytes: Number(usage.trashBytes),
      trashCount: usage.trashCount,
      bytesByKind: Object.fromEntries(Object.entries(usage.bytesByKind).map(([k, v]) => [k, Number(v)])),
      countByKind: usage.countByKind,
      bytesByTier: Object.fromEntries(Object.entries(usage.bytesByTier).map(([k, v]) => [k, Number(v)])),
      countByTier: usage.countByTier,
    },
    state: stateOf(usage, quota),
  };
}

/**
 * 修改配额。即时生效：下一次上传立即按新值判定（配额在每次上传事务内现读现算，无缓存）。
 * 把配额调小到当前用量以下不会删除任何东西，但会立刻阻止新上传，状态显示为「已超限」。
 */
export async function updateQuota(
  ctx: FamilyContext,
  actorId: string,
  input: { quotaGb: number | null; warnRatio?: number },
  meta: ActorMeta,
): Promise<StorageOverview> {
  const quotaBytes = input.quotaGb === null || input.quotaGb === 0 ? null : BigInt(Math.round(input.quotaGb * GB));
  const before = await getQuota(ctx.familyId);

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.storageQuota.upsert({
      where: { familyId: ctx.familyId },
      create: {
        familyId: ctx.familyId,
        quotaBytes,
        warnRatio: input.warnRatio ?? 0.9,
        updatedBy: actorId,
      },
      update: {
        quotaBytes,
        warnRatio: input.warnRatio,
        updatedBy: actorId,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'storage.quota_update',
        targetType: 'family',
        targetId: ctx.familyId,
        diff: {
          before: before.quotaBytes === null ? null : Number(before.quotaBytes),
          after: quotaBytes === null ? null : Number(quotaBytes),
          warnRatio: input.warnRatio,
        },
        ...meta,
      },
      tx,
    );
  });

  return getOverview(ctx.familyId);
}

export async function updatePoliciesWithAudit(
  ctx: FamilyContext,
  actorId: string,
  inputs: PolicyInput[],
  meta: ActorMeta,
) {
  // 先做跨字段校验，避免半写入
  for (const p of inputs) {
    if (p.hotDays !== null && p.maxAgeDays !== null && p.maxAgeDays <= p.hotDays) {
      throw badRequest('总保留天数必须大于热层保留天数（否则不会先降冷而是直接删除）');
    }
  }
  const before = await prisma.storagePolicy.findMany({ where: { familyId: ctx.familyId } });

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await savePolicies(ctx.familyId, actorId, inputs, tx);
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'storage.policy_update',
        targetType: 'family',
        targetId: ctx.familyId,
        diff: {
          before: before.map((b) => ({
            kind: b.kind,
            hotDays: b.hotDays,
            maxAgeDays: b.maxAgeDays,
            onlyArchived: b.onlyArchived,
            enabled: b.enabled,
          })),
          after: inputs,
        } as unknown as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });
}
