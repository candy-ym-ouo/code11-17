import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { ItemMedia } from '@prisma/client';
import { prisma } from '../db';
import { AppError, badRequest, notFound, conflict } from '../http/errors';
import { config } from '../config';
import { objectKey, exists, moveIntoPlace, remove, statObject, tmpDir, toColdKey } from '../storage/local';
import { detectFileType, limitForKind } from '../media/sniff';
import { toMediaDto } from '../serializers';
import { logger } from '../logger';
import * as audit from './auditService';
import { itemWithAccess, type FamilyContext } from './permissionService';
import { assertUploadWithinQuota, promoteIfCold, touchAccessed } from './storagePlanService';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function enqueue(type: 'media_thumbnail' | 'media_waveform' | 'export_build', payload: object, familyId?: string) {
  await prisma.job.create({
    data: { type, payload: payload as never, familyId: familyId ?? null },
  });
}

export async function uploadMedia(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  file: { path: string; originalname: string; size: number },
  fields: { kind?: string; caption?: string | null; transcript?: string | null },
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  if (!access.canManageMedia) {
    await fsp.rm(file.path, { force: true });
    throw new AppError('FORBIDDEN', '没有权限为该条目上传媒体');
  }

  const detected = await detectFileType(file.path);
  const limit = limitForKind(detected.kind, config.limits);
  if (file.size > limit) {
    await fsp.rm(file.path, { force: true });
    throw new AppError('FILE_TOO_LARGE', `文件超过 ${Math.round(limit / 1024 / 1024)}MB 上限`);
  }
  if (fields.kind && fields.kind !== detected.kind) {
    await fsp.rm(file.path, { force: true });
    throw badRequest(`文件真实类型是 ${detected.kind}，与声明的 ${fields.kind} 不一致`);
  }

  const sha = await sha256File(file.path);
  const key = objectKey(ctx.familyId, sha, detected.mime);

  // 内容寻址命中（热层已有同 sha 原片）不新增物理/逻辑占用，跳过配额。
  // 冷层里的同名文件也算命中：逻辑上仍是新引用，需要占配额并登记为热引用，
  // 但文件本身不重复落盘（回暖由读取时按需触发）。
  const hotHit = await exists(key);
  if (hotHit) {
    await fsp.rm(file.path, { force: true }); // 内容寻址命中：同一份文件不重复占盘，也不新增配额占用
  } else {
    await moveIntoPlace(file.path, key);
  }

  const maxSort = await prisma.itemMedia.aggregate({ where: { itemId }, _max: { sortOrder: true } });
  const isFirstImage = detected.kind === 'image' && !item.coverMediaId;

  const media = await prisma.$transaction(async (tx) => {
    // 逻辑引用新增（非热层命中）才校验配额；家庭行锁保证并发上传不超卖
    if (!hotHit) {
      await assertUploadWithinQuota(tx, ctx.familyId, detected.kind, file.size);
    }
    const created = await tx.itemMedia.create({
      data: {
        itemId,
        kind: detected.kind,
        status: 'processing',
        storageKey: key,
        sha256: sha,
        mimeType: detected.mime,
        byteSize: BigInt(file.size),
        originalName: path.basename(file.originalname).slice(0, 200),
        caption: fields.caption ?? null,
        transcript: fields.transcript ?? null,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
        createdBy: userId,
      },
    });
    if (isFirstImage) {
      await tx.item.update({ where: { id: itemId }, data: { coverMediaId: created.id } });
    }
    await tx.job.create({
      data: {
        familyId: ctx.familyId,
        type: detected.kind === 'audio' ? 'media_waveform' : 'media_thumbnail',
        payload: { mediaId: created.id } as never,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'media.upload',
        targetType: 'item',
        targetId: itemId,
        diff: { mediaId: created.id, kind: detected.kind, bytes: file.size, sha256: sha } as never,
        ...meta,
      },
      tx,
    );
    return created;
  });

  return toMediaDto(media, ctx.familyId);
}

export async function listItemMedia(userId: string, ctx: FamilyContext, itemId: string) {
  await itemWithAccess(userId, ctx, itemId);
  const rows = await prisma.itemMedia.findMany({
    where: { itemId, deletedAt: null },
    orderBy: { sortOrder: 'asc' },
  });
  return rows.map((m) => toMediaDto(m, ctx.familyId));
}

export async function updateMedia(
  userId: string,
  ctx: FamilyContext,
  mediaId: string,
  input: { caption?: string | null; transcript?: string | null; sortOrder?: number; setCover?: boolean },
  meta: ActorMeta,
) {
  const media = await loadMediaForUser(userId, ctx, mediaId);
  const { access } = await itemWithAccess(userId, ctx, media.itemId);
  if (!access.canManageMedia) throw new AppError('FORBIDDEN', '没有权限修改该媒体');

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.itemMedia.update({
      where: { id: mediaId },
      data: {
        caption: input.caption === undefined ? undefined : input.caption,
        transcript: input.transcript === undefined ? undefined : input.transcript,
        sortOrder: input.sortOrder ?? undefined,
      },
    });
    if (input.setCover) {
      if (result.kind !== 'image') throw badRequest('只有图片可以设为封面');
      await tx.item.update({ where: { id: media.itemId }, data: { coverMediaId: mediaId } });
    }
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'media.update',
        targetType: 'item',
        targetId: media.itemId,
        diff: { mediaId, fields: Object.keys(input) } as never,
        ...meta,
      },
      tx,
    );
    return result;
  });
  return toMediaDto(updated, ctx.familyId);
}

