/** 券商适配基础设施的适配器实现，把外部协议转换成系统内部统一接口。 */

import { Injectable } from '@nestjs/common';

import { BrokerGatewayError } from './broker.errors';
import { AddFundsRequest, BrokerAccessContext, BrokerAdapter, GatewayRequestPayload, OrderRequest } from './broker.types';

type BacktraderOperation =
  | 'accounts/provision'
  | 'account-summary'
  | 'positions'
  | 'orders'
  | 'trades'
  | 'place-order'
  | 'cancel-order'
  | 'add-funds';

function asArrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => item as Record<string, unknown>);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toRequestPayload(
  context: BrokerAccessContext,
  options?: { payload?: Record<string, unknown> | null; idempotencyKey?: string | null },
): GatewayRequestPayload {
  return {
    user_id: context.userId,
    broker_account_id: context.brokerAccountId,
    environment: context.environment,
    account_uid: context.accountUid,
    account_display_name: context.accountDisplayName,
    provider_code: context.providerCode ?? 'backtrader_local',
    provider_name: context.providerName ?? 'Backtrader Local Sim',
    payload: options?.payload ?? undefined,
    idempotency_key: options?.idempotencyKey ?? null,
    credentials: context.credentials,
  };
}

/** 负责把外部协议或第三方返回结果映射成系统内部统一的数据约定。 */
@Injectable()
export class BacktraderAgentAdapter implements BrokerAdapter {
  readonly brokerCode = 'backtrader_local';

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor() {
    this.baseUrl = (
      process.env.BACKTRADER_AGENT_BASE_URL
      ?? process.env.AGENT_BASE_URL
      ?? 'http://127.0.0.1:8001'
    ).replace(/\/$/, '');
    this.token = String(
      process.env.BACKTRADER_AGENT_TOKEN
      ?? process.env.AGENT_SERVICE_AUTH_TOKEN
      ?? '',
    ).trim();
    this.timeoutMs = Math.max(2000, Number(process.env.BACKTRADER_AGENT_TIMEOUT_MS ?? '20000'));
  }

  private sanitizeMessage(value: unknown, fallback: string): string {
    const text = String(value ?? '').trim();
    return (text || fallback)
      .replace(/(Bearer\s+)[A-Za-z0-9._\-+=:/]+/gi, '$1***')
      .replace(/("(?:token|api[_-]?key|secret|password)"\s*:\s*")[^"]*"/gi, '$1***"')
      .replace(/((?:token|api[_-]?key|secret|password)\s*[=:]\s*)\S+/gi, '$1***')
      .slice(0, 500);
  }

  private isRetryableHttpStatus(status: number): boolean {
    return status >= 500 || status === 408 || status === 425 || status === 429;
  }

  private async post(operation: BacktraderOperation, payload: GatewayRequestPayload): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/internal/v1/backtrader/${operation}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const raw = await response.text();
      let parsed: unknown = {};
      if (raw) {
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          parsed = { message: raw };
        }
      }

      if (!response.ok) {
        const payloadRecord = asRecord(parsed);
        const detail = asRecord(payloadRecord.detail);
        const message = this.sanitizeMessage(
          detail.message ?? payloadRecord.message ?? payloadRecord.error ?? raw,
          `Backtrader agent request failed (${response.status})`,
        );
        const code = String(detail.error ?? payloadRecord.error ?? 'backtrader_agent_http_error').slice(0, 64);
        throw new BrokerGatewayError(message, code, {
          statusCode: response.status,
          retryable: this.isRetryableHttpStatus(response.status),
        });
      }

      const payloadRecord = asRecord(parsed);
      if (payloadRecord.ok === false) {
        const err = asRecord(payloadRecord.error);
        throw new BrokerGatewayError(
          this.sanitizeMessage(err.message ?? payloadRecord.message, 'Backtrader agent returned failure'),
          String(err.code ?? 'backtrader_agent_error').slice(0, 64),
          {
            statusCode: Number.isFinite(Number(err.http_status)) ? Number(err.http_status) : undefined,
            retryable: Boolean(err.retryable),
          },
        );
      }

      if (payloadRecord.ok === true && Object.prototype.hasOwnProperty.call(payloadRecord, 'data')) {
        const data = payloadRecord.data;
        if (Array.isArray(data)) {
          return { items: data };
        }
        return asRecord(data);
      }

      return payloadRecord;
    } catch (error: unknown) {
      if (error instanceof BrokerGatewayError) {
        throw error;
      }

      const name = String((error as Error | undefined)?.name ?? '');
      if (name === 'AbortError') {
        throw new BrokerGatewayError(
          `Backtrader agent timeout after ${this.timeoutMs}ms`,
          'backtrader_agent_timeout',
          { retryable: true },
        );
      }

      throw new BrokerGatewayError(
        this.sanitizeMessage((error as Error | undefined)?.message, 'Backtrader agent network failure'),
        'backtrader_agent_network_error',
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async verify(context: BrokerAccessContext): Promise<Record<string, unknown>> {
    return await this.post('accounts/provision', toRequestPayload(context));
  }

  async getAccountSummary(context: BrokerAccessContext): Promise<Record<string, unknown>> {
    return await this.post('account-summary', toRequestPayload(context));
  }

  async getPositions(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>> {
    const payload = await this.post('positions', toRequestPayload(context));
    return asArrayOfRecords(payload.items ?? payload.positions ?? payload.data ?? []);
  }

  async getOrders(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>> {
    const payload = await this.post('orders', toRequestPayload(context));
    return asArrayOfRecords(payload.items ?? payload.orders ?? payload.data ?? []);
  }

  async getTrades(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>> {
    const payload = await this.post('trades', toRequestPayload(context));
    return asArrayOfRecords(payload.items ?? payload.trades ?? payload.data ?? []);
  }

  async placeOrder(
    context: BrokerAccessContext,
    order: OrderRequest,
    options?: { idempotencyKey?: string | null; payload?: Record<string, unknown> | null },
  ): Promise<Record<string, unknown>> {
    return await this.post(
      'place-order',
      toRequestPayload(context, {
        payload: {
          order_id: order.orderId,
          stock_code: order.stockCode,
          stock_name: order.stockName,
          direction: order.direction,
          type: order.type,
          price: order.price,
          quantity: order.quantity,
          ...(options?.payload ?? {}),
        },
        idempotencyKey: options?.idempotencyKey ?? null,
      }),
    );
  }

  async cancelOrder(
    context: BrokerAccessContext,
    orderId: string,
    options?: { idempotencyKey?: string | null; payload?: Record<string, unknown> | null },
  ): Promise<Record<string, unknown>> {
    return await this.post(
      'cancel-order',
      toRequestPayload(context, {
        payload: {
          order_id: orderId,
          ...(options?.payload ?? {}),
        },
        idempotencyKey: options?.idempotencyKey ?? null,
      }),
    );
  }

  async addFunds(
    context: BrokerAccessContext,
    input: AddFundsRequest,
    options?: { idempotencyKey?: string | null; payload?: Record<string, unknown> | null },
  ): Promise<Record<string, unknown>> {
    return await this.post(
      'add-funds',
      toRequestPayload(context, {
        payload: {
          amount: input.amount,
          note: input.note,
          ...(options?.payload ?? {}),
        },
        idempotencyKey: options?.idempotencyKey ?? null,
      }),
    );
  }
}
