export const BACKTEST_STRATEGY_CODES = ['ma20_trend', 'rsi14_mean_reversion'] as const;

export type BacktestStrategyCode = (typeof BACKTEST_STRATEGY_CODES)[number];

export const BACKTEST_STRATEGY_NAMES: Record<BacktestStrategyCode, string> = {
  ma20_trend: 'MA20 Trend',
  rsi14_mean_reversion: 'RSI14 Mean Reversion',
};

export const DEFAULT_BACKTEST_STRATEGY_CODES: BacktestStrategyCode[] = [...BACKTEST_STRATEGY_CODES];
