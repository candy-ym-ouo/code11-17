import type { MediaKind, MediaTier } from '@prisma/client';

/** 规划器使用的媒体快照：由 service 层从数据库装配，规划器本身不碰数据库，方便单测。 */
export interface MediaSnapshot {
  id: string;
  itemId: string;
  kind: MediaKind;
  tier: MediaTier;
  byteSize: number;
  protected: boolean;
  /**
   * 逻辑删除时间（毫秒）：非空表示该媒体已不可见，来源可能是媒体行自身软删，
   * 也可能是所属条目进了回收站（由 service 层统一折算到这里）。
   */
  deletedAt: number | null;
  /** 最近一次「原始文件被读取」的时间；从未读取过时用 createdAt 兜底。 */
  lastAccessedAt: number;
  createdAt: number;
  storageKey: string;
  thumbKey: string | null;
  largeKey: string | null;
  transcodeKey: string | null;
  waveformKey: string | null;
}

/** 单个媒体类型的保留策略，由 storage_policies 表行映射而来。 */
export interface KindPolicy {
  kind: MediaKind;
  /** 热层闲置多少天后降级到冷层；null 表示该类型不自动降级。 */
  hotMaxIdleDays: number | null;
  /** 软删（回收站）后保留多少天才彻底删除；null 表示永久保留。 */
  coldRetentionDays: number | null;
  /** 受保护：永不自动降级、永不自动删除（票据/手稿等），配额超标也不动。 */
  protected: boolean;
}

export interface Quota {
  /** 热层逻辑字节上限（null=不限）。超标时规划器只会「降级」，绝不删除活跃数据。 */
  hotBytesLimit: number | null;
  /** 热+冷总逻辑字节上限（null=不限）。总配额超标只报告、不自动动作。 */
  totalBytesLimit: number | null;
}

export interface PlannerInput {
  media: MediaSnapshot[];
  policies: KindPolicy[];
  quota: Quota;
  now: number;
  /** 单次最多规划多少个动作，避免一次任务搬动过多文件。 */
  maxActions?: number;
}

export type PlanActionType = 'demote' | 'unlink' | 'purge';

/**
 * purge：软删超期的 item_media 行彻底删除（数据库行）；
 * unlink：物理删除磁盘上已经没有任何存活/保留期内引用的内容寻址文件（原片及派生）；
 * demote：原片从热层移动到冷层（物理 move + 全部共享行的 tier 改写）。
 */
export interface PlanAction {
  id: string;
  type: PlanActionType;
  reason: 'retention_expired' | 'idle_demote' | 'quota_hot_evict';
  source: 'policy' | 'quota';
  mediaId: string;
  itemId: string;
  kind: MediaKind;
  /** 该动作涉及的逻辑字节数（demote 为该物理文件全部热行之和，purge 为该行原片大小）。 */
  bytes: number;
  storageKey?: string;
  /** unlink 专用：要删的物理 key 列表（可能含缩略图/转码等派生文件）。 */
  keys?: string[];
  /** 预估受影响媒体行数（内容寻址去重时，一个物理文件可能被多条媒体引用）。 */
  affectedMedia: number;
  /** demote 专用：共享该物理文件、会一起翻转为 cold 的媒体行 id。 */
  sharedMediaIds?: string[];
}

export interface UsageBreakdown {
  hotBytes: number;
  coldBytes: number;
  totalBytes: number;
  hotFiles: number;
  coldFiles: number;
  byKind: Record<MediaKind, { bytes: number; files: number }>;
}

export interface QuotaStatus {
  hotBytes: number;
  hotBytesLimit: number | null;
  hotExceeded: boolean;
  totalBytes: number;
  totalBytesLimit: number | null;
  totalExceeded: boolean;
}

export interface PlannerResult {
  generatedAt: number;
  current: UsageBreakdown;
  projected: UsageBreakdown;
  quota: QuotaStatus;
  /** 规划动作执行之后仍然无法消除的配额超标（只能人工处理），附带缺口字节。 */
  unresolvedViolations: { code: string; shortfallBytes: number }[];
  actions: PlanAction[];
  summary: {
    demote: number;
    unlink: number;
    purge: number;
    demoteBytes: number;
    /** purge 释放的磁盘字节（含共享归零的原片），非逻辑用量。 */
    purgeReclaimBytes: number;
    affectedItems: number;
  };
}

