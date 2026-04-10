/** 回测模块的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BacktestAgentClientService } from '@/common/agent/backtest-agent-client.service';
import { PrismaService } from '@/common/database/prisma.service';
import { safeJsonParse, safeJsonStringify } from '@/common/utils/json';
import {
  BACKTEST_COMPARE_STRATEGY_CODES,
  BACKTEST_COMPARE_STRATEGY_NAMES,
  BacktestCompareStrategyCode,
  DEFAULT_BACKTEST_COMPARE_STRATEGY_CODES,
} from './backtest-compare-strategies';
import {
  BACKTEST_STRATEGY_CODES,
  BACKTEST_STRATEGY_NAMES,
  BacktestStrategyCode,
  DEFAULT_BACKTEST_STRATEGY_CODES,
  resolveLegacyBacktestStrategy,
} from './backtest-strategy-strategies';
import {
  BacktestStrategyTemplateCode,
  getBacktestStrategyTemplateName,
  isBacktestStrategyTemplateCode,
  normalizeBacktestStrategyParams,
} from './backtest-strategy-templates';
import { BacktestAiInterpretationService } from './backtest-ai-interpretation.service';
import { UserBacktestStrategyService } from './user-backtest-strategy.service';

export const OVERALL_SENTINEL_CODE = '__overall__';
type StrategyAiInterpretationJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => item as Record<string, unknown>);
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

interface ServiceError extends Error {
  code?: string;
}

function buildServiceError(code: string, message: string): ServiceError {
  const error = new Error(message) as ServiceError;
  error.code = code;
  return error;
}

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly backtestAgentClient: BacktestAgentClientService,
    private readonly userBacktestStrategyService: UserBacktestStrategyService,
    private readonly backtestAiInterpretationService: BacktestAiInterpretationService = {} as BacktestAiInterpretationService,
  ) {}

  private toNumber(value: unknown): number | null {
    if (value == null) {
      return null;
    }
    if (typeof value === 'string' && value.trim().length === 0) {
      return null;
    }
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return null;
    }
    return num;
  }

  private toBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return null;
  }

  private toDate(value: unknown): Date | null {
    if (value == null) {
      return null;
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    const text = String(value).trim();
    if (!text) {
      return null;
    }

    const parsed = new Date(text.length >= 10 ? `${text.slice(0, 10)}T00:00:00Z` : text);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  }

  private toDateTime(value: unknown): Date | null {
    if (value == null) {
      return null;
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    const text = String(value).trim();
    if (!text) {
      return null;
    }

    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  }

  private buildOwnerFilter(scope: { userId: number; includeAll: boolean }): Prisma.BacktestResultWhereInput {
    if (scope.includeAll) {
      return {};
    }
    return { ownerUserId: scope.userId };
  }

  // 老历史记录里没有独立 analysis_date 时，优先从 context_snapshot 取交易日，否则退回 createdAt 的 UTC 日期。
  private resolveAnalysisDate(contextSnapshot: string | null, createdAt: Date): Date {
    const payload = safeJsonParse<Record<string, any> | null>(contextSnapshot, null);
    const dateString = payload?.enhanced_context?.date;
    if (typeof dateString === 'string' && dateString.length >= 10) {
      const parsed = new Date(`${dateString.slice(0, 10)}T00:00:00Z`);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return new Date(Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), createdAt.getUTCDate()));
  }

  private mapSummary(summary: {
    scope: string;
    code: string | null;
    evalWindowDays: number;
    engineVersion: string;
    computedAt?: Date;
    totalEvaluations: number;
    completedCount: number;
    insufficientCount: number;
    longCount: number;
    cashCount: number;
    winCount: number;
    lossCount: number;
    neutralCount: number;
    directionAccuracyPct: number | null;
    predictionWinRatePct: number | null;
    tradeWinRatePct: number | null;
    winRatePct: number | null;
    neutralRatePct: number | null;
    avgStockReturnPct: number | null;
    avgSimulatedReturnPct: number | null;
    stopLossTriggerRate: number | null;
    takeProfitTriggerRate: number | null;
    ambiguousRate: number | null;
    avgDaysToFirstHit: number | null;
    adviceBreakdown: unknown;
    diagnostics: unknown;
  }): Record<string, unknown> {
    return {
      scope: summary.scope,
      code: summary.code === OVERALL_SENTINEL_CODE ? null : summary.code,
      eval_window_days: summary.evalWindowDays,
      engine_version: summary.engineVersion,
      computed_at: (summary.computedAt ?? new Date()).toISOString(),
      total_evaluations: summary.totalEvaluations,
      completed_count: summary.completedCount,
      insufficient_count: summary.insufficientCount,
      long_count: summary.longCount,
      cash_count: summary.cashCount,
      win_count: summary.winCount,
      loss_count: summary.lossCount,
      neutral_count: summary.neutralCount,
      direction_accuracy_pct: summary.directionAccuracyPct,
      prediction_win_rate_pct: summary.predictionWinRatePct,
      trade_win_rate_pct: summary.tradeWinRatePct,
      win_rate_pct: summary.winRatePct,
      neutral_rate_pct: summary.neutralRatePct,
      avg_stock_return_pct: summary.avgStockReturnPct,
      avg_simulated_return_pct: summary.avgSimulatedReturnPct,
      stop_loss_trigger_rate: summary.stopLossTriggerRate,
      take_profit_trigger_rate: summary.takeProfitTriggerRate,
      ambiguous_rate: summary.ambiguousRate,
      avg_days_to_first_hit: summary.avgDaysToFirstHit,
      advice_breakdown: summary.adviceBreakdown,
      diagnostics: summary.diagnostics,
      metric_definition_version: 'v2',
    };
  }

  private defaultEvalWindowDays(): number {
    return Number(process.env.BACKTEST_EVAL_WINDOW_DAYS ?? 10);
  }

  private resolveScopeCode(scope: 'overall' | 'stock', code?: string): string {
    return scope === 'overall' ? OVERALL_SENTINEL_CODE : String(code ?? '').trim();
  }

  private buildScopeWhere(input: {
    scope: 'overall' | 'stock';
    code?: string;
    evalWindowDays: number;
    requester: { userId: number; includeAll: boolean };
  }): Prisma.BacktestResultWhereInput {
    const where: Prisma.BacktestResultWhereInput = {
      engineVersion: String(process.env.BACKTEST_ENGINE_VERSION ?? 'v1'),
      evalWindowDays: input.evalWindowDays,
      ...(input.requester.includeAll ? {} : { ownerUserId: input.requester.userId }),
    };

    if (input.scope === 'stock') {
      where.code = this.resolveScopeCode('stock', input.code);
    }

    return where;
  }

  private isCompareStrategyCode(value: string): value is BacktestCompareStrategyCode {
    return (BACKTEST_COMPARE_STRATEGY_CODES as readonly string[]).includes(value);
  }

  // 比较策略码只接受白名单值；一旦用户传空或全错，就回退到默认集合，保证接口始终可运行。
  private normalizeCompareStrategyCodes(strategyCodes?: string[]): BacktestCompareStrategyCode[] {
    const candidates = (strategyCodes ?? DEFAULT_BACKTEST_COMPARE_STRATEGY_CODES).map((item) => String(item).trim());
    const normalized = Array.from(new Set(candidates.filter((item): item is BacktestCompareStrategyCode => this.isCompareStrategyCode(item))));
    if (normalized.length > 0) {
      return normalized;
    }
    return [...DEFAULT_BACKTEST_COMPARE_STRATEGY_CODES];
  }

  private isStrategyCode(value: string): value is BacktestStrategyCode {
    return (BACKTEST_STRATEGY_CODES as readonly string[]).includes(value);
  }

  // 用户自定义策略和内置模板要走同一条标准化流程，便于后续统一下发给 Agent。
  private normalizeStrategyCodes(strategyCodes?: string[]): BacktestStrategyCode[] {
    const candidates = (strategyCodes ?? DEFAULT_BACKTEST_STRATEGY_CODES).map((item) => String(item).trim());
    const normalized = Array.from(new Set(candidates.filter((item): item is BacktestStrategyCode => this.isStrategyCode(item))));
    if (normalized.length > 0) {
      return normalized;
    }
    return [...DEFAULT_BACKTEST_STRATEGY_CODES];
  }

  private normalizeSavedStrategyId(value: unknown): number | null {
    const parsed = Math.trunc(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private normalizeSavedStrategyName(value: unknown): string | null {
    const text = String(value ?? '').trim();
    return text.length > 0 ? text.slice(0, 64) : null;
  }

  private normalizeInlineRunStrategies(
    values: Array<Record<string, unknown>>,
  ): Array<{
    strategyId: number | null;
    strategyName: string;
    templateCode: BacktestStrategyTemplateCode;
    templateName: string;
    params: Record<string, unknown>;
  }> {
    const normalized: Array<{
      strategyId: number | null;
      strategyName: string;
      templateCode: BacktestStrategyTemplateCode;
      templateName: string;
      params: Record<string, unknown>;
    }> = [];
    const seen = new Set<string>();

    for (const item of values) {
      const templateCodeRaw = String(item.template_code ?? item.templateCode ?? '').trim();
      if (!isBacktestStrategyTemplateCode(templateCodeRaw)) {
        throw buildServiceError('VALIDATION_ERROR', `unsupported template_code: ${templateCodeRaw || '--'}`);
      }
      const strategyName = this.normalizeSavedStrategyName(item.strategy_name ?? item.strategyName)
        ?? getBacktestStrategyTemplateName(templateCodeRaw);
      const strategyId = this.normalizeSavedStrategyId(item.strategy_id ?? item.strategyId);
      const { params, issues } = normalizeBacktestStrategyParams(templateCodeRaw, item.params);
      if (issues.length > 0) {
        throw buildServiceError('VALIDATION_ERROR', issues.join('; '));
      }
      const dedupeKey = `${strategyId ?? 'adhoc'}::${templateCodeRaw}::${strategyName}::${safeJsonStringify(params)}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      normalized.push({
        strategyId,
        strategyName,
        templateCode: templateCodeRaw,
        templateName: getBacktestStrategyTemplateName(templateCodeRaw),
        params,
      });
    }

    if (normalized.length === 0) {
      throw buildServiceError('VALIDATION_ERROR', '至少需要一条有效策略定义');
    }
    return normalized;
  }

  private resolveStoredStrategyMetadata(
    storedStrategyCode: string,
    savedStrategyName?: string | null,
  ): { strategyCode: string; strategyName: string; templateCode: string; templateName: string } {
    const rawCode = String(storedStrategyCode ?? '').trim();
    const savedName = this.normalizeSavedStrategyName(savedStrategyName);

    if (this.isStrategyCode(rawCode)) {
      const resolved = resolveLegacyBacktestStrategy(rawCode);
      return {
        strategyCode: rawCode,
        strategyName: savedName ?? BACKTEST_STRATEGY_NAMES[rawCode],
        templateCode: resolved.templateCode,
        templateName: getBacktestStrategyTemplateName(resolved.templateCode),
      };
    }

    if (isBacktestStrategyTemplateCode(rawCode)) {
      const templateName = getBacktestStrategyTemplateName(rawCode);
      return {
        strategyCode: rawCode,
        strategyName: savedName ?? templateName,
        templateCode: rawCode,
        templateName,
      };
    }

    return {
      strategyCode: rawCode,
      strategyName: savedName ?? rawCode,
      templateCode: rawCode,
      templateName: rawCode,
    };
  }

  private buildStoredStrategyCodeCandidates(rawStrategyCode?: string): string[] {
    const value = String(rawStrategyCode ?? '').trim();
    if (!value) {
      return [];
    }

    const candidates = new Set<string>([value]);
    if (this.isStrategyCode(value)) {
      candidates.add(resolveLegacyBacktestStrategy(value).templateCode);
    }
    if (value === 'ma_cross') {
      candidates.add('ma20_trend');
    }
    if (value === 'rsi_threshold') {
      candidates.add('rsi14_mean_reversion');
    }
    return [...candidates];
  }

  private parseDayText(value: unknown): Date | null {
    if (value == null) {
      return null;
    }
    const text = String(value).trim();
    if (!text) {
      return null;
    }
    const parsed = new Date(`${text.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  }

  private toIsoDay(value: Date | null | undefined): string | null {
    if (!value || Number.isNaN(value.getTime())) {
      return null;
    }
    return value.toISOString().slice(0, 10);
  }

  private toIsoDateTime(value: Date | null | undefined): string | null {
    if (!value || Number.isNaN(value.getTime())) {
      return null;
    }
    return value.toISOString();
  }

  private normalizeStrategyAiInterpretationStatus(value: unknown): StrategyAiInterpretationJobStatus {
    const text = String(value ?? '').trim();
    if (text === 'processing' || text === 'completed' || text === 'failed') {
      return text;
    }
    return 'pending';
  }

  private hasStrategyAiInterpretation(value: unknown): boolean {
    const status = String(asRecord(asRecord(value).ai_interpretation).status ?? '').trim();
    return status === 'ready' || status === 'failed' || status === 'unavailable';
  }

  private detailNeedsStrategyAiHydration(detail: Record<string, unknown>): boolean {
    const items = asArrayOfRecords(detail.items);
    if (items.length === 0) {
      return false;
    }
    return items.some(item => !this.hasStrategyAiInterpretation(item.metrics));
  }

  private async hydrateStrategyRunGroupInterpretations(runGroupId: number): Promise<void> {
    await this.backtestAiInterpretationService.ensureStrategyRunGroupInterpretations(runGroupId);
    await this.prisma.strategyBacktestRunGroup.update({
      where: { id: runGroupId },
      data: {
        aiInterpretationStatus: 'completed',
        aiInterpretationCompletedAt: new Date(),
        aiInterpretationNextRetryAt: null,
        aiInterpretationErrorMessage: null,
      },
    });
  }

  private summaryRowsPayload(
    rows: Array<{
      evalStatus: string;
      positionRecommendation: string | null;
      outcome: string | null;
      directionCorrect: boolean | null;
      stockReturnPct: number | null;
      simulatedReturnPct: number | null;
      hitStopLoss: boolean | null;
      hitTakeProfit: boolean | null;
      firstHit: string | null;
      firstHitTradingDays: number | null;
      operationAdvice: string | null;
    }>,
  ): Array<Record<string, unknown>> {
    return rows.map((row) => ({
      eval_status: row.evalStatus,
      position_recommendation: row.positionRecommendation,
      outcome: row.outcome,
      direction_correct: row.directionCorrect,
      stock_return_pct: row.stockReturnPct,
      simulated_return_pct: row.simulatedReturnPct,
      hit_stop_loss: row.hitStopLoss,
      hit_take_profit: row.hitTakeProfit,
      first_hit: row.firstHit,
      first_hit_trading_days: row.firstHitTradingDays,
      operation_advice: row.operationAdvice,
    }));
  }

  private normalizeSummaryPayload(summaryRaw: Record<string, unknown>, fallback: {
    scope: string;
    code: string | null;
    evalWindowDays: number;
    engineVersion: string;
  }): {
    scope: string;
    code: string | null;
    evalWindowDays: number;
    engineVersion: string;
    totalEvaluations: number;
    completedCount: number;
    insufficientCount: number;
    longCount: number;
    cashCount: number;
    winCount: number;
    lossCount: number;
    neutralCount: number;
    directionAccuracyPct: number | null;
    predictionWinRatePct: number | null;
    tradeWinRatePct: number | null;
    winRatePct: number | null;
    neutralRatePct: number | null;
    avgStockReturnPct: number | null;
    avgSimulatedReturnPct: number | null;
    stopLossTriggerRate: number | null;
    takeProfitTriggerRate: number | null;
    ambiguousRate: number | null;
    avgDaysToFirstHit: number | null;
    adviceBreakdown: unknown;
    diagnostics: unknown;
  } {
    const scope = String(summaryRaw.scope ?? fallback.scope);
    const code = (summaryRaw.code == null ? fallback.code : String(summaryRaw.code)) ?? fallback.code;
    const evalWindowDays = Number(summaryRaw.eval_window_days ?? fallback.evalWindowDays);
    const engineVersion = String(summaryRaw.engine_version ?? fallback.engineVersion);

    return {
      scope,
      code,
      evalWindowDays,
      engineVersion,
      totalEvaluations: Number(summaryRaw.total_evaluations ?? 0),
      completedCount: Number(summaryRaw.completed_count ?? 0),
      insufficientCount: Number(summaryRaw.insufficient_count ?? 0),
      longCount: Number(summaryRaw.long_count ?? 0),
      cashCount: Number(summaryRaw.cash_count ?? 0),
      winCount: Number(summaryRaw.win_count ?? 0),
      lossCount: Number(summaryRaw.loss_count ?? 0),
      neutralCount: Number(summaryRaw.neutral_count ?? 0),
      directionAccuracyPct: this.toNumber(summaryRaw.direction_accuracy_pct),
      predictionWinRatePct: this.toNumber(summaryRaw.prediction_win_rate_pct ?? summaryRaw.win_rate_pct),
      tradeWinRatePct: this.toNumber(summaryRaw.trade_win_rate_pct ?? summaryRaw.win_rate_pct),
      winRatePct: this.toNumber(summaryRaw.win_rate_pct ?? summaryRaw.prediction_win_rate_pct),
      neutralRatePct: this.toNumber(summaryRaw.neutral_rate_pct),
      avgStockReturnPct: this.toNumber(summaryRaw.avg_stock_return_pct),
      avgSimulatedReturnPct: this.toNumber(summaryRaw.avg_simulated_return_pct),
      stopLossTriggerRate: this.toNumber(summaryRaw.stop_loss_trigger_rate),
      takeProfitTriggerRate: this.toNumber(summaryRaw.take_profit_trigger_rate),
      ambiguousRate: this.toNumber(summaryRaw.ambiguous_rate),
      avgDaysToFirstHit: this.toNumber(summaryRaw.avg_days_to_first_hit),
      adviceBreakdown: summaryRaw.advice_breakdown ?? {},
      diagnostics: summaryRaw.diagnostics ?? {},
    };
  }

  private async computeSummaryViaAgent(input: {
    scope: 'overall' | 'stock';
    code: string;
    evalWindowDays: number;
    engineVersion: string;
    rows: Array<{
      evalStatus: string;
      positionRecommendation: string | null;
      outcome: string | null;
      directionCorrect: boolean | null;
      stockReturnPct: number | null;
      simulatedReturnPct: number | null;
      hitStopLoss: boolean | null;
      hitTakeProfit: boolean | null;
      firstHit: string | null;
      firstHitTradingDays: number | null;
      operationAdvice: string | null;
    }>;
  }): Promise<Record<string, unknown>> {
    const payload = {
      scope: input.scope,
      code: input.scope === 'overall' ? OVERALL_SENTINEL_CODE : input.code,
      eval_window_days: input.evalWindowDays,
      engine_version: input.engineVersion,
      neutral_band_pct: Math.abs(Number(process.env.BACKTEST_NEUTRAL_BAND_PCT ?? 2.0)),
      rows: this.summaryRowsPayload(input.rows),
    };
    const summaryRaw = await this.backtestAgentClient.summary(payload);
    const normalized = this.normalizeSummaryPayload(summaryRaw, {
      scope: input.scope,
      code: payload.code,
      evalWindowDays: input.evalWindowDays,
      engineVersion: input.engineVersion,
    });
    return this.mapSummary(normalized);
  }

  private async upsertSummaryFromPayload(summaryPayload: Record<string, unknown>, ownerUserId: number | null): Promise<void> {
    const scope = String(summaryPayload.scope ?? 'overall');
    const code = String(summaryPayload.code ?? OVERALL_SENTINEL_CODE);
    const evalWindowDays = Number(summaryPayload.eval_window_days ?? this.defaultEvalWindowDays());
    const engineVersion = String(summaryPayload.engine_version ?? process.env.BACKTEST_ENGINE_VERSION ?? 'v1');

    const data = {
      ownerUserId,
      scope,
      code,
      evalWindowDays,
      engineVersion,
      computedAt: new Date(),
      totalEvaluations: Number(summaryPayload.total_evaluations ?? 0),
      completedCount: Number(summaryPayload.completed_count ?? 0),
      insufficientCount: Number(summaryPayload.insufficient_count ?? 0),
      longCount: Number(summaryPayload.long_count ?? 0),
      cashCount: Number(summaryPayload.cash_count ?? 0),
      winCount: Number(summaryPayload.win_count ?? 0),
      lossCount: Number(summaryPayload.loss_count ?? 0),
      neutralCount: Number(summaryPayload.neutral_count ?? 0),
      directionAccuracyPct: this.toNumber(summaryPayload.direction_accuracy_pct),
      predictionWinRatePct: this.toNumber(summaryPayload.prediction_win_rate_pct ?? summaryPayload.win_rate_pct),
      tradeWinRatePct: this.toNumber(summaryPayload.trade_win_rate_pct ?? summaryPayload.win_rate_pct),
      winRatePct: this.toNumber(summaryPayload.win_rate_pct ?? summaryPayload.prediction_win_rate_pct),
      neutralRatePct: this.toNumber(summaryPayload.neutral_rate_pct),
      avgStockReturnPct: this.toNumber(summaryPayload.avg_stock_return_pct),
      avgSimulatedReturnPct: this.toNumber(summaryPayload.avg_simulated_return_pct),
      stopLossTriggerRate: this.toNumber(summaryPayload.stop_loss_trigger_rate),
      takeProfitTriggerRate: this.toNumber(summaryPayload.take_profit_trigger_rate),
      ambiguousRate: this.toNumber(summaryPayload.ambiguous_rate),
      avgDaysToFirstHit: this.toNumber(summaryPayload.avg_days_to_first_hit),
      adviceBreakdownJson: safeJsonStringify(summaryPayload.advice_breakdown ?? {}),
      diagnosticsJson: safeJsonStringify(summaryPayload.diagnostics ?? {}),
    };

    if (ownerUserId == null) {
      const existing = await this.prisma.backtestSummary.findFirst({
        where: {
          ownerUserId: null,
          scope,
          code,
          evalWindowDays,
          engineVersion,
        },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.backtestSummary.update({
          where: { id: existing.id },
          data: data as any,
        });
        return;
      }
      await this.prisma.backtestSummary.create({ data: data as any });
      return;
    }

    await this.prisma.backtestSummary.upsert({
      where: {
        ownerUserId_scope_code_evalWindowDays_engineVersion: {
          ownerUserId,
          scope,
          code,
          evalWindowDays,
          engineVersion,
        },
      },
      update: data as any,
      create: data as any,
    });
  }

  private async recomputeSummaries(
    evalWindowDays: number,
    engineVersion: string,
    touchedCodesByOwner: Map<number | null, Set<string>>,
  ): Promise<void> {
    for (const [ownerUserId, touchedCodes] of touchedCodesByOwner.entries()) {
      const ownerWhere = ownerUserId == null ? { ownerUserId: null } : { ownerUserId };

      const overallRows = await this.prisma.backtestResult.findMany({
        where: { ...ownerWhere, evalWindowDays, engineVersion },
        select: {
          evalStatus: true,
          positionRecommendation: true,
          outcome: true,
          directionCorrect: true,
          stockReturnPct: true,
          simulatedReturnPct: true,
          hitStopLoss: true,
          hitTakeProfit: true,
          firstHit: true,
          firstHitTradingDays: true,
          operationAdvice: true,
        },
      });

      const overallSummary = await this.computeSummaryViaAgent({
        scope: 'overall',
        code: OVERALL_SENTINEL_CODE,
        evalWindowDays,
        engineVersion,
        rows: overallRows,
      });
      await this.upsertSummaryFromPayload(overallSummary, ownerUserId);

      for (const code of touchedCodes) {
        const rows = await this.prisma.backtestResult.findMany({
          where: { ...ownerWhere, code, evalWindowDays, engineVersion },
          select: {
            evalStatus: true,
            positionRecommendation: true,
            outcome: true,
            directionCorrect: true,
            stockReturnPct: true,
            simulatedReturnPct: true,
            hitStopLoss: true,
            hitTakeProfit: true,
            firstHit: true,
            firstHitTradingDays: true,
            operationAdvice: true,
          },
        });

        const summary = await this.computeSummaryViaAgent({
          scope: 'stock',
          code,
          evalWindowDays,
          engineVersion,
          rows,
        });
        await this.upsertSummaryFromPayload(summary, ownerUserId);
      }
    }
  }

  private mergeTouchedCodes(
    target: Map<number | null, Set<string>>,
    incoming: Map<number | null, Set<string>>,
  ): void {
    for (const [ownerUserId, codes] of incoming.entries()) {
      if (!target.has(ownerUserId)) {
        target.set(ownerUserId, new Set<string>());
      }
      const merged = target.get(ownerUserId)!;
      for (const code of codes) {
        merged.add(code);
      }
    }
  }

  private async executeBacktestCandidates(input: {
    candidates: Array<{
      id: number;
      ownerUserId: number | null;
      code: string;
      createdAt: Date;
      contextSnapshot: string | null;
      operationAdvice: string | null;
      stopLoss: number | null;
      takeProfit: number | null;
    }>;
    code?: string;
    force: boolean;
    evalWindowDays: number;
    minAgeDays: number;
    limit: number;
    engineVersion: string;
    neutralBandPct: number;
  }): Promise<{
    processed: number;
    saved: number;
    completed: number;
    insufficient: number;
    errors: number;
    touchedCodesByOwner: Map<number | null, Set<string>>;
  }> {
    if (input.candidates.length === 0) {
      return {
        processed: 0,
        saved: 0,
        completed: 0,
        insufficient: 0,
        errors: 0,
        touchedCodesByOwner: new Map<number | null, Set<string>>(),
      };
    }

    const candidateById = new Map(
      input.candidates.map((item) => [item.id, item]),
    );

    const runPayload = await this.backtestAgentClient.run({
      code: input.code,
      force: input.force,
      eval_window_days: input.evalWindowDays,
      min_age_days: input.minAgeDays,
      limit: input.limit,
      engine_version: input.engineVersion,
      neutral_band_pct: input.neutralBandPct,
      candidates: input.candidates.map((item) => ({
        analysis_history_id: item.id,
        owner_user_id: item.ownerUserId,
        code: item.code,
        created_at: item.createdAt.toISOString(),
        context_snapshot: item.contextSnapshot,
        operation_advice: item.operationAdvice,
        stop_loss: item.stopLoss,
        take_profit: item.takeProfit,
      })),
    });

    const itemPayload = asArrayOfRecords(runPayload.items);
    const touchedCodesByOwner = new Map<number | null, Set<string>>();

    let saved = 0;
    let completed = 0;
    let insufficient = 0;
    let errors = Number(runPayload.errors ?? 0);

    for (const item of itemPayload) {
      const analysisHistoryId = Number(item.analysis_history_id ?? 0);
      if (!Number.isFinite(analysisHistoryId) || analysisHistoryId <= 0) {
        errors += 1;
        continue;
      }

      const candidate = candidateById.get(analysisHistoryId);
      if (!candidate) {
        errors += 1;
        continue;
      }

      const evalStatus = String(item.eval_status ?? 'error');
      if (evalStatus === 'completed') completed += 1;
      else if (evalStatus === 'insufficient_data') insufficient += 1;
      else errors += 1;

      const ownerCandidate = item.owner_user_id != null
        ? this.toNumber(item.owner_user_id)
        : candidate.ownerUserId;
      const ownerUserId = ownerCandidate == null ? null : Math.trunc(ownerCandidate);
      const code = String(item.code ?? candidate.code);

      if (!touchedCodesByOwner.has(ownerUserId)) {
        touchedCodesByOwner.set(ownerUserId, new Set<string>());
      }
      touchedCodesByOwner.get(ownerUserId)!.add(code);

      const analysisDate = this.toDate(item.analysis_date) ?? this.resolveAnalysisDate(candidate.contextSnapshot, candidate.createdAt);

      try {
        await this.prisma.backtestResult.upsert({
          where: {
            analysisHistoryId_evalWindowDays_engineVersion: {
              analysisHistoryId,
              evalWindowDays: input.evalWindowDays,
              engineVersion: input.engineVersion,
            },
          },
          update: {
            ownerUserId,
            code,
            analysisDate,
            evalStatus,
            operationAdvice: String(item.operation_advice ?? candidate.operationAdvice ?? ''),
            positionRecommendation: (item.position_recommendation as string | undefined) ?? null,
            startPrice: this.toNumber(item.start_price),
            endClose: this.toNumber(item.end_close),
            maxHigh: this.toNumber(item.max_high),
            minLow: this.toNumber(item.min_low),
            stockReturnPct: this.toNumber(item.stock_return_pct),
            directionExpected: (item.direction_expected as string | undefined) ?? null,
            directionCorrect: this.toBoolean(item.direction_correct),
            outcome: (item.outcome as string | undefined) ?? null,
            stopLoss: this.toNumber(item.stop_loss),
            takeProfit: this.toNumber(item.take_profit),
            hitStopLoss: this.toBoolean(item.hit_stop_loss),
            hitTakeProfit: this.toBoolean(item.hit_take_profit),
            firstHit: (item.first_hit as string | undefined) ?? null,
            firstHitDate: this.toDate(item.first_hit_date),
            firstHitTradingDays: this.toNumber(item.first_hit_trading_days),
            simulatedEntryPrice: this.toNumber(item.simulated_entry_price),
            simulatedExitPrice: this.toNumber(item.simulated_exit_price),
            simulatedExitReason: (item.simulated_exit_reason as string | undefined) ?? null,
            simulatedReturnPct: this.toNumber(item.simulated_return_pct),
            evaluatedAt: new Date(),
          },
          create: {
            ownerUserId,
            analysisHistoryId,
            code,
            analysisDate,
            evalWindowDays: input.evalWindowDays,
            engineVersion: input.engineVersion,
            evalStatus,
            operationAdvice: String(item.operation_advice ?? candidate.operationAdvice ?? ''),
            positionRecommendation: (item.position_recommendation as string | undefined) ?? null,
            startPrice: this.toNumber(item.start_price),
            endClose: this.toNumber(item.end_close),
            maxHigh: this.toNumber(item.max_high),
            minLow: this.toNumber(item.min_low),
            stockReturnPct: this.toNumber(item.stock_return_pct),
            directionExpected: (item.direction_expected as string | undefined) ?? null,
            directionCorrect: this.toBoolean(item.direction_correct),
            outcome: (item.outcome as string | undefined) ?? null,
            stopLoss: this.toNumber(item.stop_loss),
            takeProfit: this.toNumber(item.take_profit),
            hitStopLoss: this.toBoolean(item.hit_stop_loss),
            hitTakeProfit: this.toBoolean(item.hit_take_profit),
            firstHit: (item.first_hit as string | undefined) ?? null,
            firstHitDate: this.toDate(item.first_hit_date),
            firstHitTradingDays: this.toNumber(item.first_hit_trading_days),
            simulatedEntryPrice: this.toNumber(item.simulated_entry_price),
            simulatedExitPrice: this.toNumber(item.simulated_exit_price),
            simulatedExitReason: (item.simulated_exit_reason as string | undefined) ?? null,
            simulatedReturnPct: this.toNumber(item.simulated_return_pct),
            evaluatedAt: new Date(),
          },
        });
        saved += 1;
      } catch (error: unknown) {
        errors += 1;
        this.logger.error(
          `Failed to upsert backtest_result analysisHistoryId=${analysisHistoryId} code=${code} evalStatus=${evalStatus}`,
          (error as Error)?.stack ?? String((error as Error)?.message ?? error),
        );
      }
    }

    return {
      processed: input.candidates.length,
      saved,
      completed,
      insufficient,
      errors,
      touchedCodesByOwner,
    };
  }

  async run(input: {
    code?: string;
    force: boolean;
    evalWindowDays?: number;
    minAgeDays?: number;
    limit: number;
    scope: { userId: number; includeAll: boolean };
  }): Promise<Record<string, number>> {
    // run 只补算“尚未有结果”或 force 指定重算的样本，用于日常增量回刷。
    const evalWindowRaw = Number(input.evalWindowDays ?? process.env.BACKTEST_EVAL_WINDOW_DAYS ?? 10);
    const evalWindowDays = Number.isFinite(evalWindowRaw) && evalWindowRaw > 0 ? Math.trunc(evalWindowRaw) : 10;
    const minAgeFloor = Math.max(14, Math.trunc(evalWindowDays));
    const requestedMinAgeDays = Number(input.minAgeDays ?? process.env.BACKTEST_MIN_AGE_DAYS ?? minAgeFloor);
    const minAgeDays = Math.max(minAgeFloor, Number.isFinite(requestedMinAgeDays) ? Math.trunc(requestedMinAgeDays) : minAgeFloor);
    const engineVersion = String(process.env.BACKTEST_ENGINE_VERSION ?? 'v1');
    const neutralBandPct = Number(process.env.BACKTEST_NEUTRAL_BAND_PCT ?? 2.0);

    const cutoff = new Date(Date.now() - minAgeDays * 24 * 3600 * 1000);

    const candidates = await this.prisma.analysisHistory.findMany({
      where: {
        ...(input.scope.includeAll ? {} : { ownerUserId: input.scope.userId }),
        ...(input.code ? { code: input.code } : {}),
        createdAt: { lte: cutoff },
        ...(input.force
          ? {}
          : {
              backtestResults: {
                none: {
                  evalWindowDays,
                  engineVersion,
                },
              },
            }),
      },
      orderBy: { createdAt: 'desc' },
      take: input.limit,
      select: {
        id: true,
        ownerUserId: true,
        code: true,
        createdAt: true,
        contextSnapshot: true,
        operationAdvice: true,
        stopLoss: true,
        takeProfit: true,
      },
    });

    if (candidates.length === 0) {
      return {
        processed: 0,
        saved: 0,
        completed: 0,
        insufficient: 0,
        errors: 0,
      };
    }

    const result = await this.executeBacktestCandidates({
      candidates,
      code: input.code,
      force: input.force,
      evalWindowDays,
      minAgeDays,
      limit: input.limit,
      engineVersion,
      neutralBandPct,
    });

    if (result.saved > 0) {
      await this.recomputeSummaries(evalWindowDays, engineVersion, result.touchedCodesByOwner);
    }

    return {
      processed: candidates.length,
      saved: result.saved,
      completed: result.completed,
      insufficient: result.insufficient,
      errors: result.errors,
    };
  }

  async recomputeAll(input: {
    evalWindowDays?: number;
    minAgeDays?: number;
    batchSize?: number;
    scope: { userId: number; includeAll: boolean };
  }): Promise<Record<string, number>> {
    // recomputeAll 会先清空同窗口/引擎版本结果，再按批次完整回灌，适合规则版本升级后的全量重算。
    const evalWindowRaw = Number(input.evalWindowDays ?? process.env.BACKTEST_EVAL_WINDOW_DAYS ?? 10);
    const evalWindowDays = Number.isFinite(evalWindowRaw) && evalWindowRaw > 0 ? Math.trunc(evalWindowRaw) : 10;
    const minAgeFloor = Math.max(14, Math.trunc(evalWindowDays));
    const requestedMinAgeDays = Number(input.minAgeDays ?? process.env.BACKTEST_MIN_AGE_DAYS ?? minAgeFloor);
    const minAgeDays = Math.max(minAgeFloor, Number.isFinite(requestedMinAgeDays) ? Math.trunc(requestedMinAgeDays) : minAgeFloor);
    const engineVersion = String(process.env.BACKTEST_ENGINE_VERSION ?? 'v1');
    const neutralBandPct = Number(process.env.BACKTEST_NEUTRAL_BAND_PCT ?? 2.0);
    const batchSize = Math.min(Math.max(Math.trunc(Number(input.batchSize ?? 500)), 1), 5000);
    const cutoff = new Date(Date.now() - minAgeDays * 24 * 3600 * 1000);

    const ownerFilter = input.scope.includeAll ? {} : { ownerUserId: input.scope.userId };
    const ownerWhereSummary = input.scope.includeAll ? {} : { ownerUserId: input.scope.userId };

    await this.prisma.backtestResult.deleteMany({
      where: {
        ...ownerFilter,
        evalWindowDays,
        engineVersion,
      },
    });
    await this.prisma.backtestSummary.deleteMany({
      where: {
        ...ownerWhereSummary,
        evalWindowDays,
        engineVersion,
      },
    });

    let cursorId = 0;
    let processed = 0;
    let saved = 0;
    let completed = 0;
    let insufficient = 0;
    let errors = 0;
    const touchedCodesByOwner = new Map<number | null, Set<string>>();

    while (true) {
      const candidates = await this.prisma.analysisHistory.findMany({
        where: {
          ...ownerFilter,
          createdAt: { lte: cutoff },
          id: { gt: cursorId },
        },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: {
          id: true,
          ownerUserId: true,
          code: true,
          createdAt: true,
          contextSnapshot: true,
          operationAdvice: true,
          stopLoss: true,
          takeProfit: true,
        },
      });

      if (candidates.length === 0) {
        break;
      }

      const batchResult = await this.executeBacktestCandidates({
        candidates,
        force: true,
        evalWindowDays,
        minAgeDays,
        limit: batchSize,
        engineVersion,
        neutralBandPct,
      });

      processed += batchResult.processed;
      saved += batchResult.saved;
      completed += batchResult.completed;
      insufficient += batchResult.insufficient;
      errors += batchResult.errors;
      this.mergeTouchedCodes(touchedCodesByOwner, batchResult.touchedCodesByOwner);

      cursorId = candidates[candidates.length - 1].id;
    }

    if (saved > 0) {
      await this.recomputeSummaries(evalWindowDays, engineVersion, touchedCodesByOwner);
    }

    return {
      processed,
      saved,
      completed,
      insufficient,
      errors,
    };
  }

  async listResults(input: {
    code?: string;
    evalWindowDays?: number;
    page: number;
    limit: number;
    scope: { userId: number; includeAll: boolean };
  }): Promise<Record<string, unknown>> {
    const resolvedEvalWindowDays = Number(input.evalWindowDays ?? this.defaultEvalWindowDays());
    const where: Prisma.BacktestResultWhereInput = this.buildOwnerFilter(input.scope);
    if (input.code) where.code = input.code;
    where.evalWindowDays = resolvedEvalWindowDays;

    const total = await this.prisma.backtestResult.count({ where });
    const rows = await this.prisma.backtestResult.findMany({
      where,
      orderBy: { evaluatedAt: 'desc' },
      skip: (input.page - 1) * input.limit,
      take: input.limit,
    });

    return {
      total,
      page: input.page,
      limit: input.limit,
      eval_window_days: resolvedEvalWindowDays,
      metric_definition_version: 'v2',
      warnings: input.evalWindowDays == null ? ['eval_window_days not provided, default window applied'] : [],
      items: rows.map((row) => ({
        analysis_history_id: row.analysisHistoryId,
        code: row.code,
        analysis_date: row.analysisDate?.toISOString().slice(0, 10) ?? null,
        eval_window_days: row.evalWindowDays,
        engine_version: row.engineVersion,
        eval_status: row.evalStatus,
        evaluated_at: row.evaluatedAt.toISOString(),
        operation_advice: row.operationAdvice,
        position_recommendation: row.positionRecommendation,
        start_price: row.startPrice,
        end_close: row.endClose,
        max_high: row.maxHigh,
        min_low: row.minLow,
        stock_return_pct: row.stockReturnPct,
        direction_expected: row.directionExpected,
        direction_correct: row.directionCorrect,
        outcome: row.outcome,
        stop_loss: row.stopLoss,
        take_profit: row.takeProfit,
        hit_stop_loss: row.hitStopLoss,
        hit_take_profit: row.hitTakeProfit,
        first_hit: row.firstHit,
        first_hit_date: row.firstHitDate?.toISOString().slice(0, 10) ?? null,
        first_hit_trading_days: row.firstHitTradingDays,
        simulated_entry_price: row.simulatedEntryPrice,
        simulated_exit_price: row.simulatedExitPrice,
        simulated_exit_reason: row.simulatedExitReason,
        simulated_return_pct: row.simulatedReturnPct,
        owner_user_id: row.ownerUserId ?? null,
      })),
    };
  }

  async getCurves(input: {
    scope: 'overall' | 'stock';
    code?: string;
    evalWindowDays?: number;
    equityMode?: 'portfolio' | 'sequential';
    requester: { userId: number; includeAll: boolean };
  }): Promise<Record<string, unknown>> {
    const evalWindowDays = Number(input.evalWindowDays ?? this.defaultEvalWindowDays());
    const lookupCode = this.resolveScopeCode(input.scope, input.code);
    const where = this.buildScopeWhere({
      scope: input.scope,
      code: input.code,
      evalWindowDays,
      requester: input.requester,
    });

    const rows = await this.prisma.backtestResult.findMany({
      where,
      select: {
        analysisHistoryId: true,
        code: true,
        analysisDate: true,
        evaluatedAt: true,
        simulatedReturnPct: true,
        stockReturnPct: true,
        evalStatus: true,
      },
    });

    const payload = await this.backtestAgentClient.curves({
      scope: input.scope,
      code: input.scope === 'stock' ? lookupCode : null,
      eval_window_days: evalWindowDays,
      equity_mode: input.equityMode ?? 'portfolio',
      rows: rows.map((row) => ({
        analysis_history_id: row.analysisHistoryId,
        code: row.code,
        analysis_date: row.analysisDate?.toISOString().slice(0, 10) ?? null,
        evaluated_at: row.evaluatedAt.toISOString(),
        simulated_return_pct: row.simulatedReturnPct,
        stock_return_pct: row.stockReturnPct,
        eval_status: row.evalStatus,
      })),
    });

    return {
      scope: input.scope,
      code: input.scope === 'stock' ? lookupCode : null,
      eval_window_days: evalWindowDays,
      equity_mode: String(payload.equity_mode ?? input.equityMode ?? 'portfolio'),
      metric_definition_version: String(payload.metric_definition_version ?? 'v2'),
      curves: Array.isArray(payload.curves) ? payload.curves : [],
      signal_curves: Array.isArray(payload.signal_curves) ? payload.signal_curves : [],
      portfolio_curves: Array.isArray(payload.portfolio_curves) ? payload.portfolio_curves : [],
    };
  }

  async getDistribution(input: {
    scope: 'overall' | 'stock';
    code?: string;
    evalWindowDays?: number;
    requester: { userId: number; includeAll: boolean };
  }): Promise<Record<string, unknown>> {
    const evalWindowDays = Number(input.evalWindowDays ?? this.defaultEvalWindowDays());
    const engineVersion = String(process.env.BACKTEST_ENGINE_VERSION ?? 'v1');
    const lookupCode = this.resolveScopeCode(input.scope, input.code);
    const where = this.buildScopeWhere({
      scope: input.scope,
      code: input.code,
      evalWindowDays,
      requester: input.requester,
    });

    const rows = await this.prisma.backtestResult.findMany({
      where,
      select: {
        evalStatus: true,
        positionRecommendation: true,
        outcome: true,
        directionCorrect: true,
        stockReturnPct: true,
        simulatedReturnPct: true,
        hitStopLoss: true,
        hitTakeProfit: true,
        firstHit: true,
        firstHitTradingDays: true,
        operationAdvice: true,
      },
    });

    const payload = await this.backtestAgentClient.distribution({
      scope: input.scope,
      code: input.scope === 'stock' ? lookupCode : null,
      eval_window_days: evalWindowDays,
      engine_version: engineVersion,
      neutral_band_pct: Math.abs(Number(process.env.BACKTEST_NEUTRAL_BAND_PCT ?? 2.0)),
      rows: this.summaryRowsPayload(rows),
    });

    const distribution = asRecord(payload.distribution);
    const positionDistribution = asRecord(distribution.position_distribution);
    const outcomeDistribution = asRecord(distribution.outcome_distribution);

    return {
      scope: input.scope,
      code: input.scope === 'stock' ? lookupCode : null,
      eval_window_days: evalWindowDays,
      metric_definition_version: String(payload.metric_definition_version ?? 'v2'),
      distribution: {
        position_distribution: {
          long_count: Number(positionDistribution.long_count ?? distribution.long_count ?? 0),
          cash_count: Number(positionDistribution.cash_count ?? distribution.cash_count ?? 0),
        },
        outcome_distribution: {
          win_count: Number(outcomeDistribution.win_count ?? distribution.win_count ?? 0),
          loss_count: Number(outcomeDistribution.loss_count ?? distribution.loss_count ?? 0),
          neutral_count: Number(outcomeDistribution.neutral_count ?? distribution.neutral_count ?? 0),
        },
        long_count: Number(distribution.long_count ?? positionDistribution.long_count ?? 0),
        cash_count: Number(distribution.cash_count ?? positionDistribution.cash_count ?? 0),
        win_count: Number(distribution.win_count ?? outcomeDistribution.win_count ?? 0),
        loss_count: Number(distribution.loss_count ?? outcomeDistribution.loss_count ?? 0),
        neutral_count: Number(distribution.neutral_count ?? outcomeDistribution.neutral_count ?? 0),
      },
    };
  }

  async compareWindows(input: {
    code?: string;
    evalWindowDaysList: number[];
    strategyCodes?: string[];
    requester: { userId: number; includeAll: boolean };
  }): Promise<Record<string, unknown>> {
    const normalizedCode = String(input.code ?? '').trim();
    const scope: 'overall' | 'stock' = normalizedCode ? 'stock' : 'overall';
    const neutralBandPct = Math.abs(Number(process.env.BACKTEST_NEUTRAL_BAND_PCT ?? 2.0));
    // 窗口列表先裁剪、去重、排序，避免 compare 接口被前端的异常入参放大成无意义查询。
    const windows = Array.from(
      new Set(
        input.evalWindowDaysList
          .map((item) => Math.trunc(Number(item)))
          .filter((item) => Number.isFinite(item) && item > 0 && item <= 120),
      ),
    ).sort((a, b) => a - b);
    const strategyCodes = this.normalizeCompareStrategyCodes(input.strategyCodes);

    const rowsByWindow: Record<string, Array<Record<string, unknown>>> = {};
    for (const evalWindowDays of windows) {
      // compare Agent 需要看到各窗口对应的原始样本行，因此 Backend 逐窗口组装 rows_by_window。
      const where = this.buildScopeWhere({
        scope,
        code: normalizedCode,
        evalWindowDays,
        requester: input.requester,
      });

      const rows = await this.prisma.backtestResult.findMany({
        where,
        select: {
          analysisHistoryId: true,
          code: true,
          analysisDate: true,
          evaluatedAt: true,
          simulatedReturnPct: true,
          stockReturnPct: true,
          evalStatus: true,
          positionRecommendation: true,
          operationAdvice: true,
          stopLoss: true,
          takeProfit: true,
        },
      });

      rowsByWindow[String(evalWindowDays)] = rows.map((row) => ({
        analysis_history_id: row.analysisHistoryId,
        code: row.code,
        analysis_date: row.analysisDate?.toISOString().slice(0, 10) ?? null,
        evaluated_at: row.evaluatedAt.toISOString(),
        simulated_return_pct: row.simulatedReturnPct,
        stock_return_pct: row.stockReturnPct,
        eval_status: row.evalStatus,
        position_recommendation: row.positionRecommendation,
        operation_advice: row.operationAdvice,
        stop_loss: row.stopLoss,
        take_profit: row.takeProfit,
      }));
    }

    const payload = await this.backtestAgentClient.compare({
      eval_window_days_list: windows,
      strategy_codes: strategyCodes,
      neutral_band_pct: neutralBandPct,
      rows_by_window: rowsByWindow,
    });

    // Agent 端保证 strategy_code 稳定即可，展示名由 Backend 按当前内置映射兜底补齐。
    const items = asArrayOfRecords(payload.items).map((item) => ({
      ...item,
      strategy_name:
        typeof item.strategy_name === 'string'
          ? item.strategy_name
          : BACKTEST_COMPARE_STRATEGY_NAMES[String(item.strategy_code) as BacktestCompareStrategyCode] ?? String(item.strategy_code ?? ''),
    }));

    return {
      metric_definition_version: String(payload.metric_definition_version ?? 'v2'),
      items,
    };
  }

  private async loadStrategyRunGroupDetail(
    runGroupId: number,
    requester: { userId: number; includeAll: boolean },
  ): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.strategyBacktestRunGroup.findFirst({
      where: {
        id: runGroupId,
        ...(requester.includeAll ? {} : { ownerUserId: requester.userId }),
      },
      include: {
        runs: {
          orderBy: [{ strategyCode: 'asc' }, { id: 'asc' }],
          include: {
            trades: {
              orderBy: [{ entryDate: 'asc' }, { id: 'asc' }],
            },
            equityPoints: {
              orderBy: [{ tradeDate: 'asc' }, { id: 'asc' }],
            },
          },
        },
      },
    });
    if (!row) {
      return null;
    }

    return {
      run_group_id: row.id,
      code: row.code,
      engine_version: row.engineVersion,
      ai_interpretation_status: this.normalizeStrategyAiInterpretationStatus(row.aiInterpretationStatus),
      ai_interpretation_error_message: row.aiInterpretationErrorMessage ?? null,
      ai_interpretation_completed_at: this.toIsoDateTime(row.aiInterpretationCompletedAt),
      requested_range: {
        start_date: this.toIsoDay(row.startDate),
        end_date: this.toIsoDay(row.endDate),
      },
      effective_range: {
        start_date: this.toIsoDay(row.effectiveStartDate),
        end_date: this.toIsoDay(row.effectiveEndDate),
      },
      created_at: row.createdAt.toISOString(),
      items: row.runs.map((run) => {
        const metadata = this.resolveStoredStrategyMetadata(run.strategyCode, run.savedStrategyName);
        return {
          strategy_id: run.savedStrategyId ?? null,
          run_id: run.id,
          strategy_code: metadata.strategyCode,
          strategy_name: metadata.strategyName,
          template_code: metadata.templateCode,
          template_name: metadata.templateName,
          strategy_version: run.strategyVersion,
          params: run.paramsJson ?? {},
          metrics: run.metricsJson ?? {},
          benchmark: run.benchmarkJson ?? {},
          trades: run.trades.map((trade) => ({
            entry_date: this.toIsoDay(trade.entryDate),
            exit_date: this.toIsoDay(trade.exitDate),
            entry_price: trade.entryPrice,
            exit_price: trade.exitPrice,
            qty: trade.qty,
            gross_return_pct: trade.grossReturnPct,
            net_return_pct: trade.netReturnPct,
            fees: trade.fees,
            exit_reason: trade.exitReason,
          })),
          equity: run.equityPoints.map((point) => ({
            trade_date: this.toIsoDay(point.tradeDate),
            equity: point.equity,
            drawdown_pct: point.drawdownPct,
            benchmark_equity: point.benchmarkEquity,
          })),
        };
      }),
      legacy_event_backtest: false,
    };
  }

  async runStrategyRange(input: {
    code: string;
    startDate: string;
    endDate: string;
    strategyIds?: number[];
    strategyCodes?: string[];
    strategies?: Array<Record<string, unknown>>;
    initialCapital?: number;
    commissionRate?: number;
    slippageBps?: number;
    requester: { userId: number; includeAll: boolean };
  }): Promise<Record<string, unknown>> {
    // 策略区间回测先把用户自定义策略解析成标准模板参数，再统一交给 Agent 执行并回写明细。
    const code = String(input.code ?? '').trim();
    if (!code) {
      throw buildServiceError('VALIDATION_ERROR', 'code is required');
    }

    const startDate = this.parseDayText(input.startDate);
    const endDate = this.parseDayText(input.endDate);
    if (!startDate || !endDate) {
      throw buildServiceError('VALIDATION_ERROR', 'start_date and end_date are required');
    }
    if (startDate.getTime() > endDate.getTime()) {
      throw buildServiceError('VALIDATION_ERROR', 'start_date must be <= end_date');
    }

    const resolvedStrategies = Array.isArray(input.strategies) && input.strategies.length > 0
      ? this.normalizeInlineRunStrategies(input.strategies.map(item => asRecord(item)))
      : await this.userBacktestStrategyService.resolveRunStrategies({
        userId: input.requester.userId,
        strategyIds: input.strategyIds,
        strategyCodes: input.strategyCodes,
      });
    const initialCapital = this.toNumber(input.initialCapital);
    const commissionRate = this.toNumber(input.commissionRate);
    const slippageBps = this.toNumber(input.slippageBps);

    const payload = await this.backtestAgentClient.strategyRun({
      code,
      start_date: this.toIsoDay(startDate),
      end_date: this.toIsoDay(endDate),
      strategies: resolvedStrategies.map((strategy) => ({
        strategy_id: strategy.strategyId,
        strategy_name: strategy.strategyName,
        template_code: strategy.templateCode,
        params: strategy.params,
      })),
      ...(initialCapital != null ? { initial_capital: initialCapital } : {}),
      ...(commissionRate != null ? { commission_rate: commissionRate } : {}),
      ...(slippageBps != null ? { slippage_bps: slippageBps } : {}),
    });

    const requestedRange = asRecord(payload.requested_range);
    const effectiveRange = asRecord(payload.effective_range);
    const items = asArrayOfRecords(payload.items);
    if (items.length === 0) {
      throw new Error('strategy backtest returned empty items');
    }
    const engineVersion = String(payload.engine_version ?? 'backtrader_v1');

    const runGroupId = await this.prisma.$transaction(async (tx) => {
      const group = await tx.strategyBacktestRunGroup.create({
        data: {
          ownerUserId: input.requester.userId,
          code,
          startDate: this.parseDayText(requestedRange.start_date ?? this.toIsoDay(startDate)) ?? startDate,
          endDate: this.parseDayText(requestedRange.end_date ?? this.toIsoDay(endDate)) ?? endDate,
          effectiveStartDate: this.parseDayText(effectiveRange.start_date),
          effectiveEndDate: this.parseDayText(effectiveRange.end_date),
          engineVersion,
          aiInterpretationStatus: 'pending',
          aiInterpretationAttempts: 0,
          aiInterpretationRequestedAt: new Date(),
          aiInterpretationStartedAt: null,
          aiInterpretationCompletedAt: null,
          aiInterpretationNextRetryAt: null,
          aiInterpretationErrorMessage: null,
        },
      });

      for (const item of items) {
        const metadata = this.resolveStoredStrategyMetadata(
          String(item.template_code ?? item.strategy_code ?? '').trim(),
          this.normalizeSavedStrategyName(item.strategy_name),
        );
        if (!metadata.strategyCode) {
          continue;
        }
        const run = await tx.strategyBacktestRun.create({
          data: {
            runGroupId: group.id,
            savedStrategyId: this.normalizeSavedStrategyId(item.strategy_id),
            savedStrategyName: metadata.strategyName,
            strategyCode: metadata.templateCode,
            strategyVersion: String(item.strategy_version ?? 'v1'),
            paramsJson: toPrismaJson(asRecord(item.params)),
            metricsJson: toPrismaJson(asRecord(item.metrics)),
            benchmarkJson: toPrismaJson(asRecord(item.benchmark)),
          },
        });

        const trades = asArrayOfRecords(item.trades);
        if (trades.length > 0) {
          await tx.strategyBacktestTrade.createMany({
            data: trades.map((trade) => ({
              runId: run.id,
              entryDate: this.parseDayText(trade.entry_date),
              exitDate: this.parseDayText(trade.exit_date),
              entryPrice: this.toNumber(trade.entry_price),
              exitPrice: this.toNumber(trade.exit_price),
              qty: this.toNumber(trade.qty) != null ? Math.trunc(Number(trade.qty)) : null,
              grossReturnPct: this.toNumber(trade.gross_return_pct),
              netReturnPct: this.toNumber(trade.net_return_pct),
              fees: this.toNumber(trade.fees),
              exitReason: String(trade.exit_reason ?? ''),
            })),
          });
        }

        const equity = asArrayOfRecords(item.equity);
        if (equity.length > 0) {
          await tx.strategyBacktestEquityPoint.createMany({
            data: equity
              .map((point) => ({
                runId: run.id,
                tradeDate: this.parseDayText(point.trade_date),
                equity: this.toNumber(point.equity),
                drawdownPct: this.toNumber(point.drawdown_pct),
                benchmarkEquity: this.toNumber(point.benchmark_equity),
              }))
              .filter((point) => point.tradeDate != null && point.equity != null)
              .map((point) => ({
                runId: point.runId,
                tradeDate: point.tradeDate as Date,
                equity: point.equity as number,
                drawdownPct: point.drawdownPct,
                benchmarkEquity: point.benchmarkEquity,
              })),
          });
        }
      }

      return group.id;
    });

    const detail = await this.loadStrategyRunGroupDetail(runGroupId, input.requester);
    if (!detail) {
      throw new Error('strategy backtest run not found after persistence');
    }
    return detail;
  }

  async listStrategyRuns(input: {
    code?: string;
    strategyCode?: string;
    startDate?: string;
    endDate?: string;
    page: number;
    limit: number;
    requester: { userId: number; includeAll: boolean };
  }): Promise<Record<string, unknown>> {
    const parsedStart = input.startDate ? this.parseDayText(input.startDate) : null;
    const parsedEnd = input.endDate ? this.parseDayText(input.endDate) : null;
    const strategyCodeCandidates = this.buildStoredStrategyCodeCandidates(input.strategyCode);
    const code = String(input.code ?? '').trim();

    const where: Prisma.StrategyBacktestRunGroupWhereInput = {
      ...(input.requester.includeAll ? {} : { ownerUserId: input.requester.userId }),
      ...(code ? { code } : {}),
      ...(parsedStart ? { endDate: { gte: parsedStart } } : {}),
      ...(parsedEnd ? { startDate: { lte: parsedEnd } } : {}),
      ...(strategyCodeCandidates.length > 0
        ? {
            runs: {
              some: {
                strategyCode: {
                  in: strategyCodeCandidates,
                },
              },
            },
          }
        : {}),
    };

    const total = await this.prisma.strategyBacktestRunGroup.count({ where });
    const rows = await this.prisma.strategyBacktestRunGroup.findMany({
      where,
      include: {
        runs: {
          orderBy: [{ strategyCode: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            savedStrategyId: true,
            savedStrategyName: true,
            strategyCode: true,
            strategyVersion: true,
            metricsJson: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (input.page - 1) * input.limit,
      take: input.limit,
    });

    return {
      total,
      page: input.page,
      limit: input.limit,
      items: rows.map((row) => ({
        run_group_id: row.id,
        code: row.code,
        engine_version: row.engineVersion,
        ai_interpretation_status: this.normalizeStrategyAiInterpretationStatus(row.aiInterpretationStatus),
        ai_interpretation_error_message: row.aiInterpretationErrorMessage ?? null,
        ai_interpretation_completed_at: this.toIsoDateTime(row.aiInterpretationCompletedAt),
        requested_range: {
          start_date: this.toIsoDay(row.startDate),
          end_date: this.toIsoDay(row.endDate),
        },
        effective_range: {
          start_date: this.toIsoDay(row.effectiveStartDate),
          end_date: this.toIsoDay(row.effectiveEndDate),
        },
        created_at: row.createdAt.toISOString(),
        strategies: row.runs.map((run) => {
          const metadata = this.resolveStoredStrategyMetadata(run.strategyCode, run.savedStrategyName);
          return {
            strategy_id: run.savedStrategyId ?? null,
            run_id: run.id,
            strategy_code: metadata.strategyCode,
            strategy_name: metadata.strategyName,
            template_code: metadata.templateCode,
            template_name: metadata.templateName,
            strategy_version: run.strategyVersion,
            metrics: run.metricsJson ?? {},
          };
        }),
      })),
      legacy_event_backtest: false,
    };
  }

  async getStrategyRunDetail(input: {
    runGroupId: number;
    requester: { userId: number; includeAll: boolean };
  }): Promise<Record<string, unknown> | null> {
    let detail = await this.loadStrategyRunGroupDetail(input.runGroupId, input.requester);
    if (!detail) {
      return null;
    }

    if (this.detailNeedsStrategyAiHydration(detail)) {
      try {
        await this.hydrateStrategyRunGroupInterpretations(input.runGroupId);
        detail = await this.loadStrategyRunGroupDetail(input.runGroupId, input.requester) ?? detail;
      } catch (error: unknown) {
        this.logger.warn(
          `Failed to lazy-hydrate strategy AI interpretation runGroupId=${input.runGroupId}: ${(error as Error)?.message ?? error}`,
        );
      }
    }

    return detail;
  }

  async getSummary(
    scope: 'overall' | 'stock',
    code: string | undefined,
    evalWindowDays: number | undefined,
    requester: { userId: number; includeAll: boolean },
  ): Promise<Record<string, unknown> | null> {
    const engineVersion = String(process.env.BACKTEST_ENGINE_VERSION ?? 'v1');
    const lookupCode = scope === 'overall' ? OVERALL_SENTINEL_CODE : String(code ?? '');
    const includeAllEvalWindowDays = evalWindowDays ?? Number(process.env.BACKTEST_EVAL_WINDOW_DAYS ?? 10);

    if (requester.includeAll) {
      const rows = await this.prisma.backtestResult.findMany({
        where: {
          engineVersion,
          evalWindowDays: includeAllEvalWindowDays,
          ...(scope === 'stock' ? { code: lookupCode } : {}),
        },
        select: {
          evalStatus: true,
          positionRecommendation: true,
          outcome: true,
          directionCorrect: true,
          stockReturnPct: true,
          simulatedReturnPct: true,
          hitStopLoss: true,
          hitTakeProfit: true,
          firstHit: true,
          firstHitTradingDays: true,
          operationAdvice: true,
        },
      });
      if (rows.length === 0) {
        return null;
      }

      return await this.computeSummaryViaAgent({
        scope,
        code: lookupCode,
        evalWindowDays: includeAllEvalWindowDays,
        engineVersion,
        rows,
      });
    }

    const row = await this.prisma.backtestSummary.findFirst({
      where: {
        ownerUserId: requester.userId,
        scope,
        code: lookupCode,
        engineVersion,
        evalWindowDays: includeAllEvalWindowDays,
      },
      orderBy: { computedAt: 'desc' },
    });

    if (!row) return null;
    const rowRecord = row as unknown as Record<string, unknown>;

    return this.mapSummary({
      scope: row.scope,
      code: row.code,
      evalWindowDays: row.evalWindowDays,
      engineVersion: row.engineVersion,
      computedAt: row.computedAt,
      totalEvaluations: row.totalEvaluations,
      completedCount: row.completedCount,
      insufficientCount: row.insufficientCount,
      longCount: row.longCount,
      cashCount: row.cashCount,
      winCount: row.winCount,
      lossCount: row.lossCount,
      neutralCount: row.neutralCount,
      directionAccuracyPct: row.directionAccuracyPct,
      predictionWinRatePct: this.toNumber(rowRecord.predictionWinRatePct ?? row.winRatePct),
      tradeWinRatePct: this.toNumber(rowRecord.tradeWinRatePct ?? row.winRatePct),
      winRatePct: row.winRatePct,
      neutralRatePct: row.neutralRatePct,
      avgStockReturnPct: row.avgStockReturnPct,
      avgSimulatedReturnPct: row.avgSimulatedReturnPct,
      stopLossTriggerRate: row.stopLossTriggerRate,
      takeProfitTriggerRate: row.takeProfitTriggerRate,
      ambiguousRate: row.ambiguousRate,
      avgDaysToFirstHit: row.avgDaysToFirstHit,
      adviceBreakdown: safeJsonParse(row.adviceBreakdownJson, {}),
      diagnostics: safeJsonParse(row.diagnosticsJson, {}),
    });
  }
}
