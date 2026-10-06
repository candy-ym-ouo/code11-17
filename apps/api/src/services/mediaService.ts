import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { ItemMedia } from '@prisma/client';
import { prisma } from '../db';
import { AppError, badRequest, notFound, conflict } from '../http/errors';
import { config } from '../config';
import { objectKey, exists, moveIntoPlace, remove, statObject, tmpDir } from '../storage/local';
import { detectFileType, limitForKind } from '../media/sniff';
import { toMediaDto } from '../serializers';
import * as audit from './auditService';
import { itemWithAccess, type FamilyContext } from './permissionService';
import { chargeUpload, lockFamilyStorage } from './quotaService';

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

  if (await exists(key)) {
    await fsp.rm(file.path, { force: true }); // 内容寻址命中：同一份文件不重复占盘
  } else {
    await moveIntoPlace(file.path, key);
  }

  const maxSort = await prisma.itemMedia.aggregate({ where: { itemId }, _max: { sortOrder: true } });
  const isFirstImage = detected.kind === 'image' && !item.coverMediaId;

  // 配额判定在事务内、持家庭存储锁完成；去重命中不收费。超限会在这里抛 507
  const quotaCheck = await prisma.$transaction(async (tx) => {
    await lockFamilyStorage(ctx.familyId, tx);
    return chargeUpload({ familyId: ctx.familyId, bytes: file.size, storageKey: key, tx });
  });

  const media = await prisma.$transaction(async (tx) => {
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
        diff: {
          mediaId: created.id,
          kind: detected.kind,
          bytes: file.size,
          sha256: sha,
          chargedToQuota: quotaCheck.charged,
          usageBytes: Number(quotaCheck.usageBytes),
        } as never,
        ...meta,
      },
      tx,
    );
    return created;
  });

  const dto = toMediaDto(media, ctx.familyId);
  return { ...dto, quotaWarning: quotaCheck.warning, usageBytes: Number(quotaCheck.usageBytes), quotaBytes: quotaCheck.quotaBytes === null ? null : Number(quotaCheck.quotaBytes) };
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

export async function mediaFileTarget(media: ItemMedia, variant: 'raw' | 'thumb' | 'waveform' | 'download') {
  // 派生件（缩略图/波形/音频转码）始终留在热层；只有原始件会降到冷层
  const derivedTier: 'hot' = 'hot';
  const key =
    variant === 'raw'
      ? media.storageKey
      : variant === 'download'
        ? (media.transcodeKey ?? media.storageKey)
        : variant === 'thumb'
          ? (media.thumbKey ?? media.storageKey)
          : media.waveformKey;
  if (!key) throw notFound('该文件还没有可用产物');
  // 只有「取原始件/无转码回落原始件」且记录标记冷层时，才去冷盘读
  const isRawObject = key === media.storageKey;
  const tier = isRawObject ? media.tier : derivedTier;
  const stat = await statObject(key, tier);
  if (!stat) {
    // 记录与磁盘不一致时给出可操作的错误（冷盘未挂载/文件被外部清理）
    throw notFound(tier === 'cold' ? '冷层文件当前不可读（冷盘可能未挂载），请先取回或稍后重试' : '文件已不存在');
  }
  return {
    key,
    size: stat.size,
    tier,
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
