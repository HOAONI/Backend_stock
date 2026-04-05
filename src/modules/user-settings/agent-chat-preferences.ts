/** Agent 对话偏好归一化工具，供用户设置和问股载荷共用。 */

export type AgentChatExecutionPolicy = 'auto_execute_if_condition_met' | 'confirm_before_execute';
export type AgentChatResponseStyle = 'concise_factual' | 'balanced' | 'detailed';

export interface AgentChatPreferencesPayload {
  executionPolicy: AgentChatExecutionPolicy;
  confirmationShortcutsEnabled: boolean;
  followupFocusResolutionEnabled: boolean;
  responseStyle: AgentChatResponseStyle;
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

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return fallback;
}

export const DEFAULT_AGENT_CHAT_PREFERENCES: AgentChatPreferencesPayload = Object.freeze({
  executionPolicy: 'auto_execute_if_condition_met',
  confirmationShortcutsEnabled: true,
  followupFocusResolutionEnabled: true,
  responseStyle: 'concise_factual',
});

export function normalizeAgentChatPreferences(value: unknown): AgentChatPreferencesPayload {
  const source = asRecord(value);
  const executionPolicy = cleanText(source.executionPolicy);
  const responseStyle = cleanText(source.responseStyle);

  return {
    executionPolicy: executionPolicy === 'confirm_before_execute'
      ? 'confirm_before_execute'
      : DEFAULT_AGENT_CHAT_PREFERENCES.executionPolicy,
    confirmationShortcutsEnabled: normalizeBoolean(
      source.confirmationShortcutsEnabled,
      DEFAULT_AGENT_CHAT_PREFERENCES.confirmationShortcutsEnabled,
    ),
    followupFocusResolutionEnabled: normalizeBoolean(
      source.followupFocusResolutionEnabled,
      DEFAULT_AGENT_CHAT_PREFERENCES.followupFocusResolutionEnabled,
    ),
    responseStyle: responseStyle === 'balanced' || responseStyle === 'detailed'
      ? responseStyle
      : DEFAULT_AGENT_CHAT_PREFERENCES.responseStyle,
  };
}
