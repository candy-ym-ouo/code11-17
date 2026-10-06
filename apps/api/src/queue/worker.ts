import type { Job } from '@prisma/client';
import type { Dirent } from 'node:fs';
import { config } from '../config';
import { prisma } from '../db';
import { logger } from '../logger';
import { processImage } from '../media/image';
import { processAudio } from '../media/audio';
import { inspectDocument } from '../media/document';
import { putBuffer } from '../storage/local';
import { makeTmpPath } from '../services/mediaService';
import { buildExportZip } from '../services/exportService';
import {
  applyStoredPlan,
  createStoredPlan,
  enqueueStorageTier,
  previewFamily,
} from '../services/storagePlanService';

type Handler = (job: Job) => Promise<Record<string, unknown>>;

async function handleThumbnail(job: Job): Promise<Record<string, unknown>> {
  const { mediaId } = job.payload as { mediaId: string };
  const media = await prisma.itemMedia.findUnique({ where: { id: mediaId } });
  if (!media) return { skipped: '媒体已删除' };
  try {
    if (media.kind === 'image') {
      const item = await prisma.item.findUniqueOrThrow({ where: { id: media.itemId } });
      const variants = await processImage(absPathOf(media.storageKey), item.familyId, media.sha256, putBuffer);
      await prisma.itemMedia.update({
        where: { id: mediaId },
        data: {
          status: 'ready',
          thumbKey: variants.thumbKey,
          largeKey: variants.largeKey,
          width: variants.width,
          height: variants.height,
          lastError: null,
        },
      });
      return { thumbKey: variants.thumbKey, width: variants.width, height: variants.height };
    }
    if (media.kind === 'document') {
      const info = await inspectDocument(absPathOf(media.storageKey));
      await prisma.itemMedia.update({
        where: { id: mediaId },
        data: { status: 'ready', lastError: null },
      });
      return { pageCount: info.pageCount };
    }
    await prisma.itemMedia.update({ where: { id: mediaId }, data: { status: 'ready' } });
    return { skipped: '非图片/文档' };
  } catch (err) {
    await prisma.itemMedia.update({
      where: { id: mediaId },
      data: { status: 'failed', lastError: err instanceof Error ? err.message.slice(0, 500) : '处理失败' },
    });
    throw err;
  }
}

function absPathOf(key: string): string {
  // 延迟引入，避免循环依赖
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { absOf } = require('../storage/local') as typeof import('../storage/local');
  return absOf(key);
}

async function handleWaveform(job: Job): Promise<Record<string, unknown>> {
  const { mediaId } = job.payload as { mediaId: string };
  const media = await prisma.itemMedia.findUnique({ where: { id: mediaId } });
  if (!media) return { skipped: '媒体已删除' };
  const item = await prisma.item.findUniqueOrThrow({ where: { id: media.itemId } });
  const variants = await processAudio(
    absPathOf(media.storageKey),
    item.familyId,
    media.sha256,
    putBuffer,
    makeTmpPath,
  );
  await prisma.itemMedia.update({
    where: { id: mediaId },
    data: {
      status: 'ready',
      transcodeKey: variants.transcodeKey,
      waveformKey: variants.waveformKey,
      durationMs: variants.durationMs,
      lastError: null,
    },
  });
  return { transcodeKey: variants.transcodeKey, peaks: variants.peakCount, durationMs: variants.durationMs };
}

async function handleExport(job: Job): Promise<Record<string, unknown>> {
  const result = await buildExportZip(job);
  return { items: result.items, media: result.media, bytes: result.bytes, file: result.file };
}

/**
 * 回收站清理。按「媒体类型保留策略」执行（storage_tier 任务的策略侧由规划器统一完成），
 * 这里保留旧有的整单兜底：超过 TRASH_RETENTION_DAYS 且已没有任何媒体残留的条目，
 * 才删除条目外壳（故事/时间等文字信息）。媒体原片的彻底删除由 storage_tier 的
 * purge/unlink 动作负责，受保留策略与 protected 保护。
 */
async function handleTrashPurge(): Promise<Record<string, unknown>> {
  const cutoff = new Date(Date.now() - config.TRASH_RETENTION_DAYS * 86_400_000);
  const expired = await prisma.item.findMany({
    where: { status: 'trashed', deletedAt: { lt: cutoff } },
    include: { media: true },
    take: 500,
  });
  let removed = 0;
  let mediaLeft = 0;
  for (const item of expired) {
    if (item.media.length > 0) {
      // 还有媒体行（可能是受保护类型、保留期未到）：条目外壳保留，等媒体清空后下一轮再删
      mediaLeft += 1;
      continue;
    }
    await prisma.item.delete({ where: { id: item.id } });
    removed += 1;
  }
  return { removed, mediaLeft, cutoff: cutoff.toISOString() };
}

