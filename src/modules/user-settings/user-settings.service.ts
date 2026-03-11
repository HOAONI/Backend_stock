import { Injectable } from '@nestjs/common';

import { AiRuntimeService } from '@/common/ai/ai-runtime.service';
import { PrismaService } from '@/common/database/prisma.service';
import { PersonalCryptoService } from '@/common/security/personal-crypto.service';

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

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
}

@Injectable()
export class UserSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly personalCrypto: PersonalCryptoService,
    private readonly aiRuntimeService: AiRuntimeService,
  ) {}

  private async ensureProfile(userId: number) {
    return this.prisma.adminUserProfile.upsert({
      where: { userId },
      update: {},
      create: { userId, aiProvider: DEFAULT_PERSONAL_PROVIDER, aiBaseUrl: '', aiModel: '' },
    });
  }

  private async toPayload(profile: Awaited<ReturnType<typeof this.ensureProfile>>): Promise<Record<string, unknown>> {
    const resolvedLlm = await this.aiRuntimeService.resolveEffectiveLlmFromProfile(profile, {
      includeApiToken: false,
      requireSystemDefault: false,
    });

    return {
      simulation: {
        accountName: profile.simulationAccountName,
        accountId: profile.simulationAccountId,
        initialCapital: profile.simulationInitialCapital,
        note: profile.simulationNote ?? '',
      },
      ai: {
        personalProvider: resolvedLlm.personalProvider,
        provider: resolvedLlm.effective.provider || '',
        baseUrl: resolvedLlm.effective.baseUrl,
        model: resolvedLlm.effective.model,
        hasToken: Boolean(profile.aiTokenCiphertext),
        apiTokenMasked: profile.aiTokenCiphertext ? MASKED_TOKEN : '',
        source: resolvedLlm.source,
        hasSystemToken: resolvedLlm.hasSystemToken,
        requiresProviderReselection: resolvedLlm.requiresProviderReselection,
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
        positionMaxPct: profile.strategyPositionMaxPct,
        stopLossPct: profile.strategyStopLossPct,
        takeProfitPct: profile.strategyTakeProfitPct,
      },
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

    let aiTokenCiphertext: string | null | undefined;
    let aiTokenIv: string | null | undefined;
    let aiTokenTag: string | null | undefined;
    const providerChanged = ai?.provider != null && ai.provider !== existing.aiProvider;
    const apiTokenProvided = Boolean(ai && Object.prototype.hasOwnProperty.call(ai, 'apiToken'));

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
        try {
          const encrypted = this.personalCrypto.encrypt(apiToken.trim());
          aiTokenCiphertext = encrypted.ciphertext;
          aiTokenIv = encrypted.iv;
          aiTokenTag = encrypted.tag;
        } catch (error: unknown) {
          const message = (error as Error).message || '个人 Token 加密失败';
          throw createServiceError('VALIDATION_ERROR', message);
        }
      }
    }

    const updated = await this.prisma.adminUserProfile.update({
      where: { userId: existing.userId },
      data: {
        simulationAccountName: simulation?.accountName != null ? truncateText(simulation.accountName.trim(), 128) : undefined,
        simulationAccountId: simulation?.accountId != null ? truncateText(simulation.accountId.trim(), 128) : undefined,
        simulationInitialCapital: simulation?.initialCapital ?? undefined,
        simulationNote: simulation?.note != null ? truncateText(simulation.note.trim(), 255) : undefined,
        aiProvider: ai?.provider ?? undefined,
        aiBaseUrl: ai?.provider != null ? '' : undefined,
        aiModel: ai?.provider != null ? '' : undefined,
        aiTokenCiphertext,
        aiTokenIv,
        aiTokenTag,
        strategyPositionMaxPct: strategy?.positionMaxPct ?? undefined,
        strategyStopLossPct: strategy?.stopLossPct ?? undefined,
        strategyTakeProfitPct: strategy?.takeProfitPct ?? undefined,
      },
    });

    return await this.toPayload(updated);
  }
}
