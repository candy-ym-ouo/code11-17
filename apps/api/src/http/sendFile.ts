import type { Request, Response } from 'express';
import { readStream } from '../storage/local';
import type { StorageTier } from '@heirloom/shared';

interface SendOptions {
  key: string;
  size: number;
  mimeType: string;
  filename: string;
  download?: boolean;
  tier?: StorageTier;
}

/**
 * 带 Range 支持的文件响应：音频拖动进度条、大图/PDF 分段加载都依赖它。
 * 只允许单段 range，多段（multipart/byteranges）回退为整文件，够用且实现简单。
 */
export function sendStoredFile(req: Request, res: Response, opts: SendOptions): void {
  const { key, size, mimeType, filename, download, tier = 'hot' } = opts;
  const disposition = `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', disposition);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (tier === 'cold') res.setHeader('X-Storage-Tier', 'cold');

  const range = req.header('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const startRaw = match[1];
      const endRaw = match[2];
      let start = startRaw ? Number(startRaw) : 0;
      let end = endRaw ? Number(endRaw) : size - 1;
      if (!startRaw && endRaw) {
        start = Math.max(0, size - Number(endRaw));
        end = size - 1;
      }
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
        end = Math.min(end, size - 1);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', String(end - start + 1));
        readStream(key, { start, end }, tier).pipe(res);
        return;
      }
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }
  }

  res.setHeader('Content-Length', String(size));
  readStream(key, undefined, tier).pipe(res);
}
