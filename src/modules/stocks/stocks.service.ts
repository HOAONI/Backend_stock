/** 股票数据模块的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable } from '@nestjs/common';

import { AgentClientService } from '@/common/agent/agent-client.service';
import { normalizeAShareStockCode } from '@/common/utils/stock-code';
import { SystemConfigService } from '@/modules/system-config/system-config.service';

import { StocksUpstreamError, StocksValidationError } from './stocks.errors';

interface DailyBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
}

/** 负责承接该领域的核心业务编排，把数据库访问、业务规则和外部调用收拢到一处。 */
@Injectable()
export class StocksService {
  constructor(
    private readonly agentClientService: AgentClientService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  private normalizeWindows(windows: number[]): number[] {
    const cleaned = windows
      .map((item) => Math.trunc(Number(item)))
      .filter((item) => Number.isFinite(item) && item > 0 && item <= 250);

    const unique = Array.from(new Set(cleaned)).sort((a, b) => a - b);
    return unique.length > 0 ? unique : [5, 10, 20, 60];
  }

  private requireAShareCode(stockCode: string): string {
    const normalized = normalizeAShareStockCode(stockCode);
    if (!normalized) {
      throw new StocksValidationError('A股行情页仅支持 SH/SZ/6 位代码');
    }
    return normalized;
  }

  private async resolveMarketSource(): Promise<string> {
    return await this.systemConfigService.getCurrentMarketSource();
  }

  private wrapUpstreamError(error: unknown, fallback: string): never {
    const message = String((error as Error | undefined)?.message ?? '').trim();
    throw new StocksUpstreamError(message || fallback);
  }

  private toNumber(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private extractBarsFromHistoryPayload(payload: Record<string, unknown>): DailyBar[] {
    const rows = (payload.data as Array<Record<string, unknown>> | undefined) ?? [];
    return rows
      .map((row) => ({
        date: String(row.date ?? ''),
        open: this.toNumber(row.open),
        high: this.toNumber(row.high),
        low: this.toNumber(row.low),
        close: this.toNumber(row.close),
      }))
      .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async getRealtimeQuote(stockCode: string): Promise<Record<string, unknown>> {
    const code = this.requireAShareCode(stockCode);
    const marketSource = await this.resolveMarketSource();

    try {
      return await this.agentClientService.getInternalStockQuote(code, marketSource);
    } catch (error: unknown) {
      this.wrapUpstreamError(error, '获取实时行情失败');
    }
  }

  async getHistory(stockCode: string, days: number): Promise<Record<string, unknown>> {
    const code = this.requireAShareCode(stockCode);
    const marketSource = await this.resolveMarketSource();

    try {
      return await this.agentClientService.getInternalStockHistory(code, marketSource, days);
    } catch (error: unknown) {
      this.wrapUpstreamError(error, '获取历史行情失败');
    }
  }

  async getIndicators(stockCode: string, days: number, windows: number[]): Promise<Record<string, unknown>> {
    const code = this.requireAShareCode(stockCode);
    const marketSource = await this.resolveMarketSource();
    const normalizedWindows = this.normalizeWindows(windows);

    try {
      return await this.agentClientService.getInternalStockIndicators(code, marketSource, days, normalizedWindows);
    } catch (error: unknown) {
      this.wrapUpstreamError(error, '获取指标数据失败');
    }
  }

  async getFactors(stockCode: string, date?: string): Promise<Record<string, unknown>> {
    const code = this.requireAShareCode(stockCode);
    const marketSource = await this.resolveMarketSource();

    try {
      return await this.agentClientService.getInternalStockFactors(code, marketSource, date);
    } catch (error: unknown) {
      this.wrapUpstreamError(error, '获取因子数据失败');
    }
  }

  async getBarsByDateRange(stockCode: string, startDate: Date, endDate: Date): Promise<DailyBar[]> {
    const code = this.requireAShareCode(stockCode);
    const rangeDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000) + 1);
    const historyPayload = await this.getHistory(code, Math.min(Math.max(rangeDays * 2, 60), 365));
    return this.extractBarsFromHistoryPayload(historyPayload).filter((bar) => {
      const time = new Date(`${bar.date}T00:00:00Z`).getTime();
      return time >= startDate.getTime() && time <= endDate.getTime();
    });
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
