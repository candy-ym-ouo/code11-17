import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../http/errors';
import { exists } from '../storage/local';
import { getQuota, type QuotaView } from './storagePolicyService';

/**
 * 家庭级事务咨询锁。同一家庭的「上传计费 / 清理释放」串行化，
 * 保证配额判定与真实占用一致，避免两个并发上传同时绕过配额。
 */
export async function lockFamilyStorage(familyId: string, db: Prisma.TransactionClient): Promise<void> {
  // hashtext 返回 integer，而 pg_advisory_xact_lock 只接收 bigint（或两个 int4），这里显式转成 bigint；
  // 事务结束时锁自动释放
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`storage:${familyId}`})::bigint)`;
}

interface ChargeInput {
  familyId: string;
  /** 新文件字节数（内容寻址去重命中时不收费） */
  bytes: number;
  storageKey: string;
  tx: Prisma.TransactionClient;
  quota?: QuotaView;
}

export interface ChargeResult {
  charged: boolean;
  usageBytes: bigint;
  quotaBytes: bigint | null;
  warning: boolean;
}

/** 活媒体引用的物理去重集合大小：按 storageKey 去重后每个对象计一份 byteSize。软删的不计（删除即释放配额）。 */
async function physicalUsage(tx: Prisma.TransactionClient, familyId: string): Promise<bigint> {
  const rows = await tx.$queryRaw<{ bytes: bigint }[]>`
    SELECT COALESCE(SUM(byte_size), 0) AS bytes
    FROM (
      SELECT storage_key, MAX(byte_size) AS byte_size
      FROM item_media im
      JOIN items i ON i.id = im.item_id
      WHERE i.family_id = ${familyId} AND im.deleted_at IS NULL
      GROUP BY storage_key
    ) dedup
  `;
  return rows[0]?.bytes ?? 0n;
}

/**
 * 上传配额判定。必须在持有家庭存储锁的事务内调用。
 * 内容寻址命中（热层或冷层已有同一对象）时不重复计费。
 */
export async function chargeUpload(input: ChargeInput): Promise<ChargeResult> {
  const { familyId, bytes, storageKey, tx } = input;
  const quota = input.quota ?? (await getQuota(familyId));

  // 任何家庭已经持有同一内容对象（热或冷），本家庭只新建引用，不占新盘
  const referencedElsewhere = await tx.itemMedia.count({
    where: { storageKey, item: { familyId } },
  });
  const alreadyOnDisk = referencedElsewhere > 0 || (await exists(storageKey, 'hot')) || (await exists(storageKey, 'cold'));
  const charged = !alreadyOnDisk;

  const current = await physicalUsage(tx, familyId);
  const projected = current + (charged ? BigInt(bytes) : 0n);

  if (quota.quotaBytes !== null && projected > quota.quotaBytes) {
    throw new AppError(
      'QUOTA_EXCEEDED',
      `家庭存储空间不足：配额 ${formatGiB(quota.quotaBytes)}，本次需要 ${formatMiB(bytes)}，` +
        `已用 ${formatGiB(current)}。请清理冷数据或联系管理员调整配额。`,
      {
        quotaBytes: Number(quota.quotaBytes),
        usedBytes: Number(current),
        needBytes: bytes,
      },
    );
  }

  return {
    charged,
    usageBytes: projected,
    quotaBytes: quota.quotaBytes,
    warning: quota.quotaBytes !== null && projected >= quota.quotaBytes * BigInt(Math.round(quota.warnRatio * 1000)) / 1000n,
  };
}

export function formatGiB(n: bigint): string {
  return `${(Number(n) / 1024 ** 3).toFixed(2)} GiB`;
}

export function formatMiB(n: number): string {
  return `${(n / 1024 ** 2).toFixed(1)} MiB`;
}
