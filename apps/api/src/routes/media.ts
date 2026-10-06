import { Router } from 'express';
import type { Request, Response } from 'express';
import { updateMediaSchema } from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta, currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validation';
import * as mediaService from '../services/mediaService';
import { prisma } from '../db';
import { config } from '../config';
import { sendStoredFile } from '../http/sendFile';

export const mediaRouter = Router({ mergeParams: true });

type Variant = 'raw' | 'download' | 'thumb' | 'waveform';

async function serve(req: Request, res: Response, variant: Variant) {
  const user = currentUser(req);
  const ctx = familyCtx(req);
  const media = await mediaService.loadMediaForUser(user.id, ctx, req.params.mediaId!);
  const target = await mediaService.mediaFileTarget(media, variant);

  // 冷层原始件被真实访问：本次直接从冷盘流式返回，同时后台把它取回热层（只处理原始件，派生件本就在热层）
  if (target.tier === 'cold' && config.COLD_RESTORE_ON_ACCESS) {
    res.setHeader('X-Storage-Tier', 'cold');
    await prisma.job
      .create({
        data: {
          familyId: ctx.familyId,
          type: 'media_restore',
          payload: { mediaId: media.id, familyId: ctx.familyId, requestedBy: user.id },
        },
      })
      .catch(() => undefined); // 取回是锦上添花，入队失败不影响本次读取
  }

  sendStoredFile(req, res, {
    key: target.key,
    size: target.size,
    tier: target.tier,
    mimeType: target.mimeType,
    filename:
      variant === 'thumb'
        ? `${media.id}-thumb.webp`
        : variant === 'waveform'
          ? `${media.id}.waveform.json`
          : media.originalName,
    download: variant === 'download',
  });
}

mediaRouter.get('/:mediaId/raw', requireFamily('family:read'), asyncHandler((req, res) => serve(req, res, 'raw')));
mediaRouter.get('/:mediaId/download', requireFamily('family:read'), asyncHandler((req, res) => serve(req, res, 'download')));
mediaRouter.get('/:mediaId/thumb', requireFamily('family:read'), asyncHandler((req, res) => serve(req, res, 'thumb')));
mediaRouter.get('/:mediaId/waveform', requireFamily('family:read'), asyncHandler((req, res) => serve(req, res, 'waveform')));

mediaRouter.patch(
  '/:mediaId',
  requireFamily('family:read'),
  writeLimiter,
  validateBody(updateMediaSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const media = await mediaService.updateMedia(user.id, ctx, req.params.mediaId!, req.body, clientMeta(req));
    res.json({ media });
  }),
);

mediaRouter.delete(
  '/:mediaId',
  requireFamily('family:read'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await mediaService.softDeleteMedia(user.id, ctx, req.params.mediaId!, clientMeta(req));
    res.status(204).end();
  }),
);
