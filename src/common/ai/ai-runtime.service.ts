import * as fs from 'node:fs';
import * as path from 'node:path';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as dotenv from 'dotenv';

import { AgentClientService, AgentRuntimeLlmDefaultPayload } from '@/common/agent/agent-client.service';
import { PersonalCryptoService } from '@/common/security/personal-crypto.service';
import { SystemConfigService } from '@/modules/system-config/system-config.service';

export type ResolvedAiProvider = 'gemini' | 'anthropic' | 'openai' | 'deepseek' | 'custom' | 'siliconflow';
export type PersonalAiProvider = 'deepseek' | 'openai' | 'siliconflow';

export interface ResolvedAiEndpoint {
  provider: ResolvedAiProvider | '';
  model: string;
  baseUrl: string;
}

export interface ResolvedSystemAiEndpoint extends ResolvedAiEndpoint {
  hasToken: boolean;
  source: 'agent_runtime' | 'agent_env_fallback' | 'system_config' | 'none';
}

export interface ResolvedAiRuntimeConfig {
  source: 'system' | 'personal';
  hasPersonalToken: boolean;
  hasSystemToken: boolean;
  personalProvider: PersonalAiProvider | '';
  systemDefault: ResolvedSystemAiEndpoint;
  effective: ResolvedAiEndpoint;
  apiToken: string | null;
  requiresProviderReselection: boolean;
  forwardRuntimeLlm: boolean;
}

type UserProfile = Prisma.AdminUserProfileGetPayload<Record<string, never>> | null;

type SystemResolvedState = {
  hasSystemToken: boolean;
  systemDefault: ResolvedSystemAiEndpoint;
  effective: ResolvedAiEndpoint;
  apiToken: string | null;
  forwardRuntimeLlm: boolean;
};

const SYSTEM_AI_KEYS = [
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
] as const;

const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-20241022';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_SILICONFLOW_MODEL = 'Pro/deepseek-ai/DeepSeek-V3';
export const DEFAULT_SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';

const PERSONAL_PROVIDER_PRESETS: Record<PersonalAiProvider, ResolvedAiEndpoint> = {
  deepseek: {
    provider: 'deepseek',
    model: DEFAULT_DEEPSEEK_MODEL,
    baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
  },
  openai: {
    provider: 'openai',
    model: DEFAULT_OPENAI_MODEL,
    baseUrl: DEFAULT_OPENAI_BASE_URL,
  },
  siliconflow: {
    provider: 'siliconflow',
    model: DEFAULT_SILICONFLOW_MODEL,
    baseUrl: DEFAULT_SILICONFLOW_BASE_URL,
  },
};

function cleanText(value: unknown): string {
  return String(value ?? '').trim();
}

function isValidSecret(value: unknown): boolean {
  const text = cleanText(value);
  return text.length > 10 && !text.startsWith('your_');
}

function inferOpenAiCompatibleProvider(baseUrl: string): Extract<ResolvedAiProvider, 'openai' | 'deepseek' | 'custom'> {
  const normalized = cleanText(baseUrl).toLowerCase();
  if (normalized.includes('deepseek')) {
    return 'deepseek';
  }
  if (normalized && !normalized.includes('openai.com')) {
    return 'custom';
  }
  return 'openai';
}

function isSupportedPersonalProvider(value: unknown): value is PersonalAiProvider {
  return value === 'deepseek' || value === 'openai' || value === 'siliconflow';
}

function createEmptySystemState(): SystemResolvedState {
  return {
    hasSystemToken: false,
    systemDefault: {
      provider: '',
      model: '',
      baseUrl: '',
      hasToken: false,
      source: 'none',
    },
    effective: {
      provider: '',
      model: '',
      baseUrl: '',
    },
    apiToken: null,
    forwardRuntimeLlm: false,
  };
}

@Injectable()
export class AiRuntimeService {
  constructor(
    private readonly systemConfigService: SystemConfigService,
    private readonly personalCrypto: PersonalCryptoService,
    private readonly agentClientService: AgentClientService,
  ) {}

  private normalizeAgentDefaultPayload(payload: AgentRuntimeLlmDefaultPayload): SystemResolvedState {
    const available = Boolean(payload?.available);
    const providerRaw = cleanText(payload?.provider).toLowerCase();
    const model = cleanText(payload?.model);
    const baseUrl = cleanText(payload?.base_url);

    if (!available || !providerRaw || !model || !baseUrl) {
      return createEmptySystemState();
    }

    const provider = ['gemini', 'anthropic', 'openai', 'deepseek', 'custom', 'siliconflow'].includes(providerRaw)
      ? providerRaw as ResolvedAiProvider
      : inferOpenAiCompatibleProvider(baseUrl);

    return {
      hasSystemToken: Boolean(payload?.has_token),
      systemDefault: {
        provider,
        model,
        baseUrl,
        hasToken: Boolean(payload?.has_token),
        source: 'agent_runtime',
      },
      effective: {
        provider,
        model,
        baseUrl,
      },
      apiToken: null,
      forwardRuntimeLlm: false,
    };
  }

