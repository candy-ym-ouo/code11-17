import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { config } from '../config';
import type { StorageTier } from '@heirloom/shared';

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

/** 某一存储层（热/冷）的根目录。 */
export function rootOf(tier: StorageTier = 'hot'): string {
  return tier === 'cold' ? config.COLD_STORAGE_ROOT : config.STORAGE_ROOT;
}

function resolveWithin(root: string, key: string): string {
  const target = path.join(root, key);
  const resolvedRoot = path.resolve(root);
  if (!path.resolve(target).startsWith(resolvedRoot)) {
    // 防御路径穿越：key 只可能由服务端生成，这里再兜一层
    throw new Error(`非法的存储 key: ${key}`);
  }
  return target;
}

export function absOf(key: string, tier: StorageTier = 'hot'): string {
  return resolveWithin(rootOf(tier), key);
}

export async function ensureDirs(): Promise<void> {
  for (const dir of [config.STORAGE_ROOT, config.COLD_STORAGE_ROOT, config.EXPORT_ROOT, config.BACKUP_ROOT]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  await fsp.mkdir(path.join(config.STORAGE_ROOT, 'tmp'), { recursive: true });
}

export async function putStream(key: string, source: Readable, tier: StorageTier = 'hot'): Promise<void> {
  const target = absOf(key, tier);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.part-${Date.now()}`;
  await pipeline(source, fs.createWriteStream(tmp));
  await fsp.rename(tmp, target);
}

export async function putBuffer(key: string, data: Buffer, tier: StorageTier = 'hot'): Promise<void> {
  const target = absOf(key, tier);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, data);
}

export function readStream(key: string, range?: { start: number; end: number }, tier: StorageTier = 'hot'): Readable {
  return createReadStream(absOf(key, tier), range);
}

export async function statObject(key: string, tier: StorageTier = 'hot'): Promise<{ size: number } | null> {
  try {
    const st = await fsp.stat(absOf(key, tier));
    return { size: st.size };
  } catch {
    return null;
  }
}

export async function exists(key: string, tier: StorageTier = 'hot'): Promise<boolean> {
  return (await statObject(key, tier)) !== null;
}

export async function remove(key: string, tier: StorageTier = 'hot'): Promise<void> {
  await fsp.rm(absOf(key, tier), { force: true });
}

export async function readJson<T>(key: string, tier: StorageTier = 'hot'): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(absOf(key, tier), 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function writeJson(key: string, value: unknown, tier: StorageTier = 'hot'): Promise<void> {
  await putBuffer(key, Buffer.from(JSON.stringify(value), 'utf8'), tier);
}

export async function moveIntoPlace(tmpPath: string, key: string, tier: StorageTier = 'hot'): Promise<void> {
  const target = absOf(key, tier);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.rename(tmpPath, target);
  } catch {
    // 跨设备时 rename 会失败，退化为复制后删除
    await fsp.copyFile(tmpPath, target);
    await fsp.rm(tmpPath, { force: true });
  }
}

/**
 * 在热/冷层之间搬移对象。冷层经常挂在另一块盘（跨设备），因此 rename 失败时退化为复制 + 校验后删除。
 * 返回目标层上的文件大小；源文件确认无误后才会被删掉，中途失败不丢数据。
 */
export async function moveBetweenTiers(key: string, from: StorageTier, to: StorageTier): Promise<number> {
  if (from === to) {
    const st = await statObject(key, from);
    if (!st) throw new Error(`源文件不存在: ${key}`);
    return st.size;
  }
  const src = absOf(key, from);
  const dst = absOf(key, to);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fsp.rename(src, dst);
  } catch {
    await fsp.copyFile(src, dst);
  }
  const [srcStat, dstStat] = await Promise.all([fsp.stat(src).catch(() => null), fsp.stat(dst)]);
  // 同盘 rename 后源已不存在；复制路径下比对大小一致才删源
  if (srcStat && srcStat.size !== dstStat.size) {
    await fsp.rm(dst, { force: true });
    throw new Error(`跨层搬移校验失败（大小不一致）: ${key}`);
  }
  if (srcStat) await fsp.rm(src, { force: true });
  return dstStat.size;
}

export function tmpDir(): string {
  return path.join(config.STORAGE_ROOT, 'tmp');
}

