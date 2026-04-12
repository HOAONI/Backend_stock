/** 股票分析模块中的实现文件，承载该领域的具体逻辑。 */

import { randomUUID } from 'node:crypto';

import { AgentRunPayload } from '@/common/agent/agent.types';
import { safeJsonStringify } from '@/common/utils/json';
import { AnalysisNewsItem, extractAnalysisNewsFromAgentRun } from './analysis-news';

export interface MappedAnalysis {
  queryId: string;
  stockCode: string;
  stockName: string;
  report: Record<string, unknown>;
  newsItems: AnalysisNewsItem[];
  historyRecord: {
    queryId: string;
    code: string;
    name: string;
    reportType: string;
    sentimentScore: number;
    operationAdvice: string;
    trendPrediction: string;
    analysisSummary: string;
    rawResult: string;
    newsContent: string | null;
    contextSnapshot: string;
    idealBuy: number | null;
    secondaryBuy: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
  };
}

function getCodeSnapshot(source: unknown, code: string): Record<string, unknown> {
  const table = (source as Record<string, unknown>) || {};
  return (table[code] as Record<string, unknown>) || {};
}

function parseOptionalNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function mapAgentRunToAnalysis(
  run: AgentRunPayload,
  stockCode: string,
  reportType: string,
  options?: { queryId?: string },
): MappedAnalysis {
  const queryId = String(options?.queryId || run.run_id || '').trim() || randomUUID().replace(/-/g, '');

  const dataSnapshot = getCodeSnapshot(run.data_snapshot, stockCode);
  const signalSnapshot = getCodeSnapshot(run.signal_snapshot, stockCode);
  const riskSnapshot = getCodeSnapshot(run.risk_snapshot, stockCode);
  const executionSnapshot = getCodeSnapshot(run.execution_snapshot, stockCode);

  const analysisContext = (dataSnapshot.analysis_context as Record<string, unknown>) || {};
  const realtimeQuote = (dataSnapshot.realtime_quote as Record<string, unknown>) || {};
  const aiPayload = (signalSnapshot.ai_payload as Record<string, unknown>) || {};

  const stockName =
    String(analysisContext.name || realtimeQuote.name || signalSnapshot.name || stockCode).trim() || stockCode;
  const sentimentScore = Number(signalSnapshot.sentiment_score ?? aiPayload.sentiment_score ?? 50);
  const operationAdvice = String(signalSnapshot.operation_advice || aiPayload.operation_advice || '观望').trim() || '观望';
  const trendPrediction = String(signalSnapshot.trend_signal || aiPayload.trend_prediction || '中性').trim() || '中性';

  const analysisSummary =
    String(
      aiPayload.analysis_summary ||
        aiPayload.summary ||
        signalSnapshot.error_message ||
        `${stockName} 当前建议为 ${operationAdvice}`,
    ).trim() || `${stockName} 当前建议为 ${operationAdvice}`;

  const sniperPoints = (aiPayload.sniper_points as Record<string, unknown>) || {};
  const extractedNews = extractAnalysisNewsFromAgentRun(run, stockCode);

  const idealBuy = parseOptionalNumber(sniperPoints.ideal_buy);
  const secondaryBuy = parseOptionalNumber(sniperPoints.secondary_buy);
  const stopLoss = parseOptionalNumber(signalSnapshot.stop_loss ?? sniperPoints.stop_loss);
  const takeProfit = parseOptionalNumber(signalSnapshot.take_profit ?? sniperPoints.take_profit);

  const currentPrice = parseOptionalNumber(realtimeQuote.price ?? analysisContext.current_price);
  const changePct = parseOptionalNumber(realtimeQuote.change_pct ?? analysisContext.change_pct);

  const report = {
    meta: {
      query_id: queryId,
      stock_code: stockCode,
      stock_name: stockName,
      report_type: reportType,
      created_at: new Date().toISOString(),
      current_price: currentPrice,
      change_pct: changePct,
    },
    summary: {
      analysis_summary: analysisSummary,
      operation_advice: operationAdvice,
      trend_prediction: trendPrediction,
      sentiment_score: sentimentScore,
      sentiment_label: undefined,
    },
    strategy: {
      ideal_buy: idealBuy != null ? String(idealBuy) : null,
      secondary_buy: secondaryBuy != null ? String(secondaryBuy) : null,
      stop_loss: stopLoss != null ? String(stopLoss) : null,
      take_profit: takeProfit != null ? String(takeProfit) : null,
    },
    details: {
      news_content: extractedNews.newsContent,
      raw_result: {
        agent_run: run,
        signal_snapshot: signalSnapshot,
        data_snapshot: dataSnapshot,
        risk_snapshot: riskSnapshot,
        execution_snapshot: executionSnapshot,
      },
      context_snapshot: {
        enhanced_context: analysisContext,
        realtime_quote_raw: realtimeQuote,
      },
    },
  };

  const historyRecord = {
    queryId,
    code: stockCode,
    name: stockName,
    reportType,
    sentimentScore,
    operationAdvice,
    trendPrediction,
    analysisSummary,
    rawResult: safeJsonStringify(report.details.raw_result),
    newsContent: extractedNews.newsContent,
    contextSnapshot: safeJsonStringify(report.details.context_snapshot),
    idealBuy,
    secondaryBuy,
    stopLoss,
    takeProfit,
  };

  return {
    queryId,
    stockCode,
    stockName,
    report,
    newsItems: extractedNews.items,
    historyRecord,
  };
}
