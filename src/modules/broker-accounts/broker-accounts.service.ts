import { Injectable } from '@nestjs/common';
import { BrokerEnvironment, Prisma, UserBrokerAccount, UserBrokerAccountStatus } from '@prisma/client';

import { BrokerAdapterRegistry } from '@/common/broker/broker-adapter.registry';
import { isBrokerGatewayError } from '@/common/broker/broker.errors';
import { BrokerAccessContext } from '@/common/broker/broker.types';
import { PrismaService } from '@/common/database/prisma.service';
import { BrokerCryptoService } from '@/common/security/broker-crypto.service';
import { safeJsonParse, safeJsonStringify } from '@/common/utils/json';

import { CreateBrokerAccountDto, UpdateBrokerAccountDto } from './broker-accounts.dto';

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

@Injectable()
export class BrokerAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brokerCrypto: BrokerCryptoService,
    private readonly brokerRegistry: BrokerAdapterRegistry,
  ) {}

  private normalizeBrokerCode(value: string): string {
    const brokerCode = String(value ?? '').trim().toLowerCase();
    if (!brokerCode) {
      throw createServiceError('VALIDATION_ERROR', 'broker_code 不能为空');
    }

    if (!this.brokerRegistry.getSupportedBrokers().includes(brokerCode)) {
      throw createServiceError('VALIDATION_ERROR', `不支持的券商: ${brokerCode}`);
    }

    return brokerCode;
  }

  private normalizeAccountUid(value: string): string {
    const accountUid = String(value ?? '').trim();
    if (!accountUid) {
      throw createServiceError('VALIDATION_ERROR', 'account_uid 不能为空');
    }
    return truncateText(accountUid, 128);
  }

  private normalizeEnvironment(value: string | undefined): BrokerEnvironment {
    const normalized = String(value ?? 'paper').trim().toLowerCase();
    if (normalized !== 'paper' && normalized !== 'simulation') {
      throw createServiceError('VALIDATION_ERROR', `不支持的环境: ${normalized || '(empty)'}`);
    }
    return normalized === 'simulation' ? BrokerEnvironment.simulation : BrokerEnvironment.paper;
  }

  private normalizeCredentials(value: unknown): Record<string, unknown> {
    if (!isRecord(value) || Object.keys(value).length === 0) {
      throw createServiceError('VALIDATION_ERROR', 'credentials 必须为非空对象');
    }
    return value;
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

  private mapAccount(row: UserBrokerAccount): Record<string, unknown> {
    return {
      id: row.id,
      broker_code: row.brokerCode,
      environment: row.environment,
      account_uid: row.accountUid,
      account_display_name: row.accountDisplayName,
      status: row.status,
      is_verified: row.isVerified,
      last_verified_at: row.lastVerifiedAt?.toISOString() ?? null,
      credentials_masked: true,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  private async loadAccountForUserOrThrow(
    userId: number,
    brokerAccountId: number,
    tx: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<UserBrokerAccount> {
    const row = await tx.userBrokerAccount.findFirst({
      where: {
        id: brokerAccountId,
        userId,
        deletedAt: null,
      },
    });
    if (!row) {
      throw createServiceError('NOT_FOUND', `券商账户 ${brokerAccountId} 不存在`);
    }
    return row;
  }

  async listMyAccounts(userId: number, limit = 50): Promise<Record<string, unknown>> {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = await this.prisma.userBrokerAccount.findMany({
      where: {
        userId,
        deletedAt: null,
      },
      orderBy: [{ isVerified: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
      take: safeLimit,
    });

    return {
      total: rows.length,
      items: rows.map((row) => this.mapAccount(row)),
    };
  }

  async createMyAccount(userId: number, input: CreateBrokerAccountDto): Promise<Record<string, unknown>> {
    const brokerCode = this.normalizeBrokerCode(input.broker_code);
    const environment = this.normalizeEnvironment(input.environment);
    const accountUid = this.normalizeAccountUid(input.account_uid);
    const accountDisplayName = input.account_display_name != null
      ? truncateText(String(input.account_display_name).trim(), 128) || null
      : null;
    const credentials = this.normalizeCredentials(input.credentials);
    const encrypted = this.encryptCredentials(credentials);

    const existing = await this.prisma.userBrokerAccount.findFirst({
      where: {
        userId,
        brokerCode,
        accountUid,
      },
    });

    if (existing && existing.deletedAt == null) {
      throw createServiceError('CONFLICT', `账户 ${brokerCode}/${accountUid} 已绑定`);
    }

    let saved: UserBrokerAccount;
    if (existing && existing.deletedAt != null) {
      saved = await this.prisma.userBrokerAccount.update({
        where: { id: existing.id },
        data: {
          environment,
          accountDisplayName,
          credentialCiphertext: encrypted.credentialCiphertext,
          credentialIv: encrypted.credentialIv,
          credentialTag: encrypted.credentialTag,
          status: UserBrokerAccountStatus.active,
          isVerified: false,
          lastVerifiedAt: null,
          deletedAt: null,
        },
      });
    } else {
      saved = await this.prisma.userBrokerAccount.create({
        data: {
          userId,
          brokerCode,
          environment,
          accountUid,
          accountDisplayName,
          credentialCiphertext: encrypted.credentialCiphertext,
          credentialIv: encrypted.credentialIv,
          credentialTag: encrypted.credentialTag,
          status: UserBrokerAccountStatus.active,
          isVerified: false,
        },
      });
    }

    return this.mapAccount(saved);
  }

  async updateMyAccount(userId: number, brokerAccountId: number, input: UpdateBrokerAccountDto): Promise<Record<string, unknown>> {
    const current = await this.loadAccountForUserOrThrow(userId, brokerAccountId);

    const data: Prisma.UserBrokerAccountUpdateInput = {};

    if (input.account_display_name != null) {
      data.accountDisplayName = truncateText(String(input.account_display_name).trim(), 128) || null;
    }

    if (input.status) {
      data.status = input.status === 'disabled' ? UserBrokerAccountStatus.disabled : UserBrokerAccountStatus.active;
    }

    if (input.credentials != null) {
      const credentials = this.normalizeCredentials(input.credentials);
      const encrypted = this.encryptCredentials(credentials);
      data.credentialCiphertext = encrypted.credentialCiphertext;
      data.credentialIv = encrypted.credentialIv;
      data.credentialTag = encrypted.credentialTag;
      data.isVerified = false;
      data.lastVerifiedAt = null;
    }

    if (Object.keys(data).length === 0) {
      return this.mapAccount(current);
    }

    const updated = await this.prisma.userBrokerAccount.update({
      where: { id: current.id },
      data,
    });

    return this.mapAccount(updated);
  }

  async verifyMyAccount(userId: number, brokerAccountId: number): Promise<Record<string, unknown>> {
    const account = await this.loadAccountForUserOrThrow(userId, brokerAccountId);
    if (account.status !== UserBrokerAccountStatus.active) {
      throw createServiceError('VALIDATION_ERROR', '禁用状态的账户不允许校验');
    }

    const context: BrokerAccountAccess = {
      userId,
      brokerAccountId: account.id,
      brokerCode: account.brokerCode,
      environment: account.environment,
      accountUid: account.accountUid,
      accountDisplayName: account.accountDisplayName,
      credentials: this.decryptCredentials(account),
    };

    try {
      const verifyResult = await this.brokerRegistry.getAdapter(account.brokerCode).verify(context);
      const updated = await this.prisma.userBrokerAccount.update({
        where: { id: account.id },
        data: {
          isVerified: true,
          lastVerifiedAt: new Date(),
          status: UserBrokerAccountStatus.active,
        },
      });

      return {
        account: this.mapAccount(updated),
        verify_result: verifyResult,
      };
    } catch (error: unknown) {
      if (isBrokerGatewayError(error)) {
        throw createServiceError(
          'UPSTREAM_ERROR',
          error.message,
          error.statusCode,
        );
      }
      throw error;
    }
  }

  async deleteMyAccount(userId: number, brokerAccountId: number): Promise<Record<string, unknown>> {
    const account = await this.loadAccountForUserOrThrow(userId, brokerAccountId);

    await this.prisma.$transaction(async (tx) => {
      await tx.userBrokerAccount.update({
        where: { id: account.id },
        data: {
          status: UserBrokerAccountStatus.disabled,
          isVerified: false,
          deletedAt: new Date(),
        },
      });

      await tx.userBrokerSnapshotCache.deleteMany({
        where: {
          userId,
          brokerAccountId: account.id,
        },
      });

      await tx.agentCredentialTicket.deleteMany({
        where: {
          userId,
          brokerAccountId: account.id,
          consumedAt: null,
        },
      });
    });

    return { ok: true };
  }

  async resolveAccess(userId: number, brokerAccountId?: number, options?: { requireVerified?: boolean }): Promise<BrokerAccountAccess> {
    const row = brokerAccountId
      ? await this.loadAccountForUserOrThrow(userId, brokerAccountId)
      : await this.prisma.userBrokerAccount.findFirst({
          where: {
            userId,
            deletedAt: null,
          },
          orderBy: [{ isVerified: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
        });

    if (!row) {
      throw createServiceError('NOT_FOUND', '未配置可用的券商账户');
    }

    if (row.status !== UserBrokerAccountStatus.active) {
      throw createServiceError('VALIDATION_ERROR', '券商账户已禁用');
    }

    if (options?.requireVerified && !row.isVerified) {
      throw createServiceError('VALIDATION_ERROR', '券商账户尚未通过 verify 校验');
    }

    return {
      userId,
      brokerAccountId: row.id,
      brokerCode: row.brokerCode,
      environment: row.environment,
      accountUid: row.accountUid,
      accountDisplayName: row.accountDisplayName,
      credentials: this.decryptCredentials(row),
    };
  }

  async resolveAccessByAccountId(userId: number, brokerAccountId: number, options?: { requireVerified?: boolean }): Promise<BrokerAccountAccess> {
    return this.resolveAccess(userId, brokerAccountId, options);
  }

  async resolveAccessForInternalTicket(userId: number, brokerAccountId: number): Promise<BrokerAccountAccess> {
    return this.resolveAccess(userId, brokerAccountId, { requireVerified: true });
  }
}