/** 清理孤儿文件与过期导出包，防止磁盘只涨不降。 */
async function handleStorageGc(): Promise<Record<string, unknown>> {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const { toColdKey } = await import('../storage/local');
  const referenced = new Set<string>();
  // 冷层引用单独建集：行里 storage_key 始终是热层逻辑路径，tier='cold' 时物理文件在 cold/ 目录。
  const referencedCold = new Set<string>();
  const media = await prisma.itemMedia.findMany({
    select: {
      tier: true,
      storageKey: true,
      thumbKey: true,
      largeKey: true,
      transcodeKey: true,
      waveformKey: true,
    },
  });
  for (const m of media) {
    for (const k of [m.thumbKey, m.largeKey, m.transcodeKey, m.waveformKey]) if (k) referenced.add(k);
    if (m.storageKey) {
      if (m.tier === 'cold') {
        try {
          referencedCold.add(toColdKey(m.storageKey));
        } catch {
          referenced.add(m.storageKey);
        }
      } else {
        referenced.add(m.storageKey);
      }
    }
  }

  const root = config.STORAGE_ROOT;
  let scanned = 0;
  let deleted = 0;
  let coldDeleted = 0;
  const cutoff = Date.now() - 24 * 3600 * 1000;

  async function walk(dir: string, cold: boolean): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'tmp') continue; // 临时目录单独处理
        if (entry.name === 'cold') {
          if (!cold) await walk(full, true); // 进入冷层，用冷层引用集判定
          continue;
        }
        await walk(full, cold);
        continue;
      }
      scanned += 1;
      const key = path.relative(root, full).split(path.sep).join('/');
      if ((cold ? referencedCold : referenced).has(key)) continue;
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || stat.mtimeMs > cutoff) continue; // 24h 宽限：降冷/回暖在途的文件不动
      await fsp.rm(full, { force: true });
      deleted += 1;
      if (cold) coldDeleted += 1;
    }
  }
  await walk(root, false);

  // 临时目录里超过 24 小时的残留（中断的上传）直接清掉
  const tmp = path.join(root, 'tmp');
  for (const name of await fsp.readdir(tmp).catch(() => [])) {
    const full = path.join(tmp, name);
    const stat = await fsp.stat(full).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fsp.rm(full, { force: true, recursive: true });
      deleted += 1;
    }
  }

  // 过期导出包
  const exportCutoff = Date.now() - config.EXPORT_RETENTION_DAYS * 86_400_000;
  for (const familyDir of await fsp.readdir(config.EXPORT_ROOT).catch(() => [])) {
    const dir = path.join(config.EXPORT_ROOT, familyDir);
    for (const file of await fsp.readdir(dir).catch(() => [])) {
      const full = path.join(dir, file);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat && stat.mtimeMs < exportCutoff) {
        await fsp.rm(full, { force: true });
        deleted += 1;
      }
    }
  }

  return { scanned, deleted, coldDeleted };
}

/**
 * 冷热分层 + 保留期清理（storage_tier）。
 * payload: { familyId?: string }——指定家庭（配额变更触发）或全量（每日任务）。
 *
 * 并发安全要点：
 *  - 同一家庭的分层在事务内对家庭行加锁，两个 storage_tier（每日 + 手动）即使同时入队也串行；
 *  - 全量任务用 pg_try_advisory_lock 跳过「已有一轮全量在跑」的情况，避免多实例重复搬文件；
 *  - 每个物理文件的 demote/purge/unlink 另有 key 级咨询锁（见 storagePlanService）。
 */
