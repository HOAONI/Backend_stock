export const BACKTEST_STRATEGY_CODES = ['ma20_trend', 'rsi14_mean_reversion'] as const;

export type LegacyBacktestStrategyCode = (typeof BACKTEST_STRATEGY_CODES)[number];
export type BacktestStrategyCode = LegacyBacktestStrategyCode;

export const BACKTEST_STRATEGY_NAMES: Record<BacktestStrategyCode, string> = {
  ma20_trend: 'MA20 Trend',
  rsi14_mean_reversion: 'RSI14 Mean Reversion',
};

export const DEFAULT_BACKTEST_STRATEGY_CODES: BacktestStrategyCode[] = [...BACKTEST_STRATEGY_CODES];

const LEGACY_BACKTEST_STRATEGY_TEMPLATE_MAP = {
  ma20_trend: {
    templateCode: 'ma_cross',
    params: {
      maWindow: 20,
    },
  },
  rsi14_mean_reversion: {
    templateCode: 'rsi_threshold',
    params: {
      rsiPeriod: 14,
      oversoldThreshold: 30,
      overboughtThreshold: 70,
    },
  },
} as const satisfies Record<LegacyBacktestStrategyCode, {
  templateCode: 'ma_cross' | 'rsi_threshold';
  params: Record<string, number>;
}>;

export function resolveLegacyBacktestStrategy(strategyCode: LegacyBacktestStrategyCode): {
  templateCode: 'ma_cross' | 'rsi_threshold';
  params: Record<string, number>;
} {
  const resolved = LEGACY_BACKTEST_STRATEGY_TEMPLATE_MAP[strategyCode];
  return {
    templateCode: resolved.templateCode,
    params: { ...resolved.params },
  };
}
