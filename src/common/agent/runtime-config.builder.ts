import { Prisma } from '@prisma/client';

import { AgentRuntimeConfig } from './agent.types';

function cleanText(value: unknown, fallback = ''): string {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function mapRuntimeProvider(provider: unknown): string {
  const normalized = cleanText(provider).toLowerCase();
  if (normalized === 'siliconflow') {
    return 'custom';
  }
  return cleanText(provider);
}

export function buildRuntimeConfigFromProfile(
  profile: Prisma.AdminUserProfileGetPayload<Record<string, never>> | null,
  username: string,
  options?: {
    llm?: {
      provider?: string | null;
      baseUrl?: string | null;
      model?: string | null;
      hasToken?: boolean;
      apiToken?: string | null;
    } | null;
  },
): AgentRuntimeConfig {
  const simulationAccountId = cleanText(profile?.simulationAccountId);
  const simulationAccountName = cleanText(profile?.simulationAccountName);
  const accountName = simulationAccountId || simulationAccountName || `user-${cleanText(username, 'unknown')}`;
  const llm = options?.llm;
  const apiToken = cleanText(llm?.apiToken);
  const hasToken = Boolean(llm?.hasToken || apiToken);
  const hasLlm = Boolean(
    cleanText(llm?.provider)
    && cleanText(llm?.baseUrl)
    && cleanText(llm?.model),
  );

  return {
    account: {
      account_name: accountName,
      initial_cash: Number(profile?.simulationInitialCapital ?? 100000),
      account_display_name: simulationAccountName || null,
    },
    ...(hasLlm
      ? {
          llm: {
            provider: mapRuntimeProvider(llm?.provider),
            base_url: cleanText(llm?.baseUrl),
            model: cleanText(llm?.model),
            has_token: hasToken,
            ...(apiToken ? { api_token: apiToken } : {}),
          },
        }
      : {}),
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
    ...(runtimeConfig.llm
      ? {
          llm: {
            provider: runtimeConfig.llm.provider,
            base_url: runtimeConfig.llm.base_url,
            model: runtimeConfig.llm.model,
            has_token: Boolean(runtimeConfig.llm.has_token || runtimeConfig.llm.api_token),
          },
        }
      : {}),
    strategy: {
      ...runtimeConfig.strategy,
    },
    execution: runtimeConfig.execution
      ? {
          mode: runtimeConfig.execution.mode,
          has_ticket: Boolean(runtimeConfig.execution.has_ticket),
          ...(runtimeConfig.execution.broker_account_id != null
            ? { broker_account_id: runtimeConfig.execution.broker_account_id }
            : {}),
        }
      : undefined,
  };
}
