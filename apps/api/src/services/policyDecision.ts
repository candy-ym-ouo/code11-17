import type { CleanupAction, MediaKind, StorageTier } from '@heirloom/shared';
import type { ItemStatus } from '@prisma/client';

export interface DecisionPolicy {
  kind: MediaKind;
  enabled: boolean;
  hotDays: number | null;
  maxAgeDays: number | null;
  onlyArchived: boolean;
}

export interface DecisionRef {
  itemStatus: ItemStatus;
  tier: StorageTier;
  createdAt: Date;
}

export interface DecisionResult {
  action: CleanupAction;
  reason: string;
}

export const DAY_MS = 86_400_000;

function kindLabel(kind: MediaKind): string {
  return kind === 'image' ? '图片' : kind === 'audio' ? '录音' : '文档';
}

/**
 * 对一个内容对象（可能被多个条目引用）判定清理动作。纯函数，便于在不连数据库时穷举边界。
 *
 * 规则（保守优先）：
 *  - 策略停用 / 不在评估类型内 → 不动
 *  - onlyArchived 时，只要有一个引用所在条目未归档，整组不动
 *  - 年龄按「最新一次上传引用」计算：近期还被重新引用就继续留热层
 *  - 超过总保留期 → delete；否则超过热层天数且整组还在热层 → tier；否则不动
 *  - tierOnly（每日自动降冷）永不产生 delete
 */
export function decideForKey(
  policy: DecisionPolicy,
  refs: DecisionRef[],
  now: Date,
  opts: { tierOnly?: boolean } = {},
): DecisionResult | null {
  if (!policy.enabled || refs.length === 0) return null;

  const archivedGateOk = !policy.onlyArchived || refs.every((r) => r.itemStatus === 'archived');
  if (!archivedGateOk) return null;

  const youngest = refs.reduce(
    (max, r) => (r.createdAt.getTime() > max.getTime() ? r.createdAt : max),
    refs[0]!.createdAt,
  );
  const ageDays = (now.getTime() - youngest.getTime()) / DAY_MS;
  const allCold = refs.every((r) => r.tier === 'cold');

  if (!opts.tierOnly && policy.maxAgeDays !== null && ageDays >= policy.maxAgeDays) {
    return {
      action: 'delete',
      reason: `${kindLabel(policy.kind)}超过保留期 ${policy.maxAgeDays} 天（最年轻的引用也已 ${Math.floor(ageDays)} 天）`,
    };
  }
  if (!allCold && policy.hotDays !== null && ageDays >= policy.hotDays) {
    return {
      action: 'tier',
      reason: `${kindLabel(policy.kind)}热层保留 ${policy.hotDays} 天到期（已 ${Math.floor(ageDays)} 天未更新），降到冷层`,
    };
  }
  return null;
}
