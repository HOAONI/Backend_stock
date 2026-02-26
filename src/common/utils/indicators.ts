export interface IndicatorBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface FactorSnapshot {
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  rsi14: number | null;
  momentum20: number | null;
  volRatio5: number | null;
  amplitude: number | null;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function toNumber(value: unknown): number | null {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return null;
  }
  return numberValue;
}

function average(values: Array<number | null>): number | null {
  const filtered = values.filter((item): item is number => item != null);
  if (filtered.length === 0) {
    return null;
  }
  const total = filtered.reduce((sum, item) => sum + item, 0);
  return total / filtered.length;
}

export function sortBarsByDate(bars: IndicatorBar[]): IndicatorBar[] {
  return [...bars].sort((a, b) => a.date.localeCompare(b.date));
}

export function computeMovingAverageAt(bars: IndicatorBar[], index: number, window: number): number | null {
  if (window <= 0 || index + 1 < window) {
    return null;
  }

  const start = index + 1 - window;
  const closes = bars.slice(start, index + 1).map((item) => toNumber(item.close));
  const result = average(closes);
  return result == null ? null : round(result);
}

export function computeRsi14At(bars: IndicatorBar[], index: number): number | null {
  if (index < 14) {
    return null;
  }

  const closes = bars.slice(0, index + 1).map((item) => toNumber(item.close));
  if (closes.some((item) => item == null)) {
    return null;
  }

  const numericCloses = closes as number[];
  const deltas: number[] = [];
  for (let i = 1; i < numericCloses.length; i += 1) {
    deltas.push(numericCloses[i] - numericCloses[i - 1]);
  }

  let gain = 0;
  let loss = 0;
  for (let i = 0; i < 14; i += 1) {
    const delta = deltas[i];
    if (delta >= 0) gain += delta;
    else loss += Math.abs(delta);
  }

  let avgGain = gain / 14;
  let avgLoss = loss / 14;

  for (let i = 14; i < deltas.length; i += 1) {
    const delta = deltas[i];
    const currentGain = delta > 0 ? delta : 0;
    const currentLoss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = (avgGain * 13 + currentGain) / 14;
    avgLoss = (avgLoss * 13 + currentLoss) / 14;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;
  return round(100 - 100 / (1 + rs));
}

export function computeMomentum20At(bars: IndicatorBar[], index: number): number | null {
  if (index < 20) {
    return null;
  }

  const current = toNumber(bars[index]?.close);
  const base = toNumber(bars[index - 20]?.close);
  if (current == null || base == null || base === 0) {
    return null;
  }

  return round(((current / base) - 1) * 100);
}

export function computeVolRatio5At(bars: IndicatorBar[], index: number): number | null {
  if (index < 4) {
    return null;
  }

  const currentVolume = toNumber(bars[index]?.volume);
  if (currentVolume == null) {
    return null;
  }

  const volumes = bars.slice(index - 4, index + 1).map((item) => toNumber(item.volume));
  const avgVolume = average(volumes);
  if (avgVolume == null || avgVolume === 0) {
    return null;
  }

  return round(currentVolume / avgVolume);
}

export function computeAmplitudeAt(bars: IndicatorBar[], index: number): number | null {
  const row = bars[index];
  if (!row) {
    return null;
  }

  const open = toNumber(row.open);
  const high = toNumber(row.high);
  const low = toNumber(row.low);
  if (open == null || high == null || low == null || open === 0) {
    return null;
  }

  return round(((high - low) / open) * 100);
}

export function computeFactorsAt(bars: IndicatorBar[], index: number): FactorSnapshot {
  return {
    ma5: computeMovingAverageAt(bars, index, 5),
    ma10: computeMovingAverageAt(bars, index, 10),
    ma20: computeMovingAverageAt(bars, index, 20),
    ma60: computeMovingAverageAt(bars, index, 60),
    rsi14: computeRsi14At(bars, index),
    momentum20: computeMomentum20At(bars, index),
    volRatio5: computeVolRatio5At(bars, index),
    amplitude: computeAmplitudeAt(bars, index),
  };
}

export function buildIndicatorItems(
  bars: IndicatorBar[],
  windows: number[],
): Array<{ date: string; close: number | null; mas: Record<string, number | null> }> {
  const uniqueWindows = Array.from(new Set(windows.filter((item) => Number.isFinite(item) && item > 0)))
    .map((item) => Math.trunc(item))
    .sort((a, b) => a - b);

  return bars.map((row, index) => {
    const mas: Record<string, number | null> = {};
    for (const window of uniqueWindows) {
      mas[`ma${window}`] = computeMovingAverageAt(bars, index, window);
    }

    return {
      date: row.date,
      close: toNumber(row.close),
      mas,
    };
  });
}

export function findNearestIndexByDate(bars: IndicatorBar[], date?: string): number {
  if (bars.length === 0) {
    return -1;
  }

  if (!date) {
    return bars.length - 1;
  }

  const normalized = date.slice(0, 10);
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (bars[i].date <= normalized) {
      return i;
    }
  }

  return -1;
}