async function handleStorageTier(job: Job): Promise<Record<string, unknown>> {
  const payload = (job.payload ?? {}) as { familyId?: string; trigger?: string };
  const families = await prisma.family.findMany({
    where: {
      deletedAt: null,
      ...(payload.familyId ? { id: payload.familyId } : {}),
    },
    select: { id: true, createdBy: true },
  });

  let plans = 0;
  let applied = 0;
  let demoted = 0;
  let purged = 0;
  const skipped: string[] = [];

  for (const family of families) {
    // 不需要家庭级互斥：每个物理文件的 demote/purge/unlink 都在 key 级事务咨询锁内执行，
    // 两轮并发分层相遇时，后到者读到的已是 cold/已删除状态，动作自然 skip（幂等无副作用）。
    // 入队侧另有「同家庭已有排队/运行任务则不重复入队」的去重（见 enqueueStorageTier）。
    try {
      const preview = await previewFamily({ familyId: family.id });
      if (preview.actions.length === 0) continue;
      const { planId } = await createStoredPlan({
        familyId: family.id,
        actorId: family.createdBy, // 系统任务以家庭创建者身份留痕
        trigger: 'daily_maintenance',
        reason: payload.trigger ?? (payload.familyId ? 'quota_or_manual' : 'scheduled'),
      });
      const result = await applyStoredPlan(planId, family.id, family.createdBy);
      applied += result.outcomes.filter((o) => o.status === 'done').length;
      demoted += result.outcomes.filter((o) => o.type === 'demote' && o.status === 'done').length;
      purged += result.outcomes.filter((o) => o.type === 'purge' && o.status === 'done').length;
      plans += 1;
    } catch (err) {
      // 单个家庭失败不影响其它家庭；失败原因进日志，下一轮每日任务兜底
      logger.error({ familyId: family.id, err: err instanceof Error ? err.message : err }, '家庭分层任务失败');
      skipped.push(`${family.id}:error`);
    }
  }

  return { families: families.length, plans, appliedActions: applied, demoted, purged, skipped };
}

const HANDLERS: Record<string, Handler> = {
  media_thumbnail: handleThumbnail,
  media_waveform: handleWaveform,
  export_build: handleExport,
  trash_purge: handleTrashPurge,
  storage_gc: handleStorageGc,
  storage_tier: handleStorageTier,
};

/** 原子领取一个任务：UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)。 */
async function claimJob(): Promise<Job | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE jobs SET status = 'running', started_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_after <= now()
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;
  const first = rows[0];
  if (!first) return null;
  return prisma.job.findUnique({ where: { id: first.id } });
}

async function runOnce(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  const handler = HANDLERS[job.type];
  if (!handler) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'failed', finishedAt: new Date(), lastError: `未知任务类型 ${job.type}` },
    });
    return true;
  }
  try {
    const result = await handler(job);
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'done', progress: 100, finishedAt: new Date(), result: result as never, lastError: null },
    });
    logger.info({ jobId: job.id, type: job.type, result }, '任务完成');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = job.attempts >= job.maxAttempts;
    const backoffMs = Math.min(30 * 60_000, 60_000 * 5 ** Math.max(0, job.attempts - 1));
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: exhausted ? 'failed' : 'queued',
        lastError: message.slice(0, 1000),
        finishedAt: exhausted ? new Date() : null,
        runAfter: new Date(Date.now() + backoffMs),
      },
    });
    logger.error({ jobId: job.id, type: job.type, attempts: job.attempts, err: message }, '任务失败');
  }
  return true;
}

const DAILY = 24 * 3600 * 1000;

export function startWorker(): () => void {
  if (!config.WORKER_ENABLED) {
    logger.warn('WORKER_ENABLED=false，后台任务不会执行（缩略图/波形/导出将一直处于排队状态）');
    return () => undefined;
  }
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      let processed = 0;
      while (processed < 5 && (await runOnce())) processed += 1;
    } catch (err) {
      logger.error({ err }, 'worker 轮询失败');
    }
    if (!stopped) timer = setTimeout(tick, config.WORKER_POLL_MS);
  };
  timer = setTimeout(tick, 1000);

  // 每日维护顺序固定：冷热分层/保留期执行 → 回收站外壳清理 → 孤儿文件回收。
  // storage_tier 先按媒体类型保留策略 purge/unlink 并降冷；trash_purge 再清理已无媒体的条目；
  // storage_gc 最后兜底扫描（跳过 cold/ 目录，冷文件归分层模块管）。
  const daily = setInterval(() => {
    void prisma.job
      .create({ data: { type: 'trash_purge', payload: {} as never } })
      // 全量分层带去重：已有一轮在排队/运行时不会再插一条
      .then(() => enqueueStorageTier(null, 'daily_maintenance'))
      .then(() => prisma.job.create({ data: { type: 'storage_gc', payload: {} as never } }))
      .catch((err) => logger.error({ err }, '每日维护任务入队失败'));
  }, DAILY);

  logger.info({ pollMs: config.WORKER_POLL_MS }, '后台任务 worker 已启动');
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearInterval(daily);
  };
}

export const __test__ = { runOnce, computeBackoffForTest: (attempts: number) => Math.min(30 * 60_000, 60_000 * 5 ** Math.max(0, attempts - 1)) };