const DAY_MS = 86_400_000;
export const KIND_ORDER: MediaKind[] = ['image', 'audio', 'document'];

export function emptyBreakdown(): UsageBreakdown {
  return {
    hotBytes: 0,
    coldBytes: 0,
    totalBytes: 0,
    hotFiles: 0,
    coldFiles: 0,
    byKind: {
      image: { bytes: 0, files: 0 },
      audio: { bytes: 0, files: 0 },
      document: { bytes: 0, files: 0 },
    },
  };
}

/** 逻辑用量：每个未删除的媒体行都按原片大小计一次（内容寻址共享在物理层体现，逻辑层反映用户占用）。 */
export function computeUsage(media: MediaSnapshot[]): UsageBreakdown {
  const usage = emptyBreakdown();
  for (const m of media) {
    if (m.deletedAt !== null) continue;
    usage.totalBytes += m.byteSize;
    usage.byKind[m.kind].bytes += m.byteSize;
    usage.byKind[m.kind].files += 1;
    if (m.tier === 'cold') {
      usage.coldBytes += m.byteSize;
      usage.coldFiles += 1;
    } else {
      usage.hotBytes += m.byteSize;
      usage.hotFiles += 1;
    }
  }
  return usage;
}

/**
 * 行级模拟：给定动作清单，推导执行后每个存活媒体行的 tier / 是否还存在，再重算用量。
 * demote 按 storageKey 作用于全部共享热行；purge 只作用于软删行（本就不计入用量）。
 */
function simulate(media: MediaSnapshot[], actions: PlanAction[]): UsageBreakdown {
  const demoteKeys = new Set<string>();
  for (const a of actions) if (a.type === 'demote' && a.storageKey) demoteKeys.add(a.storageKey);
  const after: MediaSnapshot[] = media
    .filter((m) => m.deletedAt === null)
    .map((m) =>
      demoteKeys.has(m.storageKey) && m.tier === 'hot'
        ? { ...m, tier: 'cold' as MediaTier }
        : m,
    );
  return computeUsage(after);
}

/**
 * 纯函数清理规划器。三段式，顺序刻意固定：
 *   1) 保留策略：软删超保留期 → purge（行）+ unlink（引用归零的物理文件）
 *   2) 分层策略：热层闲置超期且未受保护 → demote
 *   3) 配额驱动：热层仍超标 → 继续 demote 最久未用的热文件；总配额超标只报告
 *
 * 关键安全约束：
 *  - protected 媒体在任何阶段都不被选中；
 *  - 删除永远只针对「软删且超保留期」的行，自动流程绝不删活跃数据；
 *  - 物理 unlink 必须等引用同一 key 的所有存活/保留期内行都消失（引用计数）。
 */
