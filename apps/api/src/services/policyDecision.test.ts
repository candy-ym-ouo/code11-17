import { describe, expect, it } from 'vitest';
import { decideForKey, type DecisionPolicy, type DecisionRef } from './policyDecision';

const now = new Date('2026-10-06T00:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

const policy = (over: Partial<DecisionPolicy> = {}): DecisionPolicy => ({
  kind: 'image',
  enabled: true,
  hotDays: 365,
  maxAgeDays: null,
  onlyArchived: true,
  ...over,
});

const ref = (over: Partial<DecisionRef> = {}): DecisionRef => ({
  itemStatus: 'archived',
  tier: 'hot',
  createdAt: daysAgo(400),
  ...over,
});

describe('decideForKey 清理决策（安全边界）', () => {
  it('策略停用 / 无引用 → 不动', () => {
    expect(decideForKey(policy({ enabled: false }), [ref()], now)).toBeNull();
    expect(decideForKey(policy(), [], now)).toBeNull();
  });

  it('未过任何期限 → 不动', () => {
    expect(decideForKey(policy({ hotDays: 365, maxAgeDays: 9999 }), [ref({ createdAt: daysAgo(10) })], now)).toBeNull();
  });

  it('超过热层期且在热层 → 降冷', () => {
    const r = decideForKey(policy({ hotDays: 365 }), [ref()], now);
    expect(r?.action).toBe('tier');
  });

  it('已经全部在冷层 → 不重复降冷', () => {
    expect(decideForKey(policy({ hotDays: 365 }), [ref({ tier: 'cold' })], now)).toBeNull();
  });

  it('超过保留期 → 删除（优先于降冷）', () => {
    const r = decideForKey(policy({ hotDays: 100, maxAgeDays: 365 }), [ref({ createdAt: daysAgo(400) })], now);
    expect(r?.action).toBe('delete');
  });

  it('tierOnly 自动降冷即使超保留期也不删除', () => {
    const r = decideForKey(policy({ hotDays: 100, maxAgeDays: 365 }), [ref({ createdAt: daysAgo(400) })], now, {
      tierOnly: true,
    });
    expect(r?.action).toBe('tier');
  });

  it('onlyArchived：只要有一个引用所在条目未归档，整组不动（含 published/draft/trashed）', () => {
    const mixed = [ref({ itemStatus: 'archived' }), ref({ itemStatus: 'published', createdAt: daysAgo(400) })];
    expect(decideForKey(policy({ hotDays: 1 }), mixed, now)).toBeNull();
  });

  it('关闭 onlyArchived 后，未归档条目也可降冷', () => {
    const mixed = [ref({ itemStatus: 'published' })];
    expect(decideForKey(policy({ hotDays: 365, onlyArchived: false }), mixed, now)?.action).toBe('tier');
  });

  it('年龄按「最新一次引用」计算：有一条较新的引用则整组留热层（去重安全）', () => {
    const refs = [ref({ createdAt: daysAgo(400) }), ref({ createdAt: daysAgo(5) })];
    expect(decideForKey(policy({ hotDays: 365 }), refs, now)).toBeNull();
  });

  it('删除边界：年龄恰好等于保留期当天即命中（>= 语义，确定性）', () => {
    const exactly = daysAgo(365);
    expect(decideForKey(policy({ hotDays: null, maxAgeDays: 365 }), [ref({ createdAt: exactly })], now)?.action).toBe(
      'delete',
    );
  });

  it('hotDays=0：满足归档门槛即降冷', () => {
    expect(decideForKey(policy({ hotDays: 0 }), [ref({ createdAt: now })], now)?.action).toBe('tier');
  });

  it('音频/文档类型同样适用', () => {
    expect(decideForKey(policy({ kind: 'audio', hotDays: 1 }), [ref({ createdAt: daysAgo(30) })], now)?.action).toBe(
      'tier',
    );
  });
});
