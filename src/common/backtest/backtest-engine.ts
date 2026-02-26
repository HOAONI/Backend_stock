export const OVERALL_SENTINEL_CODE = '__overall__';

export interface DailyBarLike {
  date: Date;
  high: number | null;
  low: number | null;
  close: number | null;
}

export interface BacktestResultLike {
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
}

export interface EvaluationConfig {
  evalWindowDays: number;
  neutralBandPct: number;
  engineVersion: string;
}

function normalize(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export class BacktestEngine {
  private static readonly bullishKeywords = ['买入', '加仓', '强烈买入', '增持', '建仓', 'strong buy', 'buy', 'add'];
  private static readonly bearishKeywords = ['卖出', '减仓', '强烈卖出', '清仓', 'strong sell', 'sell', 'reduce'];
  private static readonly holdKeywords = ['持有', 'hold'];
  private static readonly waitKeywords = ['观望', '等待', 'wait'];
  private static readonly negationPatterns = ['not', "don't", 'do not', 'no', 'never', 'avoid', '不要', '不', '别', '勿', '没有'];

  static inferDirectionExpected(operationAdvice: string | null | undefined): string {
    const text = normalize(operationAdvice);
    if (this.matchesIntent(text, this.bearishKeywords)) return 'down';
    if (this.matchesIntent(text, this.waitKeywords)) return 'flat';
    if (this.matchesIntent(text, this.bullishKeywords)) return 'up';
    if (this.matchesIntent(text, this.holdKeywords)) return 'not_down';
    return 'flat';
  }

  static inferPositionRecommendation(operationAdvice: string | null | undefined): string {
    const text = normalize(operationAdvice);
    if (this.matchesIntent(text, this.bearishKeywords) || this.matchesIntent(text, this.waitKeywords)) return 'cash';
    if (this.matchesIntent(text, this.bullishKeywords) || this.matchesIntent(text, this.holdKeywords)) return 'long';
    return 'cash';
  }

  static evaluateSingle(input: {
    operationAdvice: string | null | undefined;
    analysisDate: Date;
    startPrice: number;
    forwardBars: DailyBarLike[];
    stopLoss: number | null;
    takeProfit: number | null;
    config: EvaluationConfig;
  }): Record<string, unknown> {
    const { operationAdvice, analysisDate, startPrice, forwardBars, stopLoss, takeProfit, config } = input;

    if (!Number.isFinite(startPrice) || startPrice <= 0) {
      return {
        analysisDate,
        operationAdvice,
        positionRecommendation: this.inferPositionRecommendation(operationAdvice),
        directionExpected: this.inferDirectionExpected(operationAdvice),
        evalStatus: 'error',
      };
    }

    const evalDays = Number(config.evalWindowDays);
    if (forwardBars.length < evalDays) {
      return {
        analysisDate,
        operationAdvice,
        positionRecommendation: this.inferPositionRecommendation(operationAdvice),
        directionExpected: this.inferDirectionExpected(operationAdvice),
        evalStatus: 'insufficient_data',
        evalWindowDays: evalDays,
      };
    }

    const windowBars = [...forwardBars].slice(0, evalDays);
    const endClose = windowBars.at(-1)?.close ?? null;
    const highs = windowBars.map((x) => x.high).filter((x): x is number => x != null);
    const lows = windowBars.map((x) => x.low).filter((x): x is number => x != null);
    const maxHigh = highs.length ? Math.max(...highs) : null;
    const minLow = lows.length ? Math.min(...lows) : null;

    const stockReturnPct = endClose == null ? null : ((endClose - startPrice) / startPrice) * 100;
    const directionExpected = this.inferDirectionExpected(operationAdvice);
    const positionRecommendation = this.inferPositionRecommendation(operationAdvice);

    const [outcome, directionCorrect] = this.classifyOutcome(stockReturnPct, directionExpected, config.neutralBandPct);

    const targetEvaluation = this.evaluateTargets(positionRecommendation, stopLoss, takeProfit, windowBars, endClose);

    const simulatedEntryPrice = positionRecommendation === 'long' ? startPrice : null;
    const simulatedReturnPct =
      positionRecommendation !== 'long'
        ? 0
        : targetEvaluation.simulatedExitPrice == null
          ? null
          : ((targetEvaluation.simulatedExitPrice - startPrice) / startPrice) * 100;

    return {
      analysisDate,
      evalWindowDays: evalDays,
      engineVersion: config.engineVersion,
      evalStatus: 'completed',
      operationAdvice,
      positionRecommendation,
      startPrice,
      endClose,
      maxHigh,
      minLow,
      stockReturnPct,
      directionExpected,
      directionCorrect,
      outcome,
      stopLoss,
      takeProfit,
      hitStopLoss: targetEvaluation.hitStopLoss,
      hitTakeProfit: targetEvaluation.hitTakeProfit,
      firstHit: targetEvaluation.firstHit,
      firstHitDate: targetEvaluation.firstHitDate,
      firstHitTradingDays: targetEvaluation.firstHitTradingDays,
      simulatedEntryPrice,
      simulatedExitPrice: targetEvaluation.simulatedExitPrice,
      simulatedExitReason: targetEvaluation.simulatedExitReason,
      simulatedReturnPct,
    };
  }

  static computeSummary(input: {
    results: BacktestResultLike[];
    scope: string;
    code: string | null;
    evalWindowDays: number;
    engineVersion: string;
  }): Record<string, unknown> {
    const results = input.results;
    const completed = results.filter((x) => x.evalStatus === 'completed');

    const totalEvaluations = results.length;
    const insufficientCount = results.filter((x) => x.evalStatus === 'insufficient_data').length;
    const longCount = completed.filter((x) => x.positionRecommendation === 'long').length;
    const cashCount = completed.filter((x) => x.positionRecommendation === 'cash').length;

    const winCount = completed.filter((x) => x.outcome === 'win').length;
    const lossCount = completed.filter((x) => x.outcome === 'loss').length;
    const neutralCount = completed.filter((x) => x.outcome === 'neutral').length;

    const directionRows = completed.filter((x) => x.directionCorrect != null);
    const directionAccuracyPct = directionRows.length
      ? round((directionRows.filter((x) => x.directionCorrect).length / directionRows.length) * 100)
      : null;

    const winLossDenominator = winCount + lossCount;
    const winRatePct = winLossDenominator ? round((winCount / winLossDenominator) * 100) : null;
    const neutralRatePct = completed.length ? round((neutralCount / completed.length) * 100) : null;

    const avgStockReturnPct = this.average(completed.map((x) => x.stockReturnPct));
    const avgSimulatedReturnPct = this.average(completed.map((x) => x.simulatedReturnPct));

    const stopApplicable = completed.filter((x) => x.positionRecommendation === 'long' && x.hitStopLoss != null);
    const takeApplicable = completed.filter((x) => x.positionRecommendation === 'long' && x.hitTakeProfit != null);
    const anyTargetApplicable = completed.filter(
      (x) => x.positionRecommendation === 'long' && (x.hitStopLoss != null || x.hitTakeProfit != null),
    );

    const stopLossTriggerRate = stopApplicable.length
      ? round((stopApplicable.filter((x) => x.hitStopLoss === true).length / stopApplicable.length) * 100)
      : null;
    const takeProfitTriggerRate = takeApplicable.length
      ? round((takeApplicable.filter((x) => x.hitTakeProfit === true).length / takeApplicable.length) * 100)
      : null;
    const ambiguousRate = anyTargetApplicable.length
      ? round((anyTargetApplicable.filter((x) => x.firstHit === 'ambiguous').length / anyTargetApplicable.length) * 100)
      : null;

    const avgDaysToFirstHit = this.average(
      anyTargetApplicable
        .filter((x) => x.firstHitTradingDays != null && ['stop_loss', 'take_profit', 'ambiguous'].includes(x.firstHit ?? ''))
        .map((x) => Number(x.firstHitTradingDays)),
    );

    const adviceBreakdown = this.computeAdviceBreakdown(completed);
    const diagnostics = this.computeDiagnostics(results);

    return {
      scope: input.scope,
      code: input.code,
      evalWindowDays: input.evalWindowDays,
      engineVersion: input.engineVersion,
      totalEvaluations,
      completedCount: completed.length,
      insufficientCount,
      longCount,
      cashCount,
      winCount,
      lossCount,
      neutralCount,
      directionAccuracyPct,
      winRatePct,
      neutralRatePct,
      avgStockReturnPct,
      avgSimulatedReturnPct,
      stopLossTriggerRate,
      takeProfitTriggerRate,
      ambiguousRate,
      avgDaysToFirstHit,
      adviceBreakdown,
      diagnostics,
    };
  }

  private static matchesIntent(text: string, keywords: string[]): boolean {
    if (!text) return false;

    for (const keyword of keywords) {
      if (text === keyword) return true;
    }

    for (const keyword of keywords) {
      const index = text.indexOf(keyword);
      if (index === -1) continue;
      if (!this.isNegated(text.slice(0, index))) return true;
    }

    return false;
  }

  private static isNegated(prefix: string): boolean {
    const stripped = prefix.trimEnd();
    return this.negationPatterns.some((x) => stripped.endsWith(x));
  }

  private static classifyOutcome(stockReturnPct: number | null, directionExpected: string, neutralBandPct: number): [string | null, boolean | null] {
    if (stockReturnPct == null) return [null, null];

    const band = Math.abs(neutralBandPct);
    const r = stockReturnPct;

    if (directionExpected === 'up') {
      if (r >= band) return ['win', true];
      if (r <= -band) return ['loss', false];
      return ['neutral', null];
    }

    if (directionExpected === 'down') {
      if (r <= -band) return ['win', true];
      if (r >= band) return ['loss', false];
      return ['neutral', null];
    }

    if (directionExpected === 'not_down') {
      if (r >= 0) return ['win', true];
      if (r <= -band) return ['loss', false];
      return ['neutral', null];
    }

    if (Math.abs(r) <= band) return ['win', true];
    return ['loss', false];
  }

  private static evaluateTargets(
    position: string,
    stopLoss: number | null,
    takeProfit: number | null,
    windowBars: DailyBarLike[],
    endClose: number | null,
  ): {
    hitStopLoss: boolean | null;
    hitTakeProfit: boolean | null;
    firstHit: string;
    firstHitDate: Date | null;
    firstHitTradingDays: number | null;
    simulatedExitPrice: number | null;
    simulatedExitReason: string;
  } {
    if (position !== 'long') {
      return {
        hitStopLoss: null,
        hitTakeProfit: null,
        firstHit: 'not_applicable',
        firstHitDate: null,
        firstHitTradingDays: null,
        simulatedExitPrice: null,
        simulatedExitReason: 'cash',
      };
    }

    if (stopLoss == null && takeProfit == null) {
      return {
        hitStopLoss: null,
        hitTakeProfit: null,
        firstHit: 'neither',
        firstHitDate: null,
        firstHitTradingDays: null,
        simulatedExitPrice: endClose,
        simulatedExitReason: 'window_end',
      };
    }

    let hitStopLoss: boolean | null = stopLoss == null ? null : false;
    let hitTakeProfit: boolean | null = takeProfit == null ? null : false;
    let firstHit = 'neither';
    let firstHitDate: Date | null = null;
    let firstHitTradingDays: number | null = null;
    let simulatedExitPrice = endClose;
    let simulatedExitReason = 'window_end';

    for (let index = 0; index < windowBars.length; index += 1) {
      const bar = windowBars[index];
      const stopHit = stopLoss != null && bar.low != null && bar.low <= stopLoss;
      const takeHit = takeProfit != null && bar.high != null && bar.high >= takeProfit;

      if (stopHit) hitStopLoss = true;
      if (takeHit) hitTakeProfit = true;

      if (!stopHit && !takeHit) continue;

      firstHitDate = bar.date;
      firstHitTradingDays = index + 1;

      if (stopHit && takeHit) {
        firstHit = 'ambiguous';
        simulatedExitPrice = stopLoss;
        simulatedExitReason = 'ambiguous_stop_loss';
        break;
      }

      if (stopHit) {
        firstHit = 'stop_loss';
        simulatedExitPrice = stopLoss;
        simulatedExitReason = 'stop_loss';
        break;
      }

      firstHit = 'take_profit';
      simulatedExitPrice = takeProfit;
      simulatedExitReason = 'take_profit';
      break;
    }

    return {
      hitStopLoss,
      hitTakeProfit,
      firstHit,
      firstHitDate,
      firstHitTradingDays,
      simulatedExitPrice,
      simulatedExitReason,
    };
  }

  private static average(values: Array<number | null>): number | null {
    const usable = values.filter((x): x is number => x != null && Number.isFinite(x));
    if (usable.length === 0) return null;
    return round(usable.reduce((sum, x) => sum + x, 0) / usable.length, 4);
  }

  private static computeAdviceBreakdown(results: BacktestResultLike[]): Record<string, unknown> {
    const mapping: Record<string, { total: number; win: number; loss: number; neutral: number }> = {};

    for (const row of results) {
      const advice = String(row.operationAdvice ?? '').trim() || '(unknown)';
      if (!mapping[advice]) {
        mapping[advice] = { total: 0, win: 0, loss: 0, neutral: 0 };
      }

      mapping[advice].total += 1;
      if (row.outcome === 'win') mapping[advice].win += 1;
      if (row.outcome === 'loss') mapping[advice].loss += 1;
      if (row.outcome === 'neutral') mapping[advice].neutral += 1;
    }

    const output: Record<string, unknown> = {};
    for (const [advice, metrics] of Object.entries(mapping)) {
      const denominator = metrics.win + metrics.loss;
      output[advice] = {
        ...metrics,
        win_rate_pct: denominator ? round((metrics.win / denominator) * 100) : null,
      };
    }

    return output;
  }

  private static computeDiagnostics(results: BacktestResultLike[]): Record<string, unknown> {
    const evalStatus: Record<string, number> = {};
    const firstHit: Record<string, number> = {};

    for (const row of results) {
      const status = row.evalStatus || '(unknown)';
      evalStatus[status] = (evalStatus[status] ?? 0) + 1;

      const hit = row.firstHit || '(none)';
      firstHit[hit] = (firstHit[hit] ?? 0) + 1;
    }

    return {
      eval_status: evalStatus,
      first_hit: firstHit,
    };
  }
}
