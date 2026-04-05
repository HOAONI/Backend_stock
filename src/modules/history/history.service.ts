/** 历史记录模块的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable } from '@nestjs/common';
import { AnalysisTaskStatus, Prisma } from '@prisma/client';

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

type HistoryListStatus = 'all' | 'completed' | 'failed';

interface HistoryListInput {
  stockCode?: string;
  startDate?: string;
  endDate?: string;
  status: HistoryListStatus;
  page: number;
  limit: number;
  scope: RequesterScope;
}

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class HistoryService {
  constructor(private readonly prisma: PrismaService) {}

  private buildOwnerFilter(scope: RequesterScope): { ownerUserId?: number } {
    if (scope.includeAll) {
      return {};
    }
    return { ownerUserId: scope.userId };
  }

  private buildDateRange(
    startDate?: string,
    endDate?: string,
  ): { completedAt: Prisma.DateTimeNullableFilter; createdAt: Prisma.DateTimeFilter } | null {
    if (!startDate && !endDate) {
      return null;
    }

    const completedAt: Prisma.DateTimeNullableFilter = {};
    const createdAt: Prisma.DateTimeFilter = {};

    if (startDate) {
      const start = new Date(`${startDate}T00:00:00`);
      completedAt.gte = start;
      createdAt.gte = start;
    }

    if (endDate) {
      const end = new Date(`${endDate}T00:00:00`);
      end.setDate(end.getDate() + 1);
      completedAt.lt = end;
      createdAt.lt = end;
    }

    return { completedAt, createdAt };
  }

  private buildCompletedWhere(input: Pick<HistoryListInput, 'stockCode' | 'startDate' | 'endDate' | 'scope'>): Prisma.AnalysisHistoryWhereInput {
    const where: Prisma.AnalysisHistoryWhereInput = {
      ...this.buildOwnerFilter(input.scope),
    };

    if (input.stockCode) {
      where.code = input.stockCode;
    }

    const range = this.buildDateRange(input.startDate, input.endDate);
    if (range) {
      where.createdAt = range.createdAt;
    }

    return where;
  }

  private buildFailedWhere(input: Pick<HistoryListInput, 'stockCode' | 'startDate' | 'endDate' | 'scope'>): Prisma.AnalysisTaskWhereInput {
    const where: Prisma.AnalysisTaskWhereInput = {
      ...this.buildOwnerFilter(input.scope),
      status: AnalysisTaskStatus.failed,
    };

    if (input.stockCode) {
      where.stockCode = input.stockCode;
    }

    const range = this.buildDateRange(input.startDate, input.endDate);
    if (range) {
      where.OR = [
        { completedAt: range.completedAt },
        {
          AND: [
            { completedAt: null },
            { createdAt: range.createdAt },
          ],
        },
      ];
    }

    return where;
  }

  private mapCompletedHistoryItem(row: {
    queryId: string | null;
    code: string;
    name: string | null;
    recordSource: string;
    reportType: string | null;
    sentimentScore: number | null;
    operationAdvice: string | null;
    createdAt: Date;
  }): Record<string, unknown> {
    return {
      query_id: row.queryId ?? '',
      task_id: row.queryId ?? null,
      stock_code: row.code,
      stock_name: row.name,
      record_source: row.recordSource,
      report_type: row.reportType,
      sentiment_score: row.sentimentScore,
      operation_advice: row.operationAdvice,
      status: 'completed',
      error_message: null,
      created_at: row.createdAt.toISOString(),
    };
  }

  private mapFailedHistoryItem(row: {
    taskId: string;
    stockCode: string;
    reportType: string;
    message: string | null;
    error: string | null;
    createdAt: Date;
    completedAt: Date | null;
  }): Record<string, unknown> {
    return {
      query_id: row.taskId,
      task_id: row.taskId,
      stock_code: row.stockCode,
      stock_name: null,
      record_source: 'analysis_center',
      report_type: row.reportType,
      sentiment_score: null,
      operation_advice: null,
      status: 'failed',
      error_message: row.error ?? row.message ?? '分析失败（无详细错误）',
      created_at: (row.completedAt ?? row.createdAt).toISOString(),
    };
  }

  async list(input: HistoryListInput): Promise<{ total: number; items: Array<Record<string, unknown>> }> {
    const normalizedStatus: HistoryListStatus = input.status === 'all' || input.status === 'failed'
      ? input.status
      : 'completed';

    const completedWhere = this.buildCompletedWhere(input);
    const failedWhere = this.buildFailedWhere(input);

    if (normalizedStatus === 'completed') {
      const total = await this.prisma.analysisHistory.count({ where: completedWhere });
      const rows = await this.prisma.analysisHistory.findMany({
        where: completedWhere,
        orderBy: { createdAt: 'desc' },
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      });

      return {
        total,
        items: rows.map(row => this.mapCompletedHistoryItem(row)),
      };
    }

    if (normalizedStatus === 'failed') {
      const total = await this.prisma.analysisTask.count({ where: failedWhere });
      const rows = await this.prisma.analysisTask.findMany({
        where: failedWhere,
        orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      });

      return {
        total,
        items: rows.map(row => this.mapFailedHistoryItem(row)),
      };
    }

    const mergeWindow = input.page * input.limit;
    const [completedTotal, completedRows, failedTotal, failedRows] = await Promise.all([
      this.prisma.analysisHistory.count({ where: completedWhere }),
      this.prisma.analysisHistory.findMany({
        where: completedWhere,
        orderBy: { createdAt: 'desc' },
        take: mergeWindow,
      }),
      this.prisma.analysisTask.count({ where: failedWhere }),
      this.prisma.analysisTask.findMany({
        where: failedWhere,
        orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
        take: mergeWindow,
      }),
    ]);

    const mergedItems = [
      ...completedRows.map(row => this.mapCompletedHistoryItem(row)),
      ...failedRows.map(row => this.mapFailedHistoryItem(row)),
    ].sort((left, right) => {
      const leftTime = new Date(String(left.created_at ?? '')).getTime();
      const rightTime = new Date(String(right.created_at ?? '')).getTime();
      return rightTime - leftTime;
    });

    const offset = (input.page - 1) * input.limit;
    return {
      total: completedTotal + failedTotal,
      items: mergedItems.slice(offset, offset + input.limit),
    };
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
        record_source: row.recordSource,
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
