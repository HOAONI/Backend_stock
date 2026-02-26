import { Prisma } from '@prisma/client';

import { AgentRuntimeConfig } from './agent.types';

function cleanText(value: unknown, fallback = ''): string {
  const text = String(value ?? '').trim();
  return text || fallback;
}

export function buildRuntimeConfigFromProfile(
  profile: Prisma.AdminUserProfileGetPayload<Record<string, never>> | null,
  username: string,
  options?: {
    apiToken?: string | null;
  },
): AgentRuntimeConfig {
  const simulationAccountId = cleanText(profile?.simulationAccountId);
  const simulationAccountName = cleanText(profile?.simulationAccountName);
  const accountName = simulationAccountId || simulationAccountName || `user-${cleanText(username, 'unknown')}`;
  const apiToken = cleanText(options?.apiToken);
  const hasToken = Boolean(profile?.aiTokenCiphertext || apiToken);

  return {
    account: {
      account_name: accountName,
      initial_cash: Number(profile?.simulationInitialCapital ?? 100000),
      account_display_name: simulationAccountName || null,
    },
    llm: {
      provider: cleanText(profile?.aiProvider, 'openai'),
      base_url: cleanText(profile?.aiBaseUrl, 'https://api.openai.com/v1'),
      model: cleanText(profile?.aiModel, 'gpt-4o-mini'),
      has_token: hasToken,
      ...(apiToken ? { api_token: apiToken } : {}),
    },
    strategy: {
      position_max_pct: Number(profile?.strategyPositionMaxPct ?? 30),
      stop_loss_pct: Number(profile?.strategyStopLossPct ?? 8),
      take_profit_pct: Number(profile?.strategyTakeProfitPct ?? 15),
    },
    execution: {
      mode: 'paper',
      has_ticket: false,
    },
  };
}

export function maskRuntimeConfig(runtimeConfig: AgentRuntimeConfig): AgentRuntimeConfig {
  return {
    account: {
      ...runtimeConfig.account,
    },
    llm: {
      provider: runtimeConfig.llm.provider,
      base_url: runtimeConfig.llm.base_url,
      model: runtimeConfig.llm.model,
      has_token: Boolean(runtimeConfig.llm.has_token || runtimeConfig.llm.api_token),
    },
    strategy: {
      ...runtimeConfig.strategy,
    },
    execution: runtimeConfig.execution
      ? {
          mode: runtimeConfig.execution.mode,
          has_ticket: Boolean(runtimeConfig.execution.has_ticket || runtimeConfig.execution.credential_ticket),
          ...(runtimeConfig.execution.ticket_id != null ? { ticket_id: runtimeConfig.execution.ticket_id } : {}),
          ...(runtimeConfig.execution.broker_account_id != null
            ? { broker_account_id: runtimeConfig.execution.broker_account_id }
            : {}),
        }
      : undefined,
  };
}
