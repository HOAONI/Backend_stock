export const BACKTEST_COMPARE_STRATEGY_CODES = ['agent_v1', 'ma20_trend', 'rsi14_mean_reversion'] as const;

export type BacktestCompareStrategyCode = (typeof BACKTEST_COMPARE_STRATEGY_CODES)[number];

export const BACKTEST_COMPARE_STRATEGY_NAMES: Record<BacktestCompareStrategyCode, string> = {
  agent_v1: 'Agent v1',
  ma20_trend: 'MA20 Trend',
  rsi14_mean_reversion: 'RSI14 Mean Reversion',
};

export const DEFAULT_BACKTEST_COMPARE_STRATEGY_CODES: BacktestCompareStrategyCode[] = [...BACKTEST_COMPARE_STRATEGY_CODES];
