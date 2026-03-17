/** Agent 通信基础设施的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable } from '@nestjs/common';

import { AgentClientError } from './agent.errors';

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class BacktestAgentClientService {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor() {
    this.baseUrl = (
      process.env.BACKTEST_AGENT_BASE_URL
      ?? process.env.AGENT_BASE_URL
      ?? 'http://127.0.0.1:8001'
    ).replace(/\/$/, '');
    this.token = String(
      process.env.BACKTEST_AGENT_TOKEN
      ?? process.env.AGENT_SERVICE_AUTH_TOKEN
      ?? '',
    ).trim();
    this.timeoutMs = Math.max(2000, Number(process.env.BACKTEST_AGENT_TIMEOUT_MS ?? '30000'));
  }

  private sanitizeMessage(input: unknown, fallback: string): string {
    const text = String(input ?? '').trim();
    return (text || fallback).slice(0, 500);
  }

  private isRetryableHttpStatus(status: number): boolean {
    if (status >= 500) {
      return true;
    }
    return status === 408 || status === 425 || status === 429;
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown = {};
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = { message: text };
        }
      }
      const payloadRecord = asRecord(parsed);

      if (!response.ok) {
        const detail = asRecord(payloadRecord.detail);
        const message = this.sanitizeMessage(
          detail.message ?? payloadRecord.message ?? payloadRecord.error ?? text,
          `Backtest agent request failed (${response.status})`,
        );
        const upstreamCode = String(detail.error ?? payloadRecord.error ?? 'agent_http_error').slice(0, 64);
        throw new AgentClientError(message, 'agent_http_error', {
          statusCode: response.status,
          upstreamErrorCode: upstreamCode,
          retryable: this.isRetryableHttpStatus(response.status),
        });
      }

      if (payloadRecord.ok === false) {
        const detail = asRecord(payloadRecord.error);
        throw new AgentClientError(
          this.sanitizeMessage(detail.message ?? payloadRecord.message, 'Backtest agent returned failure'),
          'agent_http_error',
          {
            statusCode: Number.isFinite(Number(detail.http_status)) ? Number(detail.http_status) : undefined,
            upstreamErrorCode: String(detail.code ?? payloadRecord.error ?? 'agent_http_error').slice(0, 64),
            retryable: Boolean(detail.retryable),
          },
        );
      }

      if (payloadRecord.ok === true && Object.prototype.hasOwnProperty.call(payloadRecord, 'data')) {
        return asRecord(payloadRecord.data);
      }

      return payloadRecord;
    } catch (error: unknown) {
      if (error instanceof AgentClientError) {
        throw error;
      }

      const name = String((error as Error | undefined)?.name ?? '');
      if (name === 'AbortError') {
        throw new AgentClientError(
          `Backtest agent request timeout after ${this.timeoutMs}ms`,
          'agent_timeout',
          { retryable: true },
        );
      }

      throw new AgentClientError(
        this.sanitizeMessage((error as Error | undefined)?.message, 'Backtest agent network failure'),
        'agent_network_error',
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async run(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.post('/internal/v1/backtest/run', payload);
  }

  async summary(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.post('/internal/v1/backtest/summary', payload);
  }

  async curves(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.post('/internal/v1/backtest/curves', payload);
  }

  async distribution(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.post('/internal/v1/backtest/distribution', payload);
  }

  async compare(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.post('/internal/v1/backtest/compare', payload);
  }

  async strategyRun(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.post('/internal/v1/backtest/strategy/run', payload);
  }

  async agentRun(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.post('/internal/v1/backtest/agent/run', payload);
  }
}
