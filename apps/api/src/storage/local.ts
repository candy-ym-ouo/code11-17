import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { config } from '../config';

export interface StoredObject {
  key: string;
  absPath: string;
  sha256: string;
  size: number;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
};

export function extensionFor(mime: string): string {
  return EXT_BY_MIME[mime] ?? 'bin';
}

/** 内容寻址路径：families/<fid>/objects/<sha 前两位>/<sha>.<ext>，天然去重且可校验。 */
export function objectKey(familyId: string, sha256: string, mime: string): string {
  return path.posix.join('families', familyId, 'objects', sha256.slice(0, 2), `${sha256}.${extensionFor(mime)}`);
}

export function derivedKey(familyId: string, sha256: string, suffix: string): string {
  return path.posix.join('families', familyId, 'derived', sha256.slice(0, 2), `${sha256}${suffix}`);
}

/**
 * 冷热层路径：
 *   热：families/<fid>/objects/<xx>/<sha>.<ext>
 *   冷：families/<fid>/cold/objects/<xx>/<sha>.<ext>
 * 派生文件（缩略图/转码/波形）始终留在热层，冷层只放原片。
 */
const COLD_SEG = '/cold/';

export function toColdKey(key: string): string {
  const parts = key.split('/');
  // families/<fid>/objects/... → families/<fid>/cold/objects/...
  if (parts.length < 3 || parts[2] !== 'objects') {
    throw new Error(`非热层原片 key，不能降冷: ${key}`);
  }
  parts.splice(2, 0, 'cold');
  return parts.join('/');
}

export function toHotKey(key: string): string {
  const parts = key.split('/');
  if (parts.length < 4 || parts[2] !== 'cold' || parts[3] !== 'objects') {
    throw new Error(`非冷层原片 key，不能回暖: ${key}`);
  }
  parts.splice(2, 1);
  return parts.join('/');
}

export function isColdKey(key: string): boolean {
  return key.includes(COLD_SEG);
}

export function absOf(key: string): string {
  const target = path.join(config.STORAGE_ROOT, key);
  const root = path.resolve(config.STORAGE_ROOT);
  if (!path.resolve(target).startsWith(root)) {
    // 防御路径穿越：key 只可能由服务端生成，这里再兜一层
    throw new Error(`非法的存储 key: ${key}`);
  }
  return target;
}

export async function ensureDirs(): Promise<void> {
  for (const dir of [config.STORAGE_ROOT, config.EXPORT_ROOT, config.BACKUP_ROOT]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  await fsp.mkdir(path.join(config.STORAGE_ROOT, 'tmp'), { recursive: true });
}

export async function putStream(key: string, source: Readable): Promise<void> {
  const target = absOf(key);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.part-${Date.now()}`;
  await pipeline(source, fs.createWriteStream(tmp));
  await fsp.rename(tmp, target);
}

export async function putBuffer(key: string, data: Buffer): Promise<void> {
  const target = absOf(key);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, data);
}

export function readStream(key: string, range?: { start: number; end: number }): Readable {
  return createReadStream(absOf(key), range);
}

export async function statObject(key: string): Promise<{ size: number } | null> {
  try {
    const st = await fsp.stat(absOf(key));
    return { size: st.size };
  } catch {
    return null;
  }
}

export async function exists(key: string): Promise<boolean> {
  return (await statObject(key)) !== null;
}

export async function remove(key: string): Promise<void> {
  await fsp.rm(absOf(key), { force: true });
}

export async function readJson<T>(key: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(absOf(key), 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function writeJson(key: string, value: unknown): Promise<void> {
  await putBuffer(key, Buffer.from(JSON.stringify(value), 'utf8'));
}

export async function moveIntoPlace(tmpPath: string, key: string): Promise<void> {
  const target = absOf(key);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.rename(tmpPath, target);
  } catch {
    // 跨设备时 rename 会失败，退化为复制后删除
    await fsp.copyFile(tmpPath, target);
    await fsp.rm(tmpPath, { force: true });
  }
}

export function tmpDir(): string {
  return path.join(config.STORAGE_ROOT, 'tmp');
}

/**
 * 在存储根内把一个 key 搬到另一个 key（热↔冷分层用）。
 * 目标已存在时视为成功（内容寻址：同 key 即同内容，可能是上次执行中断留下的）。
 * 跨设备时退化为复制+删除；目标父目录自动创建。
 */
export async function moveKey(srcKey: string, dstKey: string): Promise<'moved' | 'already-present'> {
  const src = absOf(srcKey);
  const dst = absOf(dstKey);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fsp.rename(src, dst);
    return 'moved';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await fsp.copyFile(src, dst);
      await fsp.rm(src, { force: true });
      return 'moved';
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // 源文件不在：若目标已经在位（中断恢复场景），幂等成功
      if (await exists(dstKey)) return 'already-present';
      throw err;
    }
    if ((err as NodeJS.ErrnoException).code === 'EEXIST' || (await exists(dstKey))) {
      // rename 撞目标或目标已在：内容寻址同名即同内容，移除源即可
      await fsp.rm(src, { force: true });
      return 'already-present';
    }
    throw err;
  }
}

