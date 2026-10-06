import { describe, expect, it } from 'vitest';
import type { MediaKind, MediaTier } from '@prisma/client';
import {
  buildPlan,
  computeUsage,
  defaultPolicies,
  type KindPolicy,
  type MediaSnapshot,
  type Quota,
} from './planner';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-06T00:00:00Z');

let seq = 0;
function media(over: Partial<MediaSnapshot> & Pick<MediaSnapshot, 'kind' | 'byteSize'>): MediaSnapshot {
  seq += 1;
  const id = `m${seq}`;
  return {
    id,
    itemId: over.itemId ?? `item-${id}`,
    tier: over.tier ?? 'hot',
    protected: over.protected ?? false,
    deletedAt: over.deletedAt ?? null,
    lastAccessedAt: over.lastAccessedAt ?? NOW - DAY,
    createdAt: over.createdAt ?? NOW - 400 * DAY,
    storageKey: over.storageKey ?? `key-${id}`,
    thumbKey: over.thumbKey ?? null,
    largeKey: over.largeKey ?? null,
    transcodeKey: over.transcodeKey ?? null,
    waveformKey: over.waveformKey ?? null,
    ...over,
  };
}

function policies(over: Partial<Record<MediaKind, Partial<KindPolicy>>> = {}): KindPolicy[] {
  return defaultPolicies().map((p) => ({ ...p, ...(over[p.kind] ?? {}) }));
}

const unlimited: Quota = { hotBytesLimit: null, totalBytesLimit: null };

describe('computeUsage', () => {
  it('只统计未删除行，冷热分开计数', () => {
    const usage = computeUsage([
      media({ kind: 'image', byteSize: 100, tier: 'hot' }),
      media({ kind: 'audio', byteSize: 200, tier: 'cold' }),
      media({ kind: 'document', byteSize: 50, tier: 'hot', deletedAt: NOW - DAY }),
    ]);
    expect(usage.hotBytes).toBe(100);
    expect(usage.coldBytes).toBe(200);
    expect(usage.totalBytes).toBe(300);
    expect(usage.hotFiles).toBe(1);
    expect(usage.byKind.image.bytes).toBe(100);
  });
});

describe('保留策略', () => {
  it('软删超过保留期 → purge + unlink', () => {
    const m = media({ kind: 'image', byteSize: 100, deletedAt: NOW - 31 * DAY, storageKey: 'k1' });
    const plan = buildPlan({ media: [m], policies: policies(), quota: unlimited, now: NOW });
    expect(plan.actions.map((a) => a.type).sort()).toEqual(['purge', 'unlink']);
    expect(plan.summary.purge).toBe(1);
    const unlink = plan.actions.find((a) => a.type === 'unlink')!;
    expect(unlink.keys).toContain('k1');
  });

  it('软删但仍在保留期内 → 不动', () => {
    const m = media({ kind: 'image', byteSize: 100, deletedAt: NOW - 10 * DAY });
    const plan = buildPlan({ media: [m], policies: policies(), quota: unlimited, now: NOW });
    expect(plan.actions).toHaveLength(0);
  });

  it('coldRetentionDays=null 的类型永不删除（默认文档策略）', () => {
    const m = media({ kind: 'document', byteSize: 100, deletedAt: NOW - 9999 * DAY });
    const plan = buildPlan({ media: [m], policies: policies(), quota: unlimited, now: NOW });
    expect(plan.actions.filter((a) => a.type === 'purge')).toHaveLength(0);
  });

  it('媒体自带 protected 标记时即使策略允许也不删', () => {
    const m = media({
      kind: 'image',
      byteSize: 100,
      protected: true,
      deletedAt: NOW - 365 * DAY,
    });
    const plan = buildPlan({ media: [m], policies: policies(), quota: unlimited, now: NOW });
    expect(plan.actions).toHaveLength(0);
  });

  it('共享物理文件：还有存活行引用时只 purge 行、不 unlink 物理文件', () => {
    const shared = 'sha-abc';
    const dead = media({ kind: 'image', byteSize: 100, storageKey: shared, deletedAt: NOW - 31 * DAY });
    const alive = media({ kind: 'image', byteSize: 100, storageKey: shared });
    const plan = buildPlan({ media: [dead, alive], policies: policies(), quota: unlimited, now: NOW });
    expect(plan.actions.filter((a) => a.type === 'purge')).toHaveLength(1);
    const unlink = plan.actions.find((a) => a.type === 'unlink');
    expect(unlink).toBeUndefined();
  });

  it('两个软删行共享同一 key 且同时到期：purge 两行，unlink 只出现一次', () => {
    const shared = 'sha-shared';
    const a = media({ kind: 'image', byteSize: 100, storageKey: shared, deletedAt: NOW - 31 * DAY });
    const b = media({ kind: 'image', byteSize: 100, storageKey: shared, deletedAt: NOW - 32 * DAY });
    const plan = buildPlan({ media: [a, b], policies: policies(), quota: unlimited, now: NOW });
    expect(plan.actions.filter((x) => x.type === 'purge')).toHaveLength(2);
    expect(plan.actions.filter((x) => x.type === 'unlink')).toHaveLength(1);
  });

  it('purge 同时回收无引用的缩略图/转码派生 key', () => {
    const m = media({
      kind: 'audio',
      byteSize: 1000,
      storageKey: 'raw',
      thumbKey: null,
      transcodeKey: 'mp3',
      waveformKey: 'wave',
      deletedAt: NOW - 31 * DAY,
    });
    const plan = buildPlan({ media: [m], policies: policies(), quota: unlimited, now: NOW });
    const unlink = plan.actions.find((a) => a.type === 'unlink')!;
    expect(unlink.keys?.sort()).toEqual(['mp3', 'raw', 'wave']);
  });
});

