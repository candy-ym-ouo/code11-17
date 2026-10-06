/**
 * 容量字符串解析与格式化：配额设置用。
 * SI 后缀（1000 进制）与二进制后缀（1024 进制）都接受：
 *   500 / 500B / 100KB / 100 KiB / 1.5GB / 2TiB；'none' / '' 表示不限制。
 */

const SI = 1000;
const IEC = 1024;

export function parseBytes(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error('容量必须是非负数字');
    return Math.round(input);
  }
  const raw = input.trim();
  if (raw === '' || raw.toLowerCase() === 'none' || raw.toLowerCase() === 'unlimited') return null;

  const match = /^(\d+(?:\.\d+)?)\s*([kmgtpe]?)(i?b)?$/i.exec(raw);
  if (!match) {
    throw new Error(`无法解析容量：${input}（示例：500、100KB、1.5GiB、none 表示不限）`);
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? '').toUpperCase();
  const iec = (match[3] ?? '').toLowerCase().startsWith('i');
  // 裸写 K/M/G（不带 B）时按 1024 进制，符合运维习惯（如 1G = 2^30）
  const hasSuffix = Boolean(match[2]);
  const base = iec || (hasSuffix && !match[3]) ? IEC : SI;
  const powers: Record<string, number> = { '': 0, K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };
  const bytes = value * base ** powers[unit]!;
  if (bytes > Number.MAX_SAFE_INTEGER) throw new Error('容量超出可表示范围');
  return Math.round(bytes);
}

/** 人读格式，固定 IEC（1024）进制，例如 12.3 MiB。 */
export function formatBytes(bytes: number | bigint | null | undefined): string {
  if (bytes === null || bytes === undefined) return '不限';
  const n = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (n === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(IEC)));
  const value = n / IEC ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
