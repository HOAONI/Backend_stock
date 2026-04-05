/** 用户个人设置模块的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable } from '@nestjs/common';

import { AiRuntimeService, DEFAULT_SILICONFLOW_BASE_URL, DEFAULT_SILICONFLOW_MODEL } from '@/common/ai/ai-runtime.service';
import { PrismaService } from '@/common/database/prisma.service';
import { PersonalCryptoService, PersonalSecretStatus } from '@/common/security/personal-crypto.service';

import { normalizeAgentChatPreferences } from './agent-chat-preferences';
import {
  normalizeAnalysisStrategy,
  normalizeMaxSingleTradeAmount,
  normalizeRiskProfile,
} from './agent-user-preferences';
import { UpdateUserSettingsDto } from './user-settings.dto';

interface ServiceError extends Error {
  code?: string;
}

function createServiceError(code: string, message: string): ServiceError {
  const error = new Error(message) as ServiceError;
  error.code = code;
  return error;
}

const MASKED_TOKEN = '******';
const DEFAULT_PERSONAL_PROVIDER = 'deepseek';
const PERSONAL_TOKEN_READ_FAILURE_MESSAGE = '当前保存的个人 API Key 无法回显，请重新输入并保存；如问题持续，请检查 Backend_stock/.env 中的 PERSONAL_SECRET_KEY 配置。';

function cleanText(value: unknown): string {
  return String(value ?? '').trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
}

type StoredPersonalTokenState = {
  apiToken: string;
  apiTokenReadable: boolean;
  apiTokenReadIssue: string;
};

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class UserSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly personalCrypto: PersonalCryptoService,
    private readonly aiRuntimeService: AiRuntimeService,
  ) {}

  private getPersonalBindingStatus(): PersonalSecretStatus {
    return this.personalCrypto.getStatus();
  }

  private async ensureProfile(userId: number) {
    return this.prisma.adminUserProfile.upsert({
      where: { userId },
      update: {},
      create: { userId, aiProvider: DEFAULT_PERSONAL_PROVIDER, aiBaseUrl: '', aiModel: '' },
    });
  }

  private resolveStoredPersonalModel(profile: Awaited<ReturnType<typeof this.ensureProfile>>): string {
    if (cleanText(profile.aiProvider).toLowerCase() !== 'siliconflow') {
      return '';
    }
    return cleanText(profile.aiModel) || DEFAULT_SILICONFLOW_MODEL;
  }

  private readStoredPersonalToken(profile: Awaited<ReturnType<typeof this.ensureProfile>>): StoredPersonalTokenState {
    if (!profile.aiTokenCiphertext) {
      return {
        apiToken: '',
        apiTokenReadable: true,
        apiTokenReadIssue: '',
      };
    }

    if (!profile.aiTokenIv || !profile.aiTokenTag) {
      return {
        apiToken: '',
        apiTokenReadable: false,
        apiTokenReadIssue: PERSONAL_TOKEN_READ_FAILURE_MESSAGE,
      };
    }

    try {
      return {
        apiToken: this.personalCrypto.decrypt({
          ciphertext: profile.aiTokenCiphertext,
          iv: profile.aiTokenIv,
          tag: profile.aiTokenTag,
        }),
        apiTokenReadable: true,
        apiTokenReadIssue: '',
      };
    } catch {
      return {
        apiToken: '',
        apiTokenReadable: false,
        apiTokenReadIssue: PERSONAL_TOKEN_READ_FAILURE_MESSAGE,
      };
    }
  }

  private async toPayload(profile: Awaited<ReturnType<typeof this.ensureProfile>>): Promise<Record<string, unknown>> {
    const profileRecord = profile as Record<string, unknown>;
    const resolvedLlm = await this.aiRuntimeService.resolveEffectiveLlmFromProfile(profile, {
      includeApiToken: false,
      requireSystemDefault: false,
    });
    const personalBindingStatus = this.getPersonalBindingStatus();
    const storedPersonalToken = this.readStoredPersonalToken(profile);

    return {
      simulation: {
        accountName: profile.simulationAccountName,
        accountId: profile.simulationAccountId,
        initialCapital: profile.simulationInitialCapital,
        note: profile.simulationNote ?? '',
      },
      ai: {
        personalProvider: resolvedLlm.personalProvider,
        personalModel: this.resolveStoredPersonalModel(profile),
        provider: resolvedLlm.effective.provider || '',
        baseUrl: resolvedLlm.effective.baseUrl,
        model: resolvedLlm.effective.model,
        hasToken: Boolean(profile.aiTokenCiphertext),
        apiToken: storedPersonalToken.apiToken,
        apiTokenReadable: storedPersonalToken.apiTokenReadable,
        apiTokenReadIssue: storedPersonalToken.apiTokenReadIssue,
        apiTokenMasked: profile.aiTokenCiphertext ? MASKED_TOKEN : '',
        source: resolvedLlm.source,
        hasSystemToken: resolvedLlm.hasSystemToken,
        requiresProviderReselection: resolvedLlm.requiresProviderReselection,
        personalBindingAvailable: personalBindingStatus.available,
        personalBindingIssue: personalBindingStatus.issue,
        systemDefault: {
          provider: resolvedLlm.systemDefault.provider,
          baseUrl: resolvedLlm.systemDefault.baseUrl,
          model: resolvedLlm.systemDefault.model,
          hasToken: resolvedLlm.systemDefault.hasToken,
          source: resolvedLlm.systemDefault.source,
        },
        effective: {
          provider: resolvedLlm.effective.provider,
          baseUrl: resolvedLlm.effective.baseUrl,
          model: resolvedLlm.effective.model,
        },
      },
      strategy: {
        riskProfile: normalizeRiskProfile(profileRecord.strategyRiskProfile),
        analysisStrategy: normalizeAnalysisStrategy(profileRecord.strategyAnalysisStrategy),
        maxSingleTradeAmount: normalizeMaxSingleTradeAmount(profileRecord.strategyMaxSingleTradeAmount),
        positionMaxPct: profile.strategyPositionMaxPct,
        stopLossPct: profile.strategyStopLossPct,
        takeProfitPct: profile.strategyTakeProfitPct,
      },
      agentChat: normalizeAgentChatPreferences(profileRecord.agentChatPreferencesJson),
      updatedAt: profile.updatedAt.toISOString(),
    };
  }

  async getMySettings(userId: number): Promise<Record<string, unknown>> {
    const profile = await this.ensureProfile(userId);
    return await this.toPayload(profile);
  }

  async updateMySettings(userId: number, input: UpdateUserSettingsDto): Promise<Record<string, unknown>> {
    const existing = await this.ensureProfile(userId);
    const simulation = input.simulation;
    const ai = input.ai;
    const strategy = input.strategy;
    const agentChat = input.agentChat;

    let aiTokenCiphertext: string | null | undefined;
    let aiTokenIv: string | null | undefined;
    let aiTokenTag: string | null | undefined;
    const providerChanged = ai?.provider != null && ai.provider !== existing.aiProvider;
    const apiTokenProvided = Boolean(ai && Object.prototype.hasOwnProperty.call(ai, 'apiToken'));
    const siliconFlowModel = ai?.provider === 'siliconflow'
      ? truncateText(cleanText(ai.model) || DEFAULT_SILICONFLOW_MODEL, 128)
      : '';

    if (providerChanged && existing.aiTokenCiphertext && (!apiTokenProvided || ai?.apiToken === MASKED_TOKEN)) {
      throw createServiceError('VALIDATION_ERROR', '切换提供商时请重新输入对应 API Key');
    }

    if (ai && apiTokenProvided) {
      const apiToken = String(ai.apiToken ?? '');
      if (apiToken === '' || apiToken.trim() === '') {
        aiTokenCiphertext = null;
        aiTokenIv = null;
        aiTokenTag = null;
      } else if (apiToken !== MASKED_TOKEN) {
        const personalBindingStatus = this.getPersonalBindingStatus();
        if (!personalBindingStatus.available) {
          throw createServiceError('VALIDATION_ERROR', personalBindingStatus.issue);
        }

        try {
          const encrypted = this.personalCrypto.encrypt(apiToken.trim());
          aiTokenCiphertext = encrypted.ciphertext;
          aiTokenIv = encrypted.iv;
          aiTokenTag = encrypted.tag;
        } catch (error: unknown) {
          const latestStatus = this.getPersonalBindingStatus();
          const message = latestStatus.available
            ? ((error as Error).message || '个人 Token 加密失败')
            : latestStatus.issue;
          throw createServiceError('VALIDATION_ERROR', message);
        }
      }
    }

    const existingRecord = existing as Record<string, unknown>;
    const nextAgentChatPreferences = agentChat
      ? normalizeAgentChatPreferences({
          ...normalizeAgentChatPreferences(existingRecord.agentChatPreferencesJson),
          ...agentChat,
        })
      : undefined;

    const updated = await this.prisma.adminUserProfile.update({
      where: { userId: existing.userId },
      data: {
        simulationAccountName: simulation?.accountName != null ? truncateText(simulation.accountName.trim(), 128) : undefined,
        simulationAccountId: simulation?.accountId != null ? truncateText(simulation.accountId.trim(), 128) : undefined,
        simulationInitialCapital: simulation?.initialCapital ?? undefined,
        simulationNote: simulation?.note != null ? truncateText(simulation.note.trim(), 255) : undefined,
        aiProvider: ai?.provider ?? undefined,
        aiBaseUrl: ai?.provider === 'siliconflow'
          ? DEFAULT_SILICONFLOW_BASE_URL
          : ai?.provider != null
            ? ''
            : undefined,
        aiModel: ai?.provider === 'siliconflow'
          ? siliconFlowModel
          : ai?.provider != null
            ? ''
            : undefined,
        aiTokenCiphertext,
        aiTokenIv,
        aiTokenTag,
        strategyRiskProfile: strategy?.riskProfile != null ? normalizeRiskProfile(strategy.riskProfile) : undefined,
        strategyAnalysisStrategy: strategy?.analysisStrategy != null
          ? normalizeAnalysisStrategy(strategy.analysisStrategy)
          : undefined,
        strategyMaxSingleTradeAmount: strategy?.maxSingleTradeAmount != null
          ? normalizeMaxSingleTradeAmount(strategy.maxSingleTradeAmount)
          : undefined,
        strategyPositionMaxPct: strategy?.positionMaxPct ?? undefined,
        strategyStopLossPct: strategy?.stopLossPct ?? undefined,
        strategyTakeProfitPct: strategy?.takeProfitPct ?? undefined,
        agentChatPreferencesJson: nextAgentChatPreferences,
      } as any,
    } as any);

    return await this.toPayload(updated);
  }
}
