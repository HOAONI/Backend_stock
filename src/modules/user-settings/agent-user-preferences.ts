/** Agent 用户偏好归一化工具，供用户设置与 Agent 问股上下文共用。 */

import { normalizeAgentChatPreferences } from './agent-chat-preferences';

export type AgentRiskProfile = 'conservative' | 'balanced' | 'aggressive';
export type AgentAnalysisStrategy = 'auto' | 'ma' | 'rsi' | 'custom';

export interface AgentUserTradingPreferencesPayload {
  riskProfile: AgentRiskProfile;
  analysisStrategy: AgentAnalysisStrategy;
  maxSingleTradeAmount: number | null;
  positionMaxPct: number;
  stopLossPct: number;
  takeProfitPct: number;
}

export interface EffectiveAgentUserPreferencesPayload {
  trading: AgentUserTradingPreferencesPayload;
  chat: ReturnType<typeof normalizeAgentChatPreferences>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim();
}

function asNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPct(value: unknown, fallback: number): number {
  const parsed = asNumber(value);
  if (parsed == null) {
    return fallback;
  }
  return Math.min(100, Math.max(0, parsed));
}

export function normalizeRiskProfile(value: unknown): AgentRiskProfile {
  const normalized = cleanText(value).toLowerCase();
  if (normalized === 'conservative' || normalized === 'aggressive') {
    return normalized;
  }
  return 'balanced';
}

export function normalizeAnalysisStrategy(value: unknown): AgentAnalysisStrategy {
  const normalized = cleanText(value).toLowerCase();
  if (normalized === 'ma' || normalized === 'rsi' || normalized === 'custom') {
    return normalized;
  }
  return 'auto';
}

export function normalizeMaxSingleTradeAmount(value: unknown): number | null {
  const parsed = asNumber(value);
  if (parsed == null || parsed <= 0) {
    return null;
  }
  return Number(parsed.toFixed(2));
}

export function normalizeAgentTradingPreferences(value: unknown): AgentUserTradingPreferencesPayload {
  const source = asRecord(value);
  return {
    riskProfile: normalizeRiskProfile(source.riskProfile ?? source.risk_profile),
    analysisStrategy: normalizeAnalysisStrategy(source.analysisStrategy ?? source.analysis_strategy),
    maxSingleTradeAmount: normalizeMaxSingleTradeAmount(
      source.maxSingleTradeAmount ?? source.max_single_trade_amount,
    ),
    positionMaxPct: clampPct(source.positionMaxPct ?? source.position_max_pct, 30),
    stopLossPct: clampPct(source.stopLossPct ?? source.stop_loss_pct, 8),
    takeProfitPct: clampPct(source.takeProfitPct ?? source.take_profit_pct, 15),
  };
}

export function normalizeEffectiveAgentUserPreferences(value: unknown): EffectiveAgentUserPreferencesPayload {
  const source = asRecord(value);
  return {
    trading: normalizeAgentTradingPreferences(source.trading ?? source),
    chat: normalizeAgentChatPreferences(source.chat ?? source),
  };
}
