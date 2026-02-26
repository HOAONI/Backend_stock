import { Injectable } from '@nestjs/common';

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
  ) {}

  private async ensureProfile(userId: number) {
    return this.prisma.adminUserProfile.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  }

  private toPayload(profile: Awaited<ReturnType<typeof this.ensureProfile>>): Record<string, unknown> {
    return {
      simulation: {
        accountName: profile.simulationAccountName,
        accountId: profile.simulationAccountId,
        initialCapital: profile.simulationInitialCapital,
        note: profile.simulationNote ?? '',
      },
      ai: {
        provider: profile.aiProvider,
        baseUrl: profile.aiBaseUrl,
        model: profile.aiModel,
        hasToken: Boolean(profile.aiTokenCiphertext),
        apiTokenMasked: profile.aiTokenCiphertext ? MASKED_TOKEN : '',
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
    return this.toPayload(profile);
  }

  async updateMySettings(userId: number, input: UpdateUserSettingsDto): Promise<Record<string, unknown>> {
    const existing = await this.ensureProfile(userId);
    const simulation = input.simulation;
    const ai = input.ai;
    const strategy = input.strategy;

    let aiTokenCiphertext: string | null | undefined;
    let aiTokenIv: string | null | undefined;
    let aiTokenTag: string | null | undefined;

    if (ai && Object.prototype.hasOwnProperty.call(ai, 'apiToken')) {
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
        aiBaseUrl: ai?.baseUrl != null ? truncateText(ai.baseUrl.trim(), 255) : undefined,
        aiModel: ai?.model != null ? truncateText(ai.model.trim(), 128) : undefined,
        aiTokenCiphertext,
        aiTokenIv,
        aiTokenTag,
        strategyPositionMaxPct: strategy?.positionMaxPct ?? undefined,
        strategyStopLossPct: strategy?.stopLossPct ?? undefined,
        strategyTakeProfitPct: strategy?.takeProfitPct ?? undefined,
      },
    });

    return this.toPayload(updated);
  }
}
