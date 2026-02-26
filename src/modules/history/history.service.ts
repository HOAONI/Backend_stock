import { Injectable } from '@nestjs/common';

import { PrismaService } from '@/common/database/prisma.service';
import { safeJsonParse } from '@/common/utils/json';
import type { RequesterScope } from '@/modules/analysis/analysis.service';

function sentimentLabel(score: number): string {
  if (score >= 80) return '极度乐观';
  if (score >= 60) return '乐观';
  if (score >= 40) return '中性';
  if (score >= 20) return '悲观';
  return '极度悲观';
}

@Injectable()
export class HistoryService {
  constructor(private readonly prisma: PrismaService) {}

  private buildOwnerFilter(scope: RequesterScope): { ownerUserId?: number } {
    if (scope.includeAll) {
      return {};
    }
    return { ownerUserId: scope.userId };
  }

  async list(input: {
    stockCode?: string;
    startDate?: string;
    endDate?: string;
    page: number;
    limit: number;
    scope: RequesterScope;
  }): Promise<{ total: number; items: Array<Record<string, unknown>> }> {
    const where: Record<string, unknown> = {
      ...this.buildOwnerFilter(input.scope),
    };
    if (input.stockCode) {
      where.code = input.stockCode;
    }

    if (input.startDate || input.endDate) {
      const createdAt: Record<string, Date> = {};
      if (input.startDate) {
        createdAt.gte = new Date(`${input.startDate}T00:00:00`);
      }
      if (input.endDate) {
        const end = new Date(`${input.endDate}T00:00:00`);
        end.setDate(end.getDate() + 1);
        createdAt.lt = end;
      }
      where.createdAt = createdAt;
    }

    const total = await this.prisma.analysisHistory.count({ where });
    const rows = await this.prisma.analysisHistory.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (input.page - 1) * input.limit,
      take: input.limit,
    });

    const items = rows.map((row) => ({
      query_id: row.queryId ?? '',
      stock_code: row.code,
      stock_name: row.name,
      report_type: row.reportType,
      sentiment_score: row.sentimentScore,
      operation_advice: row.operationAdvice,
      created_at: row.createdAt.toISOString(),
    }));

    return { total, items };
  }

  async detail(queryId: string, scope: RequesterScope): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.analysisHistory.findFirst({
      where: {
        queryId,
        ...this.buildOwnerFilter(scope),
      },
    });
    if (!row) return null;

    const contextSnapshot = safeJsonParse<Record<string, unknown> | null>(row.contextSnapshot, null);
    const rawResult = safeJsonParse<Record<string, unknown> | string | null>(row.rawResult, row.rawResult);

    const enhancedContext = ((contextSnapshot as Record<string, any> | null)?.enhanced_context ?? {}) as Record<string, any>;
    const realtimeFromEnhanced = (enhancedContext?.realtime ?? {}) as Record<string, any>;
    const realtimeQuoteRaw = ((contextSnapshot as Record<string, any> | null)?.realtime_quote_raw ?? {}) as Record<string, any>;

    const currentPrice = realtimeFromEnhanced?.price ?? enhancedContext?.price ?? realtimeQuoteRaw?.price ?? null;
    const changePct =
      realtimeFromEnhanced?.change_pct ??
      realtimeFromEnhanced?.change_60d ??
      enhancedContext?.change_pct ??
      realtimeQuoteRaw?.change_pct ??
      realtimeQuoteRaw?.pct_chg ??
      null;

    return {
      meta: {
        query_id: row.queryId ?? queryId,
        stock_code: row.code,
        stock_name: row.name,
        report_type: row.reportType,
        created_at: row.createdAt.toISOString(),
        current_price: currentPrice != null ? Number(currentPrice) : null,
        change_pct: changePct != null ? Number(changePct) : null,
      },
      summary: {
        analysis_summary: row.analysisSummary,
        operation_advice: row.operationAdvice,
        trend_prediction: row.trendPrediction,
        sentiment_score: row.sentimentScore,
        sentiment_label: sentimentLabel(row.sentimentScore ?? 50),
      },
      strategy: {
        ideal_buy: row.idealBuy != null ? String(row.idealBuy) : null,
        secondary_buy: row.secondaryBuy != null ? String(row.secondaryBuy) : null,
        stop_loss: row.stopLoss != null ? String(row.stopLoss) : null,
        take_profit: row.takeProfit != null ? String(row.takeProfit) : null,
      },
      details: {
        news_content: row.newsContent,
        raw_result: rawResult,
        context_snapshot: contextSnapshot,
      },
    };
  }

  async getNews(queryId: string, limit: number, scope: RequesterScope): Promise<Array<Record<string, string>>> {
    const rows = await this.prisma.newsIntel.findMany({
      where: {
        queryId,
        ...this.buildOwnerFilter(scope),
      },
      orderBy: [{ publishedDate: 'desc' }, { fetchedAt: 'desc' }],
      take: limit,
    });

    return rows.map((row) => ({
      title: row.title,
      snippet: row.snippet ?? '',
      url: row.url,
    }));
  }
}
