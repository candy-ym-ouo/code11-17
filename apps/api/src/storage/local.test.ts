import path from 'node:path';
import fs from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../config';
import { exists, moveKey, putBuffer, remove, toColdKey, toHotKey, isColdKey } from './local';

const KEY = 'families/fam1/objects/ab/abcdef0123.jpg';
const COLD = 'families/fam1/cold/objects/ab/abcdef0123.jpg';

describe('冷热 key 路径', () => {
  it('热→冷→热 往返', () => {
    expect(toColdKey(KEY)).toBe(COLD);
    expect(toHotKey(COLD)).toBe(KEY);
    expect(isColdKey(COLD)).toBe(true);
    expect(isColdKey(KEY)).toBe(false);
  });

  it('派生 key 不允许降冷', () => {
    expect(() => toColdKey('families/fam1/derived/ab/abc.webp')).toThrow();
  });

  it('非法方向抛错', () => {
    expect(() => toHotKey(KEY)).toThrow();
    expect(() => toColdKey(COLD)).toThrow();
  });
});

describe('moveKey 物理搬运', () => {
  const tmpRoot = path.join(config.STORAGE_ROOT, '..', 'test-move-uploads');
  beforeAll(async () => {
    await fs.mkdir(tmpRoot, { recursive: true });
    await putBuffer(KEY, Buffer.from('hello-tier'));
  });
  afterAll(async () => {
    await remove(KEY);
    await remove(COLD);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('热→冷移动后源消失、目标存在；再执行幂等', async () => {
    expect(await moveKey(KEY, COLD)).toBe('moved');
    expect(await exists(KEY)).toBe(false);
    expect(await exists(COLD)).toBe(true);
    expect(await moveKey(KEY, COLD)).toBe('already-present');
  });

  it('冷→热回暖', async () => {
    expect(await moveKey(COLD, KEY)).toBe('moved');
    expect(await exists(KEY)).toBe(true);
    expect(await exists(COLD)).toBe(false);
  });
});
