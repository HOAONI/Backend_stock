import { Injectable } from '@nestjs/common';

import { AgentClientError } from './agent.errors';
import { AgentRunPayload, AgentTaskPayload, CreateAgentRunOptions } from './agent.types';

@Injectable()
export class AgentClientService {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly forwardRuntimeConfig: boolean;

  constructor() {
    this.baseUrl = (process.env.AGENT_BASE_URL ?? 'http://127.0.0.1:8001').replace(/\/$/, '');
    this.token = process.env.AGENT_SERVICE_AUTH_TOKEN ?? '';
    this.timeoutMs = Number(process.env.AGENT_REQUEST_TIMEOUT_MS ?? '120000');
    this.forwardRuntimeConfig = (process.env.AGENT_FORWARD_RUNTIME_CONFIG ?? 'false').toLowerCase() === 'true';
  }

  private sanitizeMessage(input: unknown, fallback: string): string {
    const message = String(input ?? '').trim();
    return (message || fallback).slice(0, 500);
  }

  private isHttpRetryable(statusCode: number): boolean {
    if (statusCode >= 500) {
      return true;
    }
    return statusCode === 408 || statusCode === 425 || statusCode === 429;
  }

  private normalizeErrorPayload(payload: unknown, rawText: string): { message: string; upstreamCode: string | null } {
    const fallback = this.sanitizeMessage(rawText, 'Agent request failed');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { message: fallback, upstreamCode: null };
    }

    const body = payload as Record<string, unknown>;
    const detail = body.detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const detailObj = detail as Record<string, unknown>;
      return {
        message: this.sanitizeMessage(detailObj.message ?? detailObj.error ?? fallback, fallback),
        upstreamCode: detailObj.error == null ? null : String(detailObj.error),
      };
    }

    return {
      message: this.sanitizeMessage(body.message ?? body.error ?? fallback, fallback),
      upstreamCode: body.error == null ? null : String(body.error),
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      };

      if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      const text = await response.text();
      let payload: unknown = {};
      if (text) {
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          if (response.ok) {
            throw new AgentClientError(
              `Agent response parse error: ${this.sanitizeMessage(text, 'non-json response')}`,
              'agent_response_parse_error',
              { retryable: false },
            );
          }
          payload = { message: text };
        }
      }

      if (!response.ok) {
        const normalized = this.normalizeErrorPayload(payload, text);
        throw new AgentClientError(
          normalized.message,
          'agent_http_error',
          {
            statusCode: response.status,
            upstreamErrorCode: normalized.upstreamCode,
            retryable: this.isHttpRetryable(response.status),
          },
        );
      }

      return payload as T;
    } catch (error: unknown) {
      if (error instanceof AgentClientError) {
        throw error;
      }

      const name = String((error as Error | undefined)?.name ?? '');
      if (name === 'AbortError') {
        throw new AgentClientError(
          `Agent request timeout after ${this.timeoutMs}ms`,
          'agent_timeout',
          { retryable: true },
        );
      }

      const message = this.sanitizeMessage((error as Error | undefined)?.message, 'network failure');
      throw new AgentClientError(`Agent network error: ${message}`, 'agent_network_error', { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  async createRunSync(stockCodes: string[], requestId?: string, options?: CreateAgentRunOptions): Promise<AgentRunPayload> {
    const body: Record<string, unknown> = {
      stock_codes: stockCodes,
      async_mode: false,
      request_id: requestId,
      account_name: options?.accountName || undefined,
    };
    if ((this.forwardRuntimeConfig || options?.forceRuntimeConfig) && options?.runtimeConfig) {
      body.runtime_config = options.runtimeConfig;
    }

    return await this.request<AgentRunPayload>('/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async createRunAsync(stockCodes: string[], requestId?: string, options?: CreateAgentRunOptions): Promise<AgentTaskPayload> {
    const body: Record<string, unknown> = {
      stock_codes: stockCodes,
      async_mode: true,
      request_id: requestId,
      account_name: options?.accountName || undefined,
    };
    if ((this.forwardRuntimeConfig || options?.forceRuntimeConfig) && options?.runtimeConfig) {
      body.runtime_config = options.runtimeConfig;
    }

    return await this.request<AgentTaskPayload>('/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getTask(taskId: string): Promise<AgentTaskPayload> {
    return await this.request<AgentTaskPayload>(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  async getRun(runId: string): Promise<AgentRunPayload> {
    return await this.request<AgentRunPayload>(`/api/v1/runs/${encodeURIComponent(runId)}`);
  }
}
