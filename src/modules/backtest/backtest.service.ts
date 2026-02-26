import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '@/common/database/prisma.service';
import { BacktestEngine, OVERALL_SENTINEL_CODE } from '@/common/backtest/backtest-engine';
import { safeJsonParse, safeJsonStringify } from '@/common/utils/json';
import { StocksService } from '@/modules/stocks/stocks.service';

@Injectable()
export class BacktestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stocksService: StocksService,
  ) {}

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

  private buildOwnerFilter(scope: { userId: number; includeAll: boolean }): Prisma.BacktestResultWhereInput {
    if (scope.includeAll) {
      return {};
    }
    return { ownerUserId: scope.userId };
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
    };
  }

  private defaultEvalWindowDays(): number {
    return Number(process.env.BACKTEST_EVAL_WINDOW_DAYS ?? 10);
  }

  private resolveScopeCode(scope: 'overall' | 'stock', code?: string): string {
    return scope === 'overall' ? OVERALL_SENTINEL_CODE : String(code ?? '').trim();
  }

  private round4(value: number): number {
    return Math.round(value * 10000) / 10000;
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

  private buildCurves(
    rows: Array<{
      analysisDate: Date | null;
      evaluatedAt: Date;
      simulatedReturnPct: number | null;
      stockReturnPct: number | null;
      evalStatus: string;
    }>,
  ): Array<{
    label: string;
    strategy_return_pct: number;
    benchmark_return_pct: number;
    drawdown_pct: number;
  }> {
    const completed = [...rows]
      .filter((item) => item.evalStatus === 'completed')
      .sort((a, b) => {
        const aTime = a.analysisDate?.getTime() ?? a.evaluatedAt.getTime();
        const bTime = b.analysisDate?.getTime() ?? b.evaluatedAt.getTime();
        return aTime - bTime;
      });

    let strategyEquity = 1;
    let benchmarkEquity = 1;
    let peak = 1;

    return completed.map((row) => {
      const strategy = Number(row.simulatedReturnPct ?? 0);
      const benchmark = Number(row.stockReturnPct ?? 0);
      strategyEquity *= 1 + strategy / 100;
      benchmarkEquity *= 1 + benchmark / 100;

      if (strategyEquity > peak) {
        peak = strategyEquity;
      }
      const drawdown = ((strategyEquity / peak) - 1) * 100;

      return {
        label: row.analysisDate?.toISOString().slice(0, 10) ?? row.evaluatedAt.toISOString(),
        strategy_return_pct: this.round4((strategyEquity - 1) * 100),
        benchmark_return_pct: this.round4((benchmarkEquity - 1) * 100),
        drawdown_pct: this.round4(drawdown),
      };
    });
  }

  private maxDrawdown(curves: Array<{ drawdown_pct: number }>): number | null {
    if (curves.length === 0) {
      return null;
    }
    return curves.reduce((min, item) => Math.min(min, item.drawdown_pct), curves[0].drawdown_pct);
  }

  async run(input: {
    code?: string;
    force: boolean;
    evalWindowDays?: number;
    minAgeDays?: number;
    limit: number;
    scope: { userId: number; includeAll: boolean };
  }): Promise<Record<string, number>> {
    const evalWindowDays = Number(input.evalWindowDays ?? process.env.BACKTEST_EVAL_WINDOW_DAYS ?? 10);
    const minAgeDays = Number(input.minAgeDays ?? process.env.BACKTEST_MIN_AGE_DAYS ?? 14);
    const engineVersion = String(process.env.BACKTEST_ENGINE_VERSION ?? 'v1');
    const neutralBandPct = Number(process.env.BACKTEST_NEUTRAL_BAND_PCT ?? 2.0);

    const cutoff = new Date(Date.now() - minAgeDays * 24 * 3600 * 1000);

    const candidates = await this.prisma.analysisHistory.findMany({
      where: {
        ...(input.scope.includeAll ? {} : { ownerUserId: input.scope.userId }),
        ...(input.code ? { code: input.code } : {}),
        createdAt: { lte: cutoff },
      },
      orderBy: { createdAt: 'desc' },
      take: input.limit,
    });

    let processed = 0;
    let saved = 0;
    let completed = 0;
    let insufficient = 0;
    let errors = 0;

    const touchedCodesByOwner = new Map<number | null, Set<string>>();

    for (const candidate of candidates) {
      processed += 1;
      if (!touchedCodesByOwner.has(candidate.ownerUserId)) {
        touchedCodesByOwner.set(candidate.ownerUserId, new Set<string>());
      }
      touchedCodesByOwner.get(candidate.ownerUserId)!.add(candidate.code);

      try {
        if (!input.force) {
          const existing = await this.prisma.backtestResult.findUnique({
            where: {
              analysisHistoryId_evalWindowDays_engineVersion: {
                analysisHistoryId: candidate.id,
                evalWindowDays,
                engineVersion,
              },
            },
          });

          if (existing) {
            continue;
          }
        }

        const analysisDate = this.resolveAnalysisDate(candidate.contextSnapshot, candidate.createdAt);

        const marketBars = await this.stocksService.getStartAndForwardBars(candidate.code, analysisDate, evalWindowDays);

        const startPrice = marketBars.startPrice;
        const startDate = marketBars.startDate;

        let evaluation: Record<string, unknown>;
        if (!startPrice || !startDate) {
          evaluation = {
            analysisDate,
            evalWindowDays,
            engineVersion,
            evalStatus: 'insufficient_data',
            operationAdvice: candidate.operationAdvice,
          };
          insufficient += 1;
        } else {
          evaluation = BacktestEngine.evaluateSingle({
            operationAdvice: candidate.operationAdvice,
            analysisDate: startDate,
            startPrice,
            forwardBars: marketBars.forwardBars,
            stopLoss: candidate.stopLoss,
            takeProfit: candidate.takeProfit,
            config: {
              evalWindowDays,
              neutralBandPct,
              engineVersion,
            },
          });

          if (evaluation.evalStatus === 'completed') completed += 1;
          else if (evaluation.evalStatus === 'insufficient_data') insufficient += 1;
          else errors += 1;
        }

        await this.prisma.backtestResult.upsert({
          where: {
            analysisHistoryId_evalWindowDays_engineVersion: {
              analysisHistoryId: candidate.id,
              evalWindowDays,
              engineVersion,
            },
          },
          update: {
            ownerUserId: candidate.ownerUserId,
            code: candidate.code,
            analysisDate: (evaluation.analysisDate as Date | undefined) ?? null,
            evalStatus: String(evaluation.evalStatus ?? 'error'),
            operationAdvice: (evaluation.operationAdvice as string | undefined) ?? candidate.operationAdvice,
            positionRecommendation: (evaluation.positionRecommendation as string | undefined) ?? null,
            startPrice: (evaluation.startPrice as number | undefined) ?? null,
            endClose: (evaluation.endClose as number | undefined) ?? null,
            maxHigh: (evaluation.maxHigh as number | undefined) ?? null,
            minLow: (evaluation.minLow as number | undefined) ?? null,
            stockReturnPct: (evaluation.stockReturnPct as number | undefined) ?? null,
            directionExpected: (evaluation.directionExpected as string | undefined) ?? null,
            directionCorrect: (evaluation.directionCorrect as boolean | null | undefined) ?? null,
            outcome: (evaluation.outcome as string | undefined) ?? null,
            stopLoss: (evaluation.stopLoss as number | undefined) ?? null,
            takeProfit: (evaluation.takeProfit as number | undefined) ?? null,
            hitStopLoss: (evaluation.hitStopLoss as boolean | null | undefined) ?? null,
            hitTakeProfit: (evaluation.hitTakeProfit as boolean | null | undefined) ?? null,
            firstHit: (evaluation.firstHit as string | undefined) ?? null,
            firstHitDate: (evaluation.firstHitDate as Date | undefined) ?? null,
            firstHitTradingDays: (evaluation.firstHitTradingDays as number | undefined) ?? null,
            simulatedEntryPrice: (evaluation.simulatedEntryPrice as number | undefined) ?? null,
            simulatedExitPrice: (evaluation.simulatedExitPrice as number | undefined) ?? null,
            simulatedExitReason: (evaluation.simulatedExitReason as string | undefined) ?? null,
            simulatedReturnPct: (evaluation.simulatedReturnPct as number | undefined) ?? null,
            evaluatedAt: new Date(),
          },
          create: {
            ownerUserId: candidate.ownerUserId,
            analysisHistoryId: candidate.id,
            code: candidate.code,
            analysisDate: (evaluation.analysisDate as Date | undefined) ?? null,
            evalWindowDays,
            engineVersion,
            evalStatus: String(evaluation.evalStatus ?? 'error'),
            operationAdvice: (evaluation.operationAdvice as string | undefined) ?? candidate.operationAdvice,
            positionRecommendation: (evaluation.positionRecommendation as string | undefined) ?? null,
            startPrice: (evaluation.startPrice as number | undefined) ?? null,
            endClose: (evaluation.endClose as number | undefined) ?? null,
            maxHigh: (evaluation.maxHigh as number | undefined) ?? null,
            minLow: (evaluation.minLow as number | undefined) ?? null,
            stockReturnPct: (evaluation.stockReturnPct as number | undefined) ?? null,
            directionExpected: (evaluation.directionExpected as string | undefined) ?? null,
            directionCorrect: (evaluation.directionCorrect as boolean | null | undefined) ?? null,
            outcome: (evaluation.outcome as string | undefined) ?? null,
            stopLoss: (evaluation.stopLoss as number | undefined) ?? null,
            takeProfit: (evaluation.takeProfit as number | undefined) ?? null,
            hitStopLoss: (evaluation.hitStopLoss as boolean | null | undefined) ?? null,
            hitTakeProfit: (evaluation.hitTakeProfit as boolean | null | undefined) ?? null,
            firstHit: (evaluation.firstHit as string | undefined) ?? null,
            firstHitDate: (evaluation.firstHitDate as Date | undefined) ?? null,
            firstHitTradingDays: (evaluation.firstHitTradingDays as number | undefined) ?? null,
            simulatedEntryPrice: (evaluation.simulatedEntryPrice as number | undefined) ?? null,
            simulatedExitPrice: (evaluation.simulatedExitPrice as number | undefined) ?? null,
            simulatedExitReason: (evaluation.simulatedExitReason as string | undefined) ?? null,
            simulatedReturnPct: (evaluation.simulatedReturnPct as number | undefined) ?? null,
            evaluatedAt: new Date(),
          },
        });

        saved += 1;
      } catch {
        errors += 1;
      }
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

  private async recomputeSummaries(
    evalWindowDays: number,
    engineVersion: string,
    touchedCodesByOwner: Map<number | null, Set<string>>,
  ): Promise<void> {
    for (const [ownerUserId, touchedCodes] of touchedCodesByOwner.entries()) {
      const ownerWhere = ownerUserId == null ? { ownerUserId: null } : { ownerUserId };

      const overallRows = await this.prisma.backtestResult.findMany({
        where: { ...ownerWhere, evalWindowDays, engineVersion },
      });

      const overall = BacktestEngine.computeSummary({
        results: overallRows,
        scope: 'overall',
        code: OVERALL_SENTINEL_CODE,
        evalWindowDays,
        engineVersion,
      });

      await this.upsertSummary(overall, ownerUserId);

      for (const code of touchedCodes) {
        const rows = await this.prisma.backtestResult.findMany({
          where: { ...ownerWhere, code, evalWindowDays, engineVersion },
        });

        const summary = BacktestEngine.computeSummary({
          results: rows,
          scope: 'stock',
          code,
          evalWindowDays,
          engineVersion,
        });

        await this.upsertSummary(summary, ownerUserId);
      }
    }
  }

  private async upsertSummary(summary: Record<string, unknown>, ownerUserId: number | null): Promise<void> {
    const scope = String(summary.scope);
    const code = String(summary.code);
    const evalWindowDays = Number(summary.evalWindowDays);
    const engineVersion = String(summary.engineVersion);
    const data = {
      ownerUserId,
      scope,
      code,
      evalWindowDays,
      engineVersion,
      computedAt: new Date(),
      totalEvaluations: Number(summary.totalEvaluations ?? 0),
      completedCount: Number(summary.completedCount ?? 0),
      insufficientCount: Number(summary.insufficientCount ?? 0),
      longCount: Number(summary.longCount ?? 0),
      cashCount: Number(summary.cashCount ?? 0),
      winCount: Number(summary.winCount ?? 0),
      lossCount: Number(summary.lossCount ?? 0),
      neutralCount: Number(summary.neutralCount ?? 0),
      directionAccuracyPct: (summary.directionAccuracyPct as number | null) ?? null,
      winRatePct: (summary.winRatePct as number | null) ?? null,
      neutralRatePct: (summary.neutralRatePct as number | null) ?? null,
      avgStockReturnPct: (summary.avgStockReturnPct as number | null) ?? null,
      avgSimulatedReturnPct: (summary.avgSimulatedReturnPct as number | null) ?? null,
      stopLossTriggerRate: (summary.stopLossTriggerRate as number | null) ?? null,
      takeProfitTriggerRate: (summary.takeProfitTriggerRate as number | null) ?? null,
      ambiguousRate: (summary.ambiguousRate as number | null) ?? null,
      avgDaysToFirstHit: (summary.avgDaysToFirstHit as number | null) ?? null,
      adviceBreakdownJson: safeJsonStringify(summary.adviceBreakdown),
      diagnosticsJson: safeJsonStringify(summary.diagnostics),
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
          data,
        });
        return;
      }
      await this.prisma.backtestSummary.create({ data });
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
      update: data,
      create: data,
    });
  }

  async listResults(input: {
    code?: string;
    evalWindowDays?: number;
    page: number;
    limit: number;
    scope: { userId: number; includeAll: boolean };
  }): Promise<Record<string, unknown>> {
    const where: Prisma.BacktestResultWhereInput = this.buildOwnerFilter(input.scope);
    if (input.code) where.code = input.code;
    if (input.evalWindowDays != null) where.evalWindowDays = input.evalWindowDays;

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
        analysisDate: true,
        evaluatedAt: true,
        simulatedReturnPct: true,
        stockReturnPct: true,
        evalStatus: true,
      },
    });

    return {
      scope: input.scope,
      code: input.scope === 'stock' ? lookupCode : null,
      eval_window_days: evalWindowDays,
      curves: this.buildCurves(rows),
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

    const rows = await this.prisma.backtestResult.findMany({ where });
    if (rows.length === 0) {
      return {
        scope: input.scope,
        code: input.scope === 'stock' ? lookupCode : null,
        eval_window_days: evalWindowDays,
        distribution: {
          long_count: 0,
          cash_count: 0,
          win_count: 0,
          loss_count: 0,
          neutral_count: 0,
        },
      };
    }

    const summary = BacktestEngine.computeSummary({
      results: rows,
      scope: input.scope,
      code: lookupCode,
      evalWindowDays,
      engineVersion,
    });

    return {
      scope: input.scope,
      code: input.scope === 'stock' ? lookupCode : null,
      eval_window_days: evalWindowDays,
      distribution: {
        long_count: Number(summary.longCount ?? 0),
        cash_count: Number(summary.cashCount ?? 0),
        win_count: Number(summary.winCount ?? 0),
        loss_count: Number(summary.lossCount ?? 0),
        neutral_count: Number(summary.neutralCount ?? 0),
      },
    };
  }

  async compareWindows(input: {
    code?: string;
    evalWindowDaysList: number[];
    requester: { userId: number; includeAll: boolean };
  }): Promise<Record<string, unknown>> {
    const normalizedCode = String(input.code ?? '').trim();
    const scope: 'overall' | 'stock' = normalizedCode ? 'stock' : 'overall';
    const lookupCode = this.resolveScopeCode(scope, normalizedCode);
    const engineVersion = String(process.env.BACKTEST_ENGINE_VERSION ?? 'v1');
    const windows = Array.from(
      new Set(
        input.evalWindowDaysList
          .map((item) => Math.trunc(Number(item)))
          .filter((item) => Number.isFinite(item) && item > 0 && item <= 120),
      ),
    ).sort((a, b) => a - b);

    const items: Array<Record<string, unknown>> = [];
    for (const evalWindowDays of windows) {
      const where = this.buildScopeWhere({
        scope,
        code: normalizedCode,
        evalWindowDays,
        requester: input.requester,
      });

      const rows = await this.prisma.backtestResult.findMany({ where });
      if (rows.length === 0) {
        items.push({
          eval_window_days: evalWindowDays,
          total_evaluations: 0,
          completed_count: 0,
          direction_accuracy_pct: null,
          win_rate_pct: null,
          avg_simulated_return_pct: null,
          avg_stock_return_pct: null,
          max_drawdown_pct: null,
          data_source: 'api',
        });
        continue;
      }

      const summary = BacktestEngine.computeSummary({
        results: rows,
        scope,
        code: lookupCode,
        evalWindowDays,
        engineVersion,
      });
      const curves = this.buildCurves(rows);

      items.push({
        eval_window_days: evalWindowDays,
        total_evaluations: Number(summary.totalEvaluations ?? 0),
        completed_count: Number(summary.completedCount ?? 0),
        direction_accuracy_pct: (summary.directionAccuracyPct as number | null) ?? null,
        win_rate_pct: (summary.winRatePct as number | null) ?? null,
        avg_simulated_return_pct: (summary.avgSimulatedReturnPct as number | null) ?? null,
        avg_stock_return_pct: (summary.avgStockReturnPct as number | null) ?? null,
        max_drawdown_pct: this.maxDrawdown(curves),
        data_source: 'api',
      });
    }

    return { items };
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
      });
      if (rows.length === 0) {
        return null;
      }

      const summary = BacktestEngine.computeSummary({
        results: rows,
        scope,
        code: lookupCode,
        evalWindowDays: includeAllEvalWindowDays,
        engineVersion,
      });

      return this.mapSummary({
        scope: String(summary.scope),
        code: String(summary.code),
        evalWindowDays: Number(summary.evalWindowDays),
        engineVersion: String(summary.engineVersion),
        totalEvaluations: Number(summary.totalEvaluations ?? 0),
        completedCount: Number(summary.completedCount ?? 0),
        insufficientCount: Number(summary.insufficientCount ?? 0),
        longCount: Number(summary.longCount ?? 0),
        cashCount: Number(summary.cashCount ?? 0),
        winCount: Number(summary.winCount ?? 0),
        lossCount: Number(summary.lossCount ?? 0),
        neutralCount: Number(summary.neutralCount ?? 0),
        directionAccuracyPct: (summary.directionAccuracyPct as number | null) ?? null,
        winRatePct: (summary.winRatePct as number | null) ?? null,
        neutralRatePct: (summary.neutralRatePct as number | null) ?? null,
        avgStockReturnPct: (summary.avgStockReturnPct as number | null) ?? null,
        avgSimulatedReturnPct: (summary.avgSimulatedReturnPct as number | null) ?? null,
        stopLossTriggerRate: (summary.stopLossTriggerRate as number | null) ?? null,
        takeProfitTriggerRate: (summary.takeProfitTriggerRate as number | null) ?? null,
        ambiguousRate: (summary.ambiguousRate as number | null) ?? null,
        avgDaysToFirstHit: (summary.avgDaysToFirstHit as number | null) ?? null,
        adviceBreakdown: summary.adviceBreakdown,
        diagnostics: summary.diagnostics,
      });
    }

    const row = await this.prisma.backtestSummary.findFirst({
      where: {
        ownerUserId: requester.userId,
        scope,
        code: lookupCode,
        engineVersion,
        ...(evalWindowDays != null ? { evalWindowDays } : {}),
      },
      orderBy: { computedAt: 'desc' },
    });

    if (!row) return null;

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