describe('冷热分层', () => {
  it('热图片闲置超过 90 天 → demote', () => {
    const m = media({ kind: 'image', byteSize: 100, lastAccessedAt: NOW - 91 * DAY });
    const plan = buildPlan({ media: [m], policies: policies(), quota: unlimited, now: NOW });
    const demote = plan.actions.find((a) => a.type === 'demote');
    expect(demote).toBeDefined();
    expect(demote!.reason).toBe('idle_demote');
    expect(plan.projected.hotBytes).toBe(0);
    expect(plan.projected.coldBytes).toBe(100);
    expect(plan.projected.totalBytes).toBe(100);
  });

  it('闲置未超阈值 → 不降级', () => {
    const m = media({ kind: 'image', byteSize: 100, lastAccessedAt: NOW - 30 * DAY });
    const plan = buildPlan({ media: [m], policies: policies(), quota: unlimited, now: NOW });
    expect(plan.actions).toHaveLength(0);
  });

  it('hotMaxIdleDays=null（默认文档）→ 永不自动降级', () => {
    const m = media({ kind: 'document', byteSize: 100, lastAccessedAt: NOW - 9999 * DAY });
    const plan = buildPlan({ media: [m], policies: policies(), quota: unlimited, now: NOW });
    expect(plan.actions).toHaveLength(0);
  });

  it('受保护媒体不降级', () => {
    const m = media({ kind: 'image', byteSize: 100, protected: true, lastAccessedAt: NOW - 400 * DAY });
    const plan = buildPlan({ media: [m], policies: policies(), quota: unlimited, now: NOW });
    expect(plan.actions).toHaveLength(0);
  });

  it('共享物理文件：只要有一个共享行仍在闲置窗口内，整个文件不搬', () => {
    const key = 'sha-shared-hot';
    const old = media({ kind: 'image', byteSize: 100, storageKey: key, lastAccessedAt: NOW - 200 * DAY });
    const fresh = media({ kind: 'image', byteSize: 100, storageKey: key, lastAccessedAt: NOW - 10 * DAY });
    const plan = buildPlan({ media: [old, fresh], policies: policies(), quota: unlimited, now: NOW });
    expect(plan.actions.filter((a) => a.type === 'demote')).toHaveLength(0);
  });

  it('共享物理文件：全部热行都满足条件时，一个动作翻转全部行', () => {
    const key = 'sha-shared-idle';
    const a = media({ kind: 'image', byteSize: 100, storageKey: key, lastAccessedAt: NOW - 100 * DAY });
    const b = media({ kind: 'image', byteSize: 100, storageKey: key, lastAccessedAt: NOW - 120 * DAY });
    const plan = buildPlan({ media: [a, b], policies: policies(), quota: unlimited, now: NOW });
    const demotes = plan.actions.filter((x) => x.type === 'demote');
    expect(demotes).toHaveLength(1);
    expect(demotes[0]!.sharedMediaIds?.sort()).toEqual([a.id, b.id].sort());
    expect(demotes[0]!.bytes).toBe(200);
    expect(plan.projected.hotFiles).toBe(0);
    expect(plan.projected.coldFiles).toBe(2);
  });
});