  private async resolveSystemDefaultFromAgent(): Promise<SystemResolvedState> {
    try {
      const payload = await this.agentClientService.getRuntimeLlmDefault();
      return this.normalizeAgentDefaultPayload(payload);
    } catch {
      return createEmptySystemState();
    }
  }

  private resolveAgentEnvFilePath(): string {
    const explicit = cleanText(process.env.AGENT_ENV_FILE);
    if (explicit) {
      return path.resolve(explicit);
    }
    return path.resolve(process.cwd(), '../Agent_stock/.env');
  }

  private resolveSystemDefaultFromAgentEnv(): SystemResolvedState {
    const envFile = this.resolveAgentEnvFilePath();
    if (!fs.existsSync(envFile)) {
      return createEmptySystemState();
    }

    const values = dotenv.parse(fs.readFileSync(envFile));

    const geminiToken = cleanText(values.GEMINI_API_KEY);
    if (isValidSecret(geminiToken)) {
      return {
        hasSystemToken: true,
        systemDefault: {
          provider: 'gemini',
          model: cleanText(values.GEMINI_MODEL) || DEFAULT_GEMINI_MODEL,
          baseUrl: DEFAULT_GEMINI_BASE_URL,
          hasToken: true,
          source: 'agent_env_fallback',
        },
        effective: {
          provider: 'gemini',
          model: cleanText(values.GEMINI_MODEL) || DEFAULT_GEMINI_MODEL,
          baseUrl: DEFAULT_GEMINI_BASE_URL,
        },
        apiToken: null,
        forwardRuntimeLlm: false,
      };
    }

    const anthropicToken = cleanText(values.ANTHROPIC_API_KEY);
    if (isValidSecret(anthropicToken)) {
      return {
        hasSystemToken: true,
        systemDefault: {
          provider: 'anthropic',
          model: cleanText(values.ANTHROPIC_MODEL) || DEFAULT_ANTHROPIC_MODEL,
          baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
          hasToken: true,
          source: 'agent_env_fallback',
        },
        effective: {
          provider: 'anthropic',
          model: cleanText(values.ANTHROPIC_MODEL) || DEFAULT_ANTHROPIC_MODEL,
          baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
        },
        apiToken: null,
        forwardRuntimeLlm: false,
      };
    }

    const openAiToken = cleanText(values.OPENAI_API_KEY);
    const openAiBaseUrl = cleanText(values.OPENAI_BASE_URL) || DEFAULT_OPENAI_BASE_URL;
    const openAiProvider = inferOpenAiCompatibleProvider(openAiBaseUrl);
    if (isValidSecret(openAiToken)) {
      return {
        hasSystemToken: true,
        systemDefault: {
          provider: openAiProvider,
          model: cleanText(values.OPENAI_MODEL) || DEFAULT_OPENAI_MODEL,
          baseUrl: openAiBaseUrl,
          hasToken: true,
          source: 'agent_env_fallback',
        },
        effective: {
          provider: openAiProvider,
          model: cleanText(values.OPENAI_MODEL) || DEFAULT_OPENAI_MODEL,
          baseUrl: openAiBaseUrl,
        },
        apiToken: null,
        forwardRuntimeLlm: false,
      };
    }

    return createEmptySystemState();
  }

  private async resolveSystemDefaultFromSystemConfig(): Promise<SystemResolvedState> {
    const values = await this.systemConfigService.getValueMap([...SYSTEM_AI_KEYS]);

    const geminiToken = cleanText(values.GEMINI_API_KEY);
    if (isValidSecret(geminiToken)) {
      return {
        hasSystemToken: true,
        systemDefault: {
          provider: 'gemini',
          model: cleanText(values.GEMINI_MODEL) || DEFAULT_GEMINI_MODEL,
          baseUrl: DEFAULT_GEMINI_BASE_URL,
          hasToken: true,
          source: 'system_config',
        },
        effective: {
          provider: 'gemini',
          model: cleanText(values.GEMINI_MODEL) || DEFAULT_GEMINI_MODEL,
          baseUrl: DEFAULT_GEMINI_BASE_URL,
        },
        apiToken: geminiToken,
        forwardRuntimeLlm: true,
      };
    }

    const anthropicToken = cleanText(values.ANTHROPIC_API_KEY);
    if (isValidSecret(anthropicToken)) {
      return {
        hasSystemToken: true,
        systemDefault: {
          provider: 'anthropic',
          model: cleanText(values.ANTHROPIC_MODEL) || DEFAULT_ANTHROPIC_MODEL,
          baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
          hasToken: true,
          source: 'system_config',
        },
        effective: {
          provider: 'anthropic',
          model: cleanText(values.ANTHROPIC_MODEL) || DEFAULT_ANTHROPIC_MODEL,
          baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
        },
        apiToken: anthropicToken,
        forwardRuntimeLlm: true,
      };
    }

    const openAiToken = cleanText(values.OPENAI_API_KEY);
    const openAiBaseUrl = cleanText(values.OPENAI_BASE_URL) || DEFAULT_OPENAI_BASE_URL;
    const openAiProvider = inferOpenAiCompatibleProvider(openAiBaseUrl);
    if (isValidSecret(openAiToken)) {
      return {
        hasSystemToken: true,
        systemDefault: {
          provider: openAiProvider,
          model: cleanText(values.OPENAI_MODEL) || DEFAULT_OPENAI_MODEL,
          baseUrl: openAiBaseUrl,
          hasToken: true,
          source: 'system_config',
        },
        effective: {
          provider: openAiProvider,
          model: cleanText(values.OPENAI_MODEL) || DEFAULT_OPENAI_MODEL,
          baseUrl: openAiBaseUrl,
        },
        apiToken: openAiToken,
        forwardRuntimeLlm: true,
      };
    }

    return createEmptySystemState();
  }

