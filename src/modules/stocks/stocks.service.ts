/** 股票数据模块的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable } from '@nestjs/common';

import { canonicalStockCode, toYahooSymbol } from '@/common/utils/stock-code';
import {
  buildIndicatorItems,
  computeFactorsAt,
  findNearestIndexByDate,
  sortBarsByDate,
  type IndicatorBar,
} from '@/common/utils/indicators';

interface YahooBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class StocksService {
  private normalizeWindows(windows: number[]): number[] {
    const cleaned = windows
      .map((item) => Math.trunc(Number(item)))
      .filter((item) => Number.isFinite(item) && item > 0 && item <= 250);

    const unique = Array.from(new Set(cleaned)).sort((a, b) => a - b);
    return unique.length > 0 ? unique : [5, 10, 20, 60];
  }

  private extractIndicatorBarsFromHistoryPayload(payload: Record<string, unknown>): IndicatorBar[] {
    const rows = (payload.data as Array<Record<string, unknown>> | undefined) ?? [];
    const bars: IndicatorBar[] = rows
      .map((item) => ({
        date: String(item.date ?? ''),
        open: item.open == null ? null : Number(item.open),
        high: item.high == null ? null : Number(item.high),
        low: item.low == null ? null : Number(item.low),
        close: item.close == null ? null : Number(item.close),
        volume: item.volume == null ? null : Number(item.volume),
      }))
      .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date));

    return sortBarsByDate(bars);
  }

  private async fetchYahooChartByRange(symbol: string, range: string, interval: string): Promise<any> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Yahoo request failed (${response.status})`);
    }

    const payload = (await response.json()) as any;
    if (!payload?.chart?.result?.[0]) {
      throw new Error('No chart result');
    }

    return payload.chart.result[0];
  }

  private async fetchYahooChartByPeriod(symbol: string, startDate: Date, endDate: Date, interval: string): Promise<any> {
    const period1 = Math.floor(startDate.getTime() / 1000);
    const period2 = Math.floor(endDate.getTime() / 1000);
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?period1=${period1}&period2=${period2}&interval=${encodeURIComponent(interval)}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Yahoo request failed (${response.status})`);
    }

    const payload = (await response.json()) as any;
    if (!payload?.chart?.result?.[0]) {
      throw new Error('No chart result');
    }

    return payload.chart.result[0];
  }

  private normalizeBars(result: any): YahooBar[] {
    const timestamps: number[] = result?.timestamp || [];
    const quote = result?.indicators?.quote?.[0] || {};
    const opens: Array<number | null> = quote.open || [];
    const highs: Array<number | null> = quote.high || [];
    const lows: Array<number | null> = quote.low || [];
    const closes: Array<number | null> = quote.close || [];
    const volumes: Array<number | null> = quote.volume || [];

    const rows: YahooBar[] = [];
    for (let i = 0; i < timestamps.length; i += 1) {
      const close = closes[i];
      if (close == null) {
        continue;
      }

      const date = new Date(timestamps[i] * 1000);
      rows.push({
        date: date.toISOString().slice(0, 10),
        open: opens[i] ?? close,
        high: highs[i] ?? close,
        low: lows[i] ?? close,
        close,
        volume: volumes[i] ?? null,
      });
    }

    return rows;
  }

  async getRealtimeQuote(stockCode: string): Promise<Record<string, unknown> | null> {
    const code = canonicalStockCode(stockCode);
    const symbol = toYahooSymbol(code);

    const result = await this.fetchYahooChartByRange(symbol, '1d', '1m');
    const meta = result?.meta || {};

    const price = Number(meta?.regularMarketPrice ?? meta?.previousClose ?? 0);
    if (!Number.isFinite(price) || price <= 0) {
      return null;
    }

    const prevClose = Number(meta?.previousClose ?? 0) || null;
    const change = prevClose && prevClose > 0 ? price - prevClose : null;
    const changePercent = prevClose && prevClose > 0 ? (change! / prevClose) * 100 : null;

    return {
      stock_code: code,
      stock_name: meta?.shortName || meta?.longName || code,
      current_price: price,
      change,
      change_percent: changePercent,
      open: Number(meta?.regularMarketOpen ?? 0) || null,
      high: Number(meta?.regularMarketDayHigh ?? 0) || null,
      low: Number(meta?.regularMarketDayLow ?? 0) || null,
      prev_close: prevClose,
      volume: Number(meta?.regularMarketVolume ?? 0) || null,
      amount: null,
      update_time: new Date().toISOString(),
    };
  }

  async getHistory(stockCode: string, days: number): Promise<Record<string, unknown>> {
    const code = canonicalStockCode(stockCode);
    const symbol = toYahooSymbol(code);
    const range = `${Math.max(days * 2, 30)}d`;

    const result = await this.fetchYahooChartByRange(symbol, range, '1d');
    const bars = this.normalizeBars(result).slice(-days);

    let previousClose: number | null = null;
    const data = bars.map((bar) => {
      const row = {
        date: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        amount: null,
        change_percent: previousClose && previousClose > 0 ? ((bar.close - previousClose) / previousClose) * 100 : null,
      };
      previousClose = bar.close;
      return row;
    });

    return {
      stock_code: code,
      stock_name: result?.meta?.shortName || result?.meta?.longName || code,
      period: 'daily',
      data,
    };
  }

  async getIndicators(stockCode: string, days: number, windows: number[]): Promise<Record<string, unknown>> {
    const normalizedWindows = this.normalizeWindows(windows);
    const historyPayload = await this.getHistory(stockCode, days);
    const bars = this.extractIndicatorBarsFromHistoryPayload(historyPayload);

    return {
      stock_code: historyPayload.stock_code,
      period: 'daily',
      days,
      windows: normalizedWindows,
      items: buildIndicatorItems(bars, normalizedWindows),
    };
  }

  async getFactors(stockCode: string, date?: string): Promise<Record<string, unknown>> {
    const lookbackDays = 365;
    const historyPayload = await this.getHistory(stockCode, lookbackDays);
    const bars = this.extractIndicatorBarsFromHistoryPayload(historyPayload);

    const index = findNearestIndexByDate(bars, date);
    if (index < 0) {
      throw new Error('No available daily bar for the specified date');
    }

    const factors = computeFactorsAt(bars, index);
    return {
      stock_code: historyPayload.stock_code,
      date: bars[index].date,
      factors: {
        ma5: factors.ma5,
        ma10: factors.ma10,
        ma20: factors.ma20,
        ma60: factors.ma60,
        rsi14: factors.rsi14,
        momentum20: factors.momentum20,
        volRatio5: factors.volRatio5,
        amplitude: factors.amplitude,
      },
    };
  }

  async getBarsByDateRange(stockCode: string, startDate: Date, endDate: Date): Promise<YahooBar[]> {
    const code = canonicalStockCode(stockCode);
    const symbol = toYahooSymbol(code);

    const result = await this.fetchYahooChartByPeriod(symbol, startDate, endDate, '1d');
    return this.normalizeBars(result);
  }

  async getStartAndForwardBars(stockCode: string, analysisDate: Date, evalWindowDays: number): Promise<{
    startDate: Date | null;
    startPrice: number | null;
    forwardBars: Array<{ date: Date; high: number | null; low: number | null; close: number | null }>;
  }> {
    const start = new Date(analysisDate);
    start.setDate(start.getDate() - 20);
    const end = new Date(analysisDate);
    end.setDate(end.getDate() + Math.max(evalWindowDays * 3, 60));

    const bars = await this.getBarsByDateRange(stockCode, start, end);
    const normalized = bars.map((bar) => ({
      date: new Date(`${bar.date}T00:00:00Z`),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    }));

    const startBar = normalized
      .filter((bar) => bar.date <= analysisDate)
      .sort((a, b) => b.date.getTime() - a.date.getTime())[0];

    const forwardBars = normalized
      .filter((bar) => startBar && bar.date > startBar.date)
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .slice(0, evalWindowDays)
      .map((bar) => ({ date: bar.date, high: bar.high, low: bar.low, close: bar.close }));

    return {
      startDate: startBar?.date ?? null,
      startPrice: startBar?.close ?? null,
      forwardBars,
    };
  }
}
