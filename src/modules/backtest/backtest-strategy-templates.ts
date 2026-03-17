/** 回测模块中的实现文件，承载该领域的具体逻辑。 */

export const BACKTEST_STRATEGY_TEMPLATE_CODES = ['ma_cross', 'rsi_threshold'] as const;

export type BacktestStrategyTemplateCode = (typeof BACKTEST_STRATEGY_TEMPLATE_CODES)[number];

export interface BacktestStrategyTemplateParamDefinition {
  key: string;
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}

export interface BacktestStrategyTemplateDefinition {
  templateCode: BacktestStrategyTemplateCode;
  templateName: string;
  description: string;
  params: BacktestStrategyTemplateParamDefinition[];
}

const TEMPLATE_DEFINITIONS: Record<BacktestStrategyTemplateCode, BacktestStrategyTemplateDefinition> = {
  ma_cross: {
    templateCode: 'ma_cross',
    templateName: 'MA 交叉',
    description: '价格上穿均线时买入，下穿均线时卖出。',
    params: [
      {
        key: 'maWindow',
        label: 'MA 周期',
        description: '移动平均周期。',
        min: 5,
        max: 120,
        step: 1,
        defaultValue: 20,
      },
    ],
  },
  rsi_threshold: {
    templateCode: 'rsi_threshold',
    templateName: 'RSI 阈值',
    description: 'RSI 超卖时买入，RSI 超买时卖出。',
    params: [
      {
        key: 'rsiPeriod',
        label: 'RSI 周期',
        description: 'RSI 回看周期。',
        min: 5,
        max: 60,
        step: 1,
        defaultValue: 14,
      },
      {
        key: 'oversoldThreshold',
        label: '超卖阈值',
        description: 'RSI 买入阈值。',
        min: 1,
        max: 49,
        step: 1,
        defaultValue: 30,
      },
      {
        key: 'overboughtThreshold',
        label: '超买阈值',
        description: 'RSI 卖出阈值。',
        min: 51,
        max: 99,
        step: 1,
        defaultValue: 70,
      },
    ],
  },
};

export function isBacktestStrategyTemplateCode(value: string): value is BacktestStrategyTemplateCode {
  return (BACKTEST_STRATEGY_TEMPLATE_CODES as readonly string[]).includes(value);
}

export function getBacktestStrategyTemplateDefinition(
  templateCode: BacktestStrategyTemplateCode,
): BacktestStrategyTemplateDefinition {
  return TEMPLATE_DEFINITIONS[templateCode];
}

export function listBacktestStrategyTemplateDefinitions(): BacktestStrategyTemplateDefinition[] {
  return BACKTEST_STRATEGY_TEMPLATE_CODES.map((templateCode) => TEMPLATE_DEFINITIONS[templateCode]);
}

export function getBacktestStrategyTemplateName(templateCode: string): string {
  if (isBacktestStrategyTemplateCode(templateCode)) {
    return TEMPLATE_DEFINITIONS[templateCode].templateName;
  }
  return templateCode;
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string' && value.trim().length === 0) {
    return null;
  }
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return null;
  }
  return numberValue;
}

export function normalizeBacktestStrategyParams(
  templateCode: BacktestStrategyTemplateCode,
  rawParams: unknown,
): { params: Record<string, number>; issues: string[] } {
  const definition = TEMPLATE_DEFINITIONS[templateCode];
  const source = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
    ? rawParams as Record<string, unknown>
    : {};

  const params: Record<string, number> = {};
  const issues: string[] = [];

  for (const field of definition.params) {
    const numberValue = toFiniteNumber(source[field.key]);
    const resolved = numberValue ?? field.defaultValue;
    if (resolved < field.min || resolved > field.max) {
      issues.push(`${field.label} 必须在 ${field.min} - ${field.max} 之间`);
      continue;
    }
    const normalized = field.step >= 1 ? Math.trunc(resolved) : Number(resolved.toFixed(6));
    params[field.key] = normalized;
  }

  if (templateCode === 'rsi_threshold') {
    const oversold = params.oversoldThreshold;
    const overbought = params.overboughtThreshold;
    if (oversold >= overbought) {
      issues.push('超卖阈值必须小于超买阈值');
    }
  }

  return { params, issues };
}