  private async resolveSystemDefault(): Promise<SystemResolvedState> {
    const agentDefault = await this.resolveSystemDefaultFromAgent();
    if (agentDefault.hasSystemToken) {
      return agentDefault;
    }

    const agentEnvDefault = this.resolveSystemDefaultFromAgentEnv();
    if (agentEnvDefault.hasSystemToken) {
      return agentEnvDefault;
    }

    const configDefault = await this.resolveSystemDefaultFromSystemConfig();
    if (configDefault.hasSystemToken) {
      return configDefault;
    }

    return agentEnvDefault.hasSystemToken ? agentEnvDefault : agentDefault;
  }

  private decryptPersonalToken(profile: UserProfile): string | null {
    if (!profile?.aiTokenCiphertext) {
      return null;
    }
    if (!profile.aiTokenIv || !profile.aiTokenTag) {
      throw new Error('个人 AI Token 缺少加密元数据，无法解析');
    }

    return this.personalCrypto.decrypt({
      ciphertext: profile.aiTokenCiphertext,
      iv: profile.aiTokenIv,
      tag: profile.aiTokenTag,
    });
  }

  private resolvePersonalEndpoint(profile: UserProfile, provider: PersonalAiProvider): ResolvedAiEndpoint {
    if (provider === 'siliconflow') {
      return {
        provider: 'siliconflow',
        baseUrl: DEFAULT_SILICONFLOW_BASE_URL,
        model: cleanText(profile?.aiModel) || DEFAULT_SILICONFLOW_MODEL,
      };
    }

    return PERSONAL_PROVIDER_PRESETS[provider];
  }

  private resolvePersonalProviderState(profile: UserProfile): {
    personalProvider: PersonalAiProvider | '';
    requiresProviderReselection: boolean;
  } {
    const rawProvider = cleanText(profile?.aiProvider).toLowerCase();
    if (!rawProvider) {
      return { personalProvider: '', requiresProviderReselection: false };
    }

    if (isSupportedPersonalProvider(rawProvider)) {
      const looksLikeUntouchedOpenAiDefault = !profile?.aiTokenCiphertext
        && rawProvider === 'openai'
        && cleanText(profile?.aiBaseUrl) === DEFAULT_OPENAI_BASE_URL
        && cleanText(profile?.aiModel) === DEFAULT_OPENAI_MODEL;
      if (looksLikeUntouchedOpenAiDefault) {
        return { personalProvider: '', requiresProviderReselection: false };
      }

      return {
        personalProvider: rawProvider,
        requiresProviderReselection: false,
      };
    }

    return {
      personalProvider: '',
      requiresProviderReselection: true,
    };
  }

  async resolveEffectiveLlmFromProfile(
    profile: UserProfile,
    options?: {
      requireSystemDefault?: boolean;
      includeApiToken?: boolean;
    },
  ): Promise<ResolvedAiRuntimeConfig> {
    const systemDefault = await this.resolveSystemDefault();
    const hasPersonalToken = Boolean(profile?.aiTokenCiphertext);
    const { personalProvider, requiresProviderReselection } = this.resolvePersonalProviderState(profile);
    const canUsePersonal = hasPersonalToken && Boolean(personalProvider) && !requiresProviderReselection;

    if (canUsePersonal) {
      const selectedPersonalProvider = personalProvider as PersonalAiProvider;
      return {
        source: 'personal',
        hasPersonalToken: true,
        hasSystemToken: systemDefault.hasSystemToken,
        personalProvider: selectedPersonalProvider,
        systemDefault: systemDefault.systemDefault,
        effective: this.resolvePersonalEndpoint(profile, selectedPersonalProvider),
        apiToken: options?.includeApiToken ? this.decryptPersonalToken(profile) : null,
        requiresProviderReselection: false,
        forwardRuntimeLlm: true,
      };
    }

    if (options?.requireSystemDefault && !systemDefault.hasSystemToken) {
      throw new Error('系统内置 AI 未配置，请先检查 Agent 默认 LLM 或 Backend 配置管理中的 AI Key');
    }

    return {
      source: 'system',
      hasPersonalToken,
      hasSystemToken: systemDefault.hasSystemToken,
      personalProvider,
      systemDefault: systemDefault.systemDefault,
      effective: systemDefault.effective,
      apiToken: options?.includeApiToken && systemDefault.forwardRuntimeLlm ? systemDefault.apiToken : null,
      requiresProviderReselection,
      forwardRuntimeLlm: systemDefault.forwardRuntimeLlm,
    };
  }
}
