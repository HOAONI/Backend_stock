import { Injectable } from '@nestjs/common';

import { BrokerGatewayError } from './broker.errors';

@Injectable()
export class BrokerGatewayClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor() {
    this.baseUrl = (process.env.BROKER_GATEWAY_BASE_URL ?? 'http://127.0.0.1:8010').replace(/\/$/, '');
    this.timeoutMs = Math.max(1000, Number(process.env.BROKER_GATEWAY_TIMEOUT_MS ?? '15000'));
  }

  private sanitizeMessage(value: unknown, fallback: string): string {
    const text = String(value ?? '').trim();
    return (text || fallback).slice(0, 500);
  }

  private isRetryableHttpStatus(status: number): boolean {
    return status >= 500 || status === 408 || status === 425 || status === 429;
  }

  async post(
    brokerCode: string,
    operation: 'verify' | 'account-summary' | 'positions' | 'orders' | 'trades',
    payload: object,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(
        `${this.baseUrl}/gateway/brokers/${encodeURIComponent(brokerCode)}/${operation}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );

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
        const asRecord = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
        const detail = asRecord.detail;
        const detailRecord = detail && typeof detail === 'object' && !Array.isArray(detail)
          ? (detail as Record<string, unknown>)
          : null;

        const upstreamCode = detailRecord?.error ?? asRecord.error;
        const message = this.sanitizeMessage(
          detailRecord?.message ?? asRecord.message ?? asRecord.error ?? raw,
          `Broker gateway request failed (${response.status})`,
        );

        throw new BrokerGatewayError(
          upstreamCode ? `${message} [${String(upstreamCode).slice(0, 64)}]` : message,
          'broker_gateway_upstream_error',
          {
            statusCode: response.status,
            retryable: this.isRetryableHttpStatus(response.status),
          },
        );
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new BrokerGatewayError('Broker gateway returned invalid JSON payload', 'broker_gateway_invalid_payload');
      }

      return parsed as Record<string, unknown>;
    } catch (error: unknown) {
      if (error instanceof BrokerGatewayError) {
        throw error;
      }

      const name = String((error as Error | undefined)?.name ?? '');
      if (name === 'AbortError') {
        throw new BrokerGatewayError(`Broker gateway timeout after ${this.timeoutMs}ms`, 'broker_gateway_timeout', {
          retryable: true,
        });
      }

      throw new BrokerGatewayError(
        this.sanitizeMessage((error as Error | undefined)?.message, 'Broker gateway network failure'),
        'broker_gateway_network_error',
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
