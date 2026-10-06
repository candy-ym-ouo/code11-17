import { describe, expect, it } from 'vitest';
import { formatBytes, parseBytes } from './bytes';

describe('parseBytes', () => {
  it('裸数字按字节', () => {
    expect(parseBytes(1024)).toBe(1024);
    expect(parseBytes('500')).toBe(500);
  });

  it('SI 十进制后缀', () => {
    expect(parseBytes('1KB')).toBe(1000);
    expect(parseBytes('1MB')).toBe(1_000_000);
    expect(parseBytes('1.5GB')).toBe(1_500_000_000);
  });

  it('IEC 二进制后缀与裸 K/M/G', () => {
    expect(parseBytes('1KiB')).toBe(1024);
    expect(parseBytes('1K')).toBe(1024);
    expect(parseBytes('2GiB')).toBe(2 * 1024 ** 3);
  });

  it('none / 空串 → null（不限）', () => {
    expect(parseBytes('none')).toBeNull();
    expect(parseBytes('')).toBeNull();
    expect(parseBytes(null)).toBeNull();
  });

  it('非法输入抛错', () => {
    expect(() => parseBytes('abc')).toThrow();
    expect(() => parseBytes('-5')).toThrow();
  });
});

describe('formatBytes', () => {
  it('常见值', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GiB');
    expect(formatBytes(null)).toBe('不限');
  });

  it('parse → format 对规整输入稳定', () => {
    expect(formatBytes(parseBytes('1.5GiB'))).toBe('1.5 GiB');
    expect(formatBytes(parseBytes('2 GiB'))).toBe('2.0 GiB');
    expect(parseBytes('100MB')).toBe(100_000_000);
  });
});