export async function softDeleteMedia(userId: string, ctx: FamilyContext, mediaId: string, meta: ActorMeta) {
  const media = await loadMediaForUser(userId, ctx, mediaId);
  const { access } = await itemWithAccess(userId, ctx, media.itemId);
  if (!access.canManageMedia) throw new AppError('FORBIDDEN', '没有权限删除该媒体');

  await prisma.$transaction(async (tx) => {
    await tx.itemMedia.update({ where: { id: mediaId }, data: { deletedAt: new Date() } });
    const item = await tx.item.findUniqueOrThrow({ where: { id: media.itemId } });
    if (item.coverMediaId === mediaId) {
      const next = await tx.itemMedia.findFirst({
        where: { itemId: media.itemId, deletedAt: null, kind: 'image' },
        orderBy: { sortOrder: 'asc' },
      });
      await tx.item.update({ where: { id: media.itemId }, data: { coverMediaId: next?.id ?? null } });
    }
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'media.delete',
        targetType: 'item',
        targetId: media.itemId,
        diff: { mediaId } as never,
        ...meta,
      },
      tx,
    );
  });
}

export async function loadMediaForUser(userId: string, ctx: FamilyContext, mediaId: string): Promise<ItemMedia> {
  const media = await prisma.itemMedia.findFirst({
    where: { id: mediaId, deletedAt: null, item: { familyId: ctx.familyId, deletedAt: null } },
  });
  if (!media) throw notFound('媒体不存在');
  await itemWithAccess(userId, ctx, media.itemId);
  return media;
}

/**
 * 定位媒体文件。raw/download 可能命中冷层原片：
 *   - 库标记 hot 但物理文件已在冷层（上次降冷中断），尝试回暖后再读；
 *   - 库标记 cold 则读冷路径，并在同一次请求里触发按需回暖（读一次即热回来）。
 * 缩略图/波形等派生文件始终在热层。
 */
export async function mediaFileTarget(media: ItemMedia, variant: 'raw' | 'thumb' | 'waveform' | 'download') {
  const isOriginal = variant === 'raw' || variant === 'download';
  let key =
    variant === 'raw'
      ? media.storageKey
      : variant === 'download'
        ? (media.transcodeKey ?? media.storageKey)
        : variant === 'thumb'
          ? (media.thumbKey ?? media.storageKey)
          : media.waveformKey;
  if (!key) throw notFound('该文件还没有可用产物');

  const fallbackToTranscode = variant === 'download' && media.transcodeKey;
  if (isOriginal && media.tier === 'cold' && !fallbackToTranscode) {
    const coldKey = key.startsWith('families/') && !key.includes('/cold/') ? toColdKey(key) : key;
    let stat = await statObject(coldKey);
    if (!stat && coldKey !== key) stat = await statObject(key);
    if (!stat) throw notFound('文件已不存在');
    // 冷文件被读取：异步回暖（咨询锁保证与降冷互斥），不阻塞本次播放
    void promoteIfCold({ ...media, storageKey: key })
      .then((r) => {
        if (r === 'promoted') logger.info({ mediaId: media.id }, '冷层文件已按需回暖');
      })
      .catch((err) => logger.warn({ mediaId: media.id, err: err instanceof Error ? err.message : err }, '冷文件回暖失败'));
    void touchAccessed(media.id);
    return {
      key: coldKey,
      size: stat.size,
      mimeType: media.mimeType,
    };
  }

  if (isOriginal && media.tier === 'hot') {
    let stat = await statObject(key);
    if (!stat) {
      // 物理层与库不一致（降冷后库未更新）：尝试冷路径并修复
      const coldKey = toColdKey(key);
      const coldStat = await statObject(coldKey);
      if (coldStat) {
        await promoteIfCold({ ...media, tier: 'cold', storageKey: key }).catch(() => undefined);
        stat = await statObject(key);
        if (!stat) return { key: coldKey, size: coldStat.size, mimeType: media.mimeType };
      }
    }
    if (!stat) throw notFound('文件已不存在');
    if (variant === 'raw') void touchAccessed(media.id);
    return { key, size: stat.size, mimeType: media.mimeType };
  }

  const stat = await statObject(key);
  if (!stat) throw notFound('文件已不存在');
  return {
    key,
    size: stat.size,
    mimeType:
      variant === 'thumb' && media.thumbKey
        ? 'image/webp'
        : variant === 'download' && media.transcodeKey
          ? 'audio/mpeg'
          : media.mimeType,
  };
}

export { enqueue };

export function makeTmpPath(ext: string): string {
  return path.join(tmpDir(), `proc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
}

export async function removeStoredKeys(keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => remove(k).catch(() => undefined)));
}

export async function assertMediaBelongsToFamily(mediaId: string, familyId: string): Promise<ItemMedia> {
  const media = await prisma.itemMedia.findFirst({ where: { id: mediaId, item: { familyId } } });
  if (!media) throw conflict('媒体与家庭不匹配');
  return media;
}