export function buildPlan(input: PlannerInput): PlannerResult {
  const maxActions = input.maxActions ?? 1000;
  const policyByKind = new Map(input.policies.map((p) => [p.kind, p]));
  const current = computeUsage(input.media);

  const liveRows = input.media.filter((m) => m.deletedAt === null);
  const deadRows = input.media.filter((m) => m.deletedAt !== null);

  // 物理 key（原片+派生）→ 仍存活的引用行数。
  const allKeysOf = (m: MediaSnapshot) =>
    [m.storageKey, m.thumbKey, m.largeKey, m.transcodeKey, m.waveformKey].filter(
      (k): k is string => Boolean(k),
    );
  const liveRefs = new Map<string, number>();
  for (const m of liveRows) for (const k of allKeysOf(m)) liveRefs.set(k, (liveRefs.get(k) ?? 0) + 1);

  // 原片 key → 全部引用行数（影响面评估）。
  const refsOfKey = new Map<string, number>();
  const hotRowsByKey = new Map<string, MediaSnapshot[]>();
  for (const m of input.media) {
    refsOfKey.set(m.storageKey, (refsOfKey.get(m.storageKey) ?? 0) + 1);
  }
  for (const m of liveRows.filter((x) => x.tier === 'hot')) {
    const list = hotRowsByKey.get(m.storageKey) ?? [];
    list.push(m);
    hotRowsByKey.set(m.storageKey, list);
  }

  const actions: PlanAction[] = [];
  const purgedMediaIds = new Set<string>();
  const unlinkedKeys = new Set<string>();
  const demotedKeys = new Set<string>();
  const pushAction = (a: PlanAction) => {
    if (actions.length < maxActions) actions.push(a);
  };

  // —— 阶段 1：保留期到期的软删媒体 ——
  const purgeCandidates = deadRows
    .map((m) => {
      const policy = policyByKind.get(m.kind);
      if (!policy || policy.protected || m.protected) return null;
      if (policy.coldRetentionDays === null) return null;
      const expireAt = (m.deletedAt ?? m.createdAt) + policy.coldRetentionDays * DAY_MS;
      return input.now < expireAt ? null : { m, expireAt };
    })
    .filter((x): x is { m: MediaSnapshot; expireAt: number } => x !== null)
    .sort((a, b) => a.expireAt - b.expireAt || a.m.deletedAt! - b.m.deletedAt!);

  for (const { m } of purgeCandidates) {
    purgedMediaIds.add(m.id);
    pushAction({
      id: `purge-${m.id}`,
      type: 'purge',
      reason: 'retention_expired',
      source: 'policy',
      mediaId: m.id,
      itemId: m.itemId,
      kind: m.kind,
      bytes: m.byteSize,
      storageKey: m.storageKey,
      affectedMedia: refsOfKey.get(m.storageKey) ?? 1,
    });
  }

  // 仍受保护（保留期内）的死行继续持有磁盘文件；只有全部引用方都在本批 purge 中才 unlink。
  const retainedRefs = new Map(liveRefs);
  for (const m of deadRows) {
    if (!purgedMediaIds.has(m.id)) {
      for (const k of allKeysOf(m)) retainedRefs.set(k, (retainedRefs.get(k) ?? 0) + 1);
    }
  }

  // 按媒体行聚合待 unlink 的 key，再每个归零 key 输出一个 unlink 动作。
  const unlinkGroups = new Map<string, { m: MediaSnapshot; keys: string[] }>();
  for (const { m } of purgeCandidates) {
    for (const k of allKeysOf(m)) {
      if ((retainedRefs.get(k) ?? 0) > 0 || unlinkedKeys.has(k)) continue;
      unlinkedKeys.add(k);
      const group = unlinkGroups.get(m.id) ?? { m, keys: [] };
      group.keys.push(k);
      unlinkGroups.set(m.id, group);
    }
  }
  for (const { m, keys } of unlinkGroups.values()) {
    pushAction({
      id: `unlink-${m.id}`,
      type: 'unlink',
      reason: 'retention_expired',
      source: 'policy',
      mediaId: m.id,
      itemId: m.itemId,
      kind: m.kind,
      bytes: 0,
      keys: keys.sort(),
      affectedMedia: refsOfKey.get(m.storageKey) ?? 1,
    });
  }

  // —— 阶段 2：热层闲置降级（策略驱动） ——
  // 同一物理 key 的任一热行被保护/关闭降级/仍在窗口内，则整个文件不搬（共享保护）。
  const blockedKeys = new Set<string>();
  for (const [key, rows] of hotRowsByKey) {
    for (const m of rows) {
      const policy = policyByKind.get(m.kind);
      if (!policy || policy.protected || m.protected || policy.hotMaxIdleDays === null) {
        blockedKeys.add(key);
        break;
      }
      if (input.now - m.lastAccessedAt < policy.hotMaxIdleDays * DAY_MS) {
        blockedKeys.add(key);
        break;
      }
    }
  }

  const idleAge = (m: MediaSnapshot) => input.now - m.lastAccessedAt;
  // 每个物理 key 选最久未访问的代表行参与排序；动作字节按全部热行求和（逻辑口径）。
  const representative = (key: string) =>
    hotRowsByKey.get(key)!.slice().sort((a, b) => idleAge(b) - idleAge(a) || a.createdAt - b.createdAt)[0]!;

  const policyDemoteKeys = [...hotRowsByKey.keys()]
    .filter((key) => !blockedKeys.has(key))
    .map(representative)
    .sort((a, b) => idleAge(b) - idleAge(a) || a.createdAt - b.createdAt);

  const addDemote = (m: MediaSnapshot, reason: PlanAction['reason']) => {
    if (demotedKeys.has(m.storageKey)) return;
    const sharedHot = hotRowsByKey.get(m.storageKey) ?? [m];
    demotedKeys.add(m.storageKey);
    pushAction({
      id: reason === 'idle_demote' ? `demote-${m.id}` : `demote-quota-${m.id}`,
      type: 'demote',
      reason,
      source: reason === 'idle_demote' ? 'policy' : 'quota',
      mediaId: m.id,
      itemId: m.itemId,
      kind: m.kind,
      bytes: sharedHot.reduce((sum, r) => sum + r.byteSize, 0),
      storageKey: m.storageKey,
      affectedMedia: refsOfKey.get(m.storageKey) ?? 1,
      sharedMediaIds: sharedHot.map((r) => r.id),
    });
  };

  for (const m of policyDemoteKeys) addDemote(m, 'idle_demote');

  // —— 阶段 3：热层配额超标 → 继续挑最久未用、可降级的热文件（受保护者豁免） ——
  let projected = simulate(input.media, actions);
  const unresolved: { code: string; shortfallBytes: number }[] = [];
  const hotLimit = input.quota.hotBytesLimit;
  if (hotLimit !== null && projected.hotBytes > hotLimit) {
    const evictables = [...hotRowsByKey.keys()]
      .filter((key) => !demotedKeys.has(key))
      // 只要共享组里没有任何「被保护 / 关闭降级」的行就允许配额降级；仍在闲置窗口内不算阻断。
      .filter((key) => {
        const rows = hotRowsByKey.get(key)!;
        return rows.every((m) => {
          const policy = policyByKind.get(m.kind);
          return policy && !policy.protected && !m.protected && policy.hotMaxIdleDays !== null;
        });
      })
      .map(representative)
      .sort((a, b) => idleAge(b) - idleAge(a) || a.createdAt - b.createdAt);

    for (const m of evictables) {
      if (projected.hotBytes <= hotLimit) break;
      addDemote(m, 'quota_hot_evict');
      projected = simulate(input.media, actions);
    }
    if (projected.hotBytes > hotLimit) {
      unresolved.push({ code: 'hot_quota_unresolved', shortfallBytes: projected.hotBytes - hotLimit });
    }
  }

  projected = simulate(input.media, actions);
  if (input.quota.totalBytesLimit !== null && projected.totalBytes > input.quota.totalBytesLimit) {
    unresolved.push({
      code: 'total_quota_unresolved',
      shortfallBytes: projected.totalBytes - input.quota.totalBytesLimit,
    });
  }

  const affectedItems = new Set<string>();
  let demoteBytes = 0;
  let purgeReclaimBytes = 0;
  for (const a of actions) {
    affectedItems.add(a.itemId);
    if (a.type === 'demote') demoteBytes += a.bytes;
    if (a.type === 'purge' && (retainedRefs.get(a.storageKey!) ?? 0) === 0) {
      purgeReclaimBytes += a.bytes; // 原片引用归零才真正释放磁盘
    }
  }

  return {
    generatedAt: input.now,
    current,
    projected,
    quota: {
      hotBytes: current.hotBytes,
      hotBytesLimit: hotLimit,
      hotExceeded: hotLimit !== null && current.hotBytes > hotLimit,
      totalBytes: current.totalBytes,
      totalBytesLimit: input.quota.totalBytesLimit,
      totalExceeded:
        input.quota.totalBytesLimit !== null && current.totalBytes > input.quota.totalBytesLimit,
    },
    unresolvedViolations: unresolved,
    actions,
    summary: {
      demote: actions.filter((a) => a.type === 'demote').length,
      unlink: actions.filter((a) => a.type === 'unlink').length,
      purge: actions.filter((a) => a.type === 'purge').length,
      demoteBytes,
      purgeReclaimBytes,
      affectedItems: affectedItems.size,
    },
  };
}

/** 默认保留策略：图片 90 天降冷、软删后 30 天删；音频 180 天降冷；文档/PDF 默认永久保留且受保护。 */
export function defaultPolicy(kind: MediaKind): KindPolicy {
  if (kind === 'image') return { kind, hotMaxIdleDays: 90, coldRetentionDays: 30, protected: false };
  if (kind === 'audio') return { kind, hotMaxIdleDays: 180, coldRetentionDays: 30, protected: false };
  return { kind, hotMaxIdleDays: null, coldRetentionDays: null, protected: true };
}

export function defaultPolicies(): KindPolicy[] {
  return KIND_ORDER.map(defaultPolicy);
}
