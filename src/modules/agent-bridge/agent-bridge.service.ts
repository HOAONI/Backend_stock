import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { AgentCredentialScope } from '@prisma/client';

import { PrismaService } from '@/common/database/prisma.service';
import { safeJsonStringify } from '@/common/utils/json';
import { BrokerAccountsService } from '@/modules/broker-accounts/broker-accounts.service';

import { AgentExecutionEventDto, IssueCredentialTicketDto } from './agent-bridge.dto';

interface ServiceError extends Error {
  code?: string;
}

function createServiceError(code: string, message: string): ServiceError {
  const error = new Error(message) as ServiceError;
  error.code = code;
  return error;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
}

@Injectable()
export class AgentBridgeService {
  private readonly defaultTicketTtlSec: number;
  private readonly maxTicketTtlSec: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly brokerAccountsService: BrokerAccountsService,
  ) {
    this.maxTicketTtlSec = Math.max(10, Number(process.env.AGENT_CREDENTIAL_TICKET_MAX_TTL_SEC ?? '3600'));
    this.defaultTicketTtlSec = Math.min(
      this.maxTicketTtlSec,
      Math.max(10, Number(process.env.AGENT_CREDENTIAL_TICKET_TTL_SEC ?? '900')),
    );
  }

  private toScope(value: string): AgentCredentialScope {
    return value === 'trade' ? AgentCredentialScope.trade : AgentCredentialScope.read;
  }

  private buildTicket(): { token: string; hash: string } {
    const token = `agt_${randomUUID().replace(/-/g, '')}_${randomBytes(8).toString('hex')}`;
    const hash = createHash('sha256').update(token).digest('hex');
    return { token, hash };
  }

  async issueCredentialTicket(input: IssueCredentialTicketDto): Promise<Record<string, unknown>> {
    const access = input.broker_account_id
      ? await this.brokerAccountsService.resolveAccessForInternalTicket(input.user_id, input.broker_account_id)
      : await this.brokerAccountsService.resolveAccess(input.user_id, undefined, { requireVerified: true });

    const ttlSec = Math.max(10, Math.min(this.maxTicketTtlSec, Number(input.ttl_seconds ?? this.defaultTicketTtlSec)));
    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    const scope = this.toScope(input.scope);

    const generated = this.buildTicket();
    const row = await this.prisma.agentCredentialTicket.create({
      data: {
        ticketHash: generated.hash,
        userId: access.userId,
        brokerAccountId: access.brokerAccountId,
        scope,
        taskId: input.task_id ? truncateText(String(input.task_id).trim(), 64) : null,
        expiresAt,
      },
    });

    return {
      ticket: generated.token,
      ticket_id: row.id,
      user_id: row.userId,
      broker_account_id: row.brokerAccountId,
      scope: row.scope,
      expires_at: row.expiresAt.toISOString(),
      created_at: row.createdAt.toISOString(),
    };
  }

  async exchangeCredentialTicket(ticket: string): Promise<Record<string, unknown>> {
    const token = String(ticket ?? '').trim();
    if (!token) {
      throw createServiceError('VALIDATION_ERROR', 'ticket 不能为空');
    }

    const hash = createHash('sha256').update(token).digest('hex');
    const now = new Date();

    const row = await this.prisma.agentCredentialTicket.findUnique({ where: { ticketHash: hash } });
    if (!row) {
      throw createServiceError('NOT_FOUND', 'ticket 不存在或已失效');
    }

    if (row.consumedAt) {
      throw createServiceError('GONE', 'ticket 已被消费');
    }

    if (row.expiresAt.getTime() <= now.getTime()) {
      throw createServiceError('GONE', 'ticket 已过期');
    }

    const consumed = await this.prisma.agentCredentialTicket.updateMany({
      where: {
        id: row.id,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        consumedAt: now,
      },
    });

    if (consumed.count === 0) {
      throw createServiceError('GONE', 'ticket 已被消费或过期');
    }

    const access = await this.brokerAccountsService.resolveAccessForInternalTicket(row.userId, row.brokerAccountId);

    return {
      ticket_id: row.id,
      user_id: row.userId,
      broker_account: {
        id: access.brokerAccountId,
        broker_code: access.brokerCode,
        environment: access.environment,
        account_uid: access.accountUid,
        account_display_name: access.accountDisplayName,
      },
      scope: row.scope,
      task_id: row.taskId,
      credentials: access.credentials,
      issued_at: row.createdAt.toISOString(),
      expires_at: row.expiresAt.toISOString(),
      consumed_at: now.toISOString(),
    };
  }

  async recordExecutionEvent(input: AgentExecutionEventDto): Promise<Record<string, unknown>> {
    await this.brokerAccountsService.resolveAccessByAccountId(input.user_id, input.broker_account_id, {
      requireVerified: false,
    });

    const row = await this.prisma.agentExecutionEvent.create({
      data: {
        userId: input.user_id,
        brokerAccountId: input.broker_account_id,
        taskId: input.task_id ? truncateText(String(input.task_id).trim(), 64) : null,
        eventType: truncateText(String(input.event_type).trim(), 64),
        payloadJson: input.payload ? safeJsonStringify(input.payload) : null,
        status: truncateText(String(input.status ?? 'received').trim() || 'received', 32),
        errorCode: input.error_code ? truncateText(String(input.error_code).trim(), 64) : null,
      },
    });

    return {
      ok: true,
      id: row.id,
      created_at: row.createdAt.toISOString(),
    };
  }
}