describe('配额驱动', () => {
  it('热层配额超标时，即使未到闲置阈值也降级最久未用的热文件，直到达标', () => {
    const a = media({ kind: 'image', byteSize: 600, lastAccessedAt: NOW - 80 *DAY }); // 未到90天
    const b = media({ kind: 'image', byteSize: 400, lastAccessedAt: NOW - 10 * DAY });
    const quota: Quota = { hotBytesLimit: 500, totalBytesLimit: null };
    const plan = buildPlan({ media: [a, b], policies: policies(), quota, now: NOW });
    const evictions = plan.actions.filter((x) => x.reason === 'quota_hot_evict');
    expect(evictions).toHaveLength(1);
    expect(evictions[0]!.storageKey).toBe(a.storageKey);
    expect(plan.projected.hotBytes).toBe(400);
    expect(plan.quota.hotExceeded).toBe(true);
    expect(plan.unresolvedViolations).toHaveLength(0);
  });

  it('配额降级也不能动受保护文件；无法达标时上报未解决缺口', () => {
    const protectedDoc = media({
      kind: 'document',
      byteSize: 900,
      protected: true,
      lastAccessedAt: NOW - 9999 * DAY,
    });
    const img = media({ kind: 'image', byteSize: 100, lastAccessedAt: NOW - 200 * DAY });
    const quota: Quota = { hotBytesLimit: 500, totalBytesLimit: null };
    const plan = buildPlan({ media: [protectedDoc, img], policies: policies(), quota, now: NOW });
    const demotes = plan.actions.filter((a) => a.type === 'demote');
    // 图片先走策略降级；文档受保护绝不被配额搬走
    expect(demotes.every((d) => d.storageKey !== protectedDoc.storageKey)).toBe(true);
    const unresolved = plan.unresolvedViolations.find((v) => v.code === 'hot_quota_unresolved');
    expect(unresolved?.shortfallBytes).toBe(400);
  });

  it('总配额超标只报告，绝不自动删除活跃数据', () => {
    const m = media({ kind: 'image', byteSize: 1000, lastAccessedAt: NOW });
    const quota: Quota = { hotBytesLimit: null, totalBytesLimit: 500 };
    const plan = buildPlan({ media: [m], policies: policies(), quota, now: NOW });
    expect(plan.actions).toHaveLength(0);
    expect(plan.unresolvedViolations[0]!.code).toBe('total_quota_unresolved');
  });
});

describe('影响面与汇总', () => {
  it('汇总受影响条目数、降级与回收字节', () => {
    const a = media({ kind: 'image', byteSize: 300, itemId: 'i1', lastAccessedAt: NOW - 100 * DAY });
    const b = media({
      kind: 'audio',
      byteSize: 700,
      itemId: 'i2',
      deletedAt: NOW - 31 * DAY,
      storageKey: 'dead',
    });
    const plan = buildPlan({ media: [a, b], policies: policies(), quota: unlimited, now: NOW });
    expect(plan.summary.demote).toBe(1);
    expect(plan.summary.demoteBytes).toBe(300);
    expect(plan.summary.purge).toBe(1);
    expect(plan.summary.purgeReclaimBytes).toBe(700);
    expect(plan.summary.affectedItems).toBe(2);
  });

  it('maxActions 限制单次规划动作数量', () => {
    const rows = Array.from({ length: 10 }, () =>
      media({ kind: 'image', byteSize: 100, lastAccessedAt: NOW - 200 * DAY }),
    );
    const plan = buildPlan({ media: rows, policies: policies(), quota: unlimited, now: NOW, maxActions: 3 });
    expect(plan.actions).toHaveLength(3);
  });
});
