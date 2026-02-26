export function canonicalStockCode(code: string): string {
  return (code ?? '').trim().toUpperCase();
}

export function toYahooSymbol(code: string): string {
  const c = canonicalStockCode(code);

  if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(c)) {
    return c;
  }

  if (/^\d{5}$/.test(c)) {
    return `${c}.HK`;
  }

  if (/^\d{6}$/.test(c)) {
    if (c.startsWith('6')) {
      return `${c}.SS`;
    }
    return `${c}.SZ`;
  }

  return c;
}
