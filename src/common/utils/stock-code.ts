/** 通用工具集合中的实现文件，承载该领域的具体逻辑。 */

export function canonicalStockCode(code: string): string {
  return (code ?? '').trim().toUpperCase();
}

export function normalizeAShareStockCode(code: string): string | null {
  const c = canonicalStockCode(code);

  if (/^\d{6}$/.test(c)) {
    return c;
  }

  if (/^(SH|SZ)\d{6}$/.test(c)) {
    return c.slice(2);
  }

  if (/^\d{6}\.(SH|SZ|SS)$/.test(c)) {
    return c.slice(0, 6);
  }

  return null;
}

export function isAShareStockCode(code: string): boolean {
  return normalizeAShareStockCode(code) != null;
}

export function toTencentSymbol(code: string): string {
  const normalized = normalizeAShareStockCode(code);
  if (!normalized) {
    throw new Error('A股行情页仅支持 SH/SZ/6 位代码');
  }

  if (normalized.startsWith('6') || normalized.startsWith('5') || normalized.startsWith('9')) {
    return `sh${normalized}`;
  }

  return `sz${normalized}`;
}
