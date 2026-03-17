/** 模拟账户模块的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable } from '@nestjs/common';
import { BrokerEnvironment, UserBrokerAccount, UserBrokerAccountStatus } from '@prisma/client';

import { BrokerAdapterRegistry } from '@/common/broker/broker-adapter.registry';
import { isBrokerGatewayError } from '@/common/broker/broker.errors';
import { BrokerAccessContext } from '@/common/broker/broker.types';
import { PrismaService } from '@/common/database/prisma.service';
import { BrokerCryptoService } from '@/common/security/broker-crypto.service';
import { safeJsonParse, safeJsonStringify } from '@/common/utils/json';

import { BindSimulationAccountDto } from './broker-accounts.dto';

interface ServiceError extends Error {
  code?: string;
  statusCode?: number;
}

function createServiceError(code: string, message: string, statusCode?: number): ServiceError {
  const error = new Error(message) as ServiceError;
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface BrokerAccountAccess extends BrokerAccessContext {}

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class BrokerAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brokerCrypto: BrokerCryptoService,
    private readonly brokerRegistry: BrokerAdapterRegistry,
  ) {}

  private simulationBrokerCode(): string {
    return 'backtrader_local';
  }

  private defaultSimulationProviderCode(): string {
    return 'backtrader_local';
  }

  private resolveProviderName(): string {
    return 'Backtrader Local Sim';
  }

  private autoOrderEnabled(): boolean {
    return (process.env.ANALYSIS_AUTO_ORDER_ENABLED ?? 'true').toLowerCase() === 'true';
  }

  private normalizeAccountUid(value: string): string {
    const accountUid = String(value ?? '').trim();
    if (!accountUid) {
      throw createServiceError('VALIDATION_ERROR', 'account_uid 不能为空');
    }
    return truncateText(accountUid, 128);
  }

  private normalizeInitialCapital(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      throw createServiceError('VALIDATION_ERROR', 'initial_capital 必须大于 0');
    }
    return Number(n.toFixed(2));
  }

  private normalizeOptionalNonNegativeNumber(value: unknown, fieldName: string): number | null {
    if (value == null || value === '') {
      return null;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw createServiceError('VALIDATION_ERROR', `${fieldName} 必须是大于等于 0 的数字`);
    }
    return Number(n.toFixed(6));
  }

  private buildBacktraderCredentials(input: {
    initialCapital: number;
    commissionRate?: number | null;
    slippageBps?: number | null;
    credentials?: Record<string, unknown> | null;
  }): Record<string, unknown> {
    const merged = isRecord(input.credentials) ? { ...input.credentials } : {};
    const initialCapital = this.normalizeInitialCapital(
      merged.initial_capital ?? merged.initialCapital ?? input.initialCapital,
    );
    const commissionRate = this.normalizeOptionalNonNegativeNumber(
      merged.commission_rate ?? merged.commissionRate ?? input.commissionRate,
      'commission_rate',
    );
    const slippageBps = this.normalizeOptionalNonNegativeNumber(
      merged.slippage_bps ?? merged.slippageBps ?? input.slippageBps,
      'slippage_bps',
    );

    return {
      engine: 'backtrader',
      market: 'CN_A',
      currency: 'CNY',
      initial_capital: initialCapital,
      ...(commissionRate != null ? { commission_rate: commissionRate } : {}),
      ...(slippageBps != null ? { slippage_bps: slippageBps } : {}),
    };
  }

  private encryptCredentials(credentials: Record<string, unknown>): {
    credentialCiphertext: string;
    credentialIv: string;
    credentialTag: string;
  } {
    try {
      const serialized = safeJsonStringify(credentials);
      const encrypted = this.brokerCrypto.encrypt(serialized);
      return {
        credentialCiphertext: encrypted.ciphertext,
        credentialIv: encrypted.iv,
        credentialTag: encrypted.tag,
      };
    } catch (error: unknown) {
      throw createServiceError(
        'VALIDATION_ERROR',
        (error as Error).message || '券商凭据加密失败，请检查 BROKER_SECRET_KEY 配置',
      );
    }
  }

  private decryptCredentials(row: Pick<UserBrokerAccount, 'credentialCiphertext' | 'credentialIv' | 'credentialTag'>): Record<string, unknown> {
    try {
      const plain = this.brokerCrypto.decrypt({
        ciphertext: row.credentialCiphertext,
        iv: row.credentialIv,
        tag: row.credentialTag,
      });
      return safeJsonParse<Record<string, unknown>>(plain, {});
    } catch (error: unknown) {
      throw createServiceError(
        'VALIDATION_ERROR',
        (error as Error).message || '券商凭据解密失败，请检查 BROKER_SECRET_KEY 配置',
      );
    }
  }

  private sanitizeBrokerErrorMessage(value: unknown, fallback = '上游服务请求失败'): string {
    const raw = String(value ?? '').trim() || fallback;
    return raw
      .replace(/(Bearer\s+)[A-Za-z0-9._\-+=:/]+/gi, '$1***')
      .replace(/("(?:token|api[_-]?key|secret|password)"\s*:\s*")[^"]*"/gi, '$1***"')
      .replace(/((?:token|api[_-]?key|secret|password)\s*[=:]\s*)\S+/gi, '$1***')
      .slice(0, 500);
  }

  private mapAccount(row: UserBrokerAccount): Record<string, unknown> {
    return {
      id: row.id,
      broker_code: row.brokerCode,
      environment: row.environment,
      account_uid: row.accountUid,
      account_display_name: row.accountDisplayName,
      provider_code: row.providerCode ?? this.defaultSimulationProviderCode(),
      provider_name: row.providerName ?? this.resolveProviderName(),
      status: row.status,
      is_verified: row.isVerified,
      last_verified_at: row.lastVerifiedAt?.toISOString() ?? null,
      credentials_masked: true,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  private mapAccess(userId: number, row: UserBrokerAccount): BrokerAccountAccess {
    return {
      userId,
      brokerAccountId: row.id,
      brokerCode: row.brokerCode,
      environment: row.environment,
      accountUid: row.accountUid,
      accountDisplayName: row.accountDisplayName,
      providerCode: row.providerCode ?? this.defaultSimulationProviderCode(),
      providerName: row.providerName ?? this.resolveProviderName(),
      credentials: this.decryptCredentials(row),
    };
  }

  private createSimulationAccountRequiredError(message = '请先初始化并校验模拟盘账户'): ServiceError {
    return createServiceError('SIMULATION_ACCOUNT_REQUIRED', message);
  }

  private async loadSimulationAccount(userId: number): Promise<UserBrokerAccount | null> {
    return await this.prisma.userBrokerAccount.findFirst({
      where: {
        userId,
        brokerCode: this.simulationBrokerCode(),
        environment: BrokerEnvironment.simulation,
        deletedAt: null,
      },
      orderBy: [{ isVerified: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
    });
  }

  async getMySimulationAccountStatus(userId: number): Promise<Record<string, unknown>> {
    const row = await this.loadSimulationAccount(userId);
    const isBound = Boolean(row && row.status === UserBrokerAccountStatus.active);
    const isVerified = isBound ? Boolean(row?.isVerified) : false;

    return {
      is_bound: isBound,
      is_verified: isVerified,
      requires_setup: !isBound || !isVerified,
      broker_account_id: isBound ? row?.id ?? null : null,
      account_uid: isBound ? row?.accountUid ?? null : null,
      account_display_name: isBound ? row?.accountDisplayName ?? null : null,
      broker_code: isBound ? row?.brokerCode ?? null : null,
      provider_code: isBound ? row?.providerCode ?? this.defaultSimulationProviderCode() : null,
      provider_name: isBound ? row?.providerName ?? this.resolveProviderName() : null,
      compliance_region: 'CN',
      auto_order_enabled: this.autoOrderEnabled(),
      engine: 'backtrader',
      environment: isBound ? row?.environment ?? null : null,
      last_verified_at: isBound ? row?.lastVerifiedAt?.toISOString() ?? null : null,
    };
  }

  async bindMySimulationAccount(userId: number, input: BindSimulationAccountDto): Promise<Record<string, unknown>> {
    const brokerCode = this.simulationBrokerCode();
    const providerCode = this.defaultSimulationProviderCode();
    const providerName = this.resolveProviderName();
    const accountUid = this.normalizeAccountUid(input.account_uid ?? `bt-user-${userId}`);
    const accountDisplayName = input.account_display_name != null
      ? truncateText(String(input.account_display_name).trim(), 128) || null
      : null;
    const initialCapital = this.normalizeInitialCapital(input.initial_capital);
    const credentials = this.buildBacktraderCredentials({
      initialCapital,
      commissionRate: input.commission_rate,
      slippageBps: input.slippage_bps,
      credentials: input.credentials ?? null,
    });
    const encrypted = this.encryptCredentials(credentials);

    const account = await this.prisma.$transaction(async (tx) => {
      await tx.adminUserProfile.upsert({
        where: { userId },
        update: {
          simulationInitialCapital: initialCapital,
          simulationAccountName: accountDisplayName ?? '',
          simulationAccountId: accountUid,
        },
        create: {
          userId,
          simulationInitialCapital: initialCapital,
          simulationAccountName: accountDisplayName ?? '',
          simulationAccountId: accountUid,
        },
      });

      const existing = await tx.userBrokerAccount.findFirst({
        where: {
          userId,
          brokerCode,
          deletedAt: null,
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      });

      const primary = existing
        ? await tx.userBrokerAccount.update({
            where: { id: existing.id },
            data: {
              environment: BrokerEnvironment.simulation,
              accountUid,
              accountDisplayName,
              providerCode,
              providerName,
              credentialCiphertext: encrypted.credentialCiphertext,
              credentialIv: encrypted.credentialIv,
              credentialTag: encrypted.credentialTag,
              status: UserBrokerAccountStatus.active,
              isVerified: false,
              lastVerifiedAt: null,
              deletedAt: null,
            },
          })
        : await tx.userBrokerAccount.create({
            data: {
              userId,
              brokerCode,
              environment: BrokerEnvironment.simulation,
              accountUid,
              accountDisplayName,
              providerCode,
              providerName,
              credentialCiphertext: encrypted.credentialCiphertext,
              credentialIv: encrypted.credentialIv,
              credentialTag: encrypted.credentialTag,
              status: UserBrokerAccountStatus.active,
              isVerified: false,
            },
          });

      const staleRows = await tx.userBrokerAccount.findMany({
        where: {
          userId,
          brokerCode,
          deletedAt: null,
          id: { not: primary.id },
        },
        select: { id: true },
      });
      const staleIds = staleRows.map(item => item.id);
      if (staleIds.length > 0) {
        await tx.userBrokerAccount.updateMany({
          where: { id: { in: staleIds } },
          data: {
            status: UserBrokerAccountStatus.disabled,
            isVerified: false,
            lastVerifiedAt: null,
            deletedAt: new Date(),
          },
        });
        await tx.userBrokerSnapshotCache.deleteMany({ where: { userId, brokerAccountId: { in: staleIds } } });
        await tx.agentCredentialTicket.deleteMany({ where: { userId, brokerAccountId: { in: staleIds } } });
      }

      return primary;
    });

    const context = this.mapAccess(userId, account);
    try {
      const verifyResult = await this.brokerRegistry.getAdapter(context.brokerCode).verify(context);
      const verified = await this.prisma.userBrokerAccount.update({
        where: { id: account.id },
        data: {
          status: UserBrokerAccountStatus.active,
          isVerified: true,
          lastVerifiedAt: new Date(),
        },
      });

      return {
        account: this.mapAccount(verified),
        verify_result: verifyResult,
      };
    } catch (error: unknown) {
      if (isBrokerGatewayError(error)) {
        throw createServiceError('UPSTREAM_ERROR', this.sanitizeBrokerErrorMessage(error.message), error.statusCode);
      }
      throw error;
    }
  }

  async resolveSimulationAccess(userId: number, options?: { requireVerified?: boolean }): Promise<BrokerAccountAccess> {
    const row = await this.loadSimulationAccount(userId);
    if (!row || row.status !== UserBrokerAccountStatus.active) {
      throw this.createSimulationAccountRequiredError();
    }
    if (options?.requireVerified && !row.isVerified) {
      throw this.createSimulationAccountRequiredError();
    }
    return this.mapAccess(userId, row);
  }
}
