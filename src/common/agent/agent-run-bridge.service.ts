/** Agent 通信基础设施的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable } from '@nestjs/common';

import { AgentRunBridgeError, isAgentClientError } from './agent.errors';
import { AgentClientService } from './agent-client.service';
import { AgentBridgeMeta, AgentBridgeRunResult, AgentRunPayload, AgentTaskPayload, CreateAgentRunOptions } from './agent.types';

interface MutableBridgeMeta {
  agentTaskId: string | null;
  agentRunId: string | null;
  pollAttempts: number;
  lastAgentStatus: string | null;
  bridgeErrorCode: string | null;
}

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class AgentRunBridgeService {
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly pollMaxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(private readonly agentClient: AgentClientService) {
    this.pollIntervalMs = Math.max(200, Number(process.env.AGENT_TASK_POLL_INTERVAL_MS ?? '2000'));
    this.pollTimeoutMs = Math.max(10_000, Number(process.env.AGENT_TASK_POLL_TIMEOUT_MS ?? '600000'));
    this.pollMaxRetries = Math.max(0, Number(process.env.AGENT_TASK_POLL_MAX_RETRIES ?? '3'));
    this.retryBaseDelayMs = Math.max(100, Number(process.env.AGENT_TASK_RETRY_BASE_DELAY_MS ?? '1000'));
  }

  // Backend 始终通过 async task 驱动 Agent，这样同步接口、异步队列和 worker 可以复用同一套桥接逻辑。
  async runViaAsyncTask(stockCodes: string[], requestId?: string, options?: CreateAgentRunOptions): Promise<AgentBridgeRunResult> {
    const meta = this.newMutableBridgeMeta();
    let createdTask: AgentTaskPayload;
    try {
      createdTask = await this.agentClient.createRunAsync(stockCodes, requestId, options);
    } catch (error: unknown) {
      throw this.wrapBridgeError('agent_task_submit_failed', error, meta);
    }

    const taskId = String(createdTask.task_id ?? '').trim();
    if (!taskId) {
      throw this.buildBridgeError('Agent async create response missing task_id', 'agent_task_invalid_payload', meta);
    }

    meta.agentTaskId = taskId;
    meta.lastAgentStatus = String(createdTask.status ?? '').trim() || null;

    if (createdTask.status === 'failed') {
      const message = this.cleanMessage(createdTask.error_message, 'Agent task failed');
      throw this.buildBridgeError(message, 'agent_task_failed', meta);
    }

    if (createdTask.status === 'completed') {
      const runId = this.requireRunId(createdTask, meta);
      const run = await this.getRunWithRetry(runId, meta);
      return {
        run,
        bridgeMeta: this.finalizeBridgeMeta(meta),
      };
    }

    return await this.pollUntilFinished(taskId, meta);
  }

  // 轮询阶段只对可重试错误做退避，真正的业务失败要尽快原样抛回调用方。
  private async pollUntilFinished(taskId: string, meta: MutableBridgeMeta): Promise<AgentBridgeRunResult> {
    const startedAt = Date.now();
    let consecutivePollErrors = 0;

    while (Date.now() - startedAt <= this.pollTimeoutMs) {
      await this.sleep(this.pollIntervalMs);
      meta.pollAttempts += 1;

      let taskPayload: AgentTaskPayload;
      try {
        taskPayload = await this.agentClient.getTask(taskId);
        consecutivePollErrors = 0;
      } catch (error: unknown) {
        if (this.isRetryablePollError(error)) {
          consecutivePollErrors += 1;
          if (consecutivePollErrors > this.pollMaxRetries) {
            throw this.wrapBridgeError('agent_poll_network_error', error, meta);
          }
          await this.sleep(this.retryDelayMs(consecutivePollErrors));
          continue;
        }
        throw this.wrapBridgeError('agent_upstream_error', error, meta);
      }

      meta.lastAgentStatus = String(taskPayload.status ?? '').trim() || null;

      if (taskPayload.status === 'completed') {
        const runId = this.requireRunId(taskPayload, meta);
        const run = await this.getRunWithRetry(runId, meta);
        return {
          run,
          bridgeMeta: this.finalizeBridgeMeta(meta),
        };
      }

      if (taskPayload.status === 'failed') {
        const message = this.cleanMessage(taskPayload.error_message, 'Agent task failed');
        throw this.buildBridgeError(message, 'agent_task_failed', meta);
      }
    }

    throw this.buildBridgeError(
      `Agent task polling timeout (${this.pollTimeoutMs}ms)`,
      'agent_poll_timeout',
      meta,
    );
  }

  // task 完成并不代表 run 详情已经可读，所以这里还要补一次 getRun 重试。
  private async getRunWithRetry(runId: string, meta: MutableBridgeMeta): Promise<AgentRunPayload> {
    meta.agentRunId = runId;
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        return await this.agentClient.getRun(runId);
      } catch (error: unknown) {
        const retryable = this.isRetryablePollError(error);
        if (retryable && attempt <= this.pollMaxRetries) {
          await this.sleep(this.retryDelayMs(attempt));
          continue;
        }
        throw this.wrapBridgeError(retryable ? 'agent_poll_network_error' : 'agent_run_fetch_failed', error, meta);
      }
    }
  }

  private requireRunId(payload: AgentTaskPayload, meta: MutableBridgeMeta): string {
    const runId = String(payload.run_id ?? '').trim();
    if (!runId) {
      throw this.buildBridgeError('Agent task completed but run_id is missing', 'agent_task_invalid_payload', meta);
    }
    meta.agentRunId = runId;
    return runId;
  }

  private retryDelayMs(attempt: number): number {
    const factor = Math.max(1, attempt);
    return Math.min(10_000, this.retryBaseDelayMs * 2 ** (factor - 1));
  }

  private isRetryablePollError(error: unknown): boolean {
    if (!isAgentClientError(error)) {
      return false;
    }
    return error.retryable;
  }

  private wrapBridgeError(
    code: AgentRunBridgeError['code'],
    error: unknown,
    meta: MutableBridgeMeta,
  ): AgentRunBridgeError {
    const message = this.messageFromUnknown(error);
    return this.buildBridgeError(message, code, meta);
  }

  private buildBridgeError(message: string, code: AgentRunBridgeError['code'], meta: MutableBridgeMeta): AgentRunBridgeError {
    meta.bridgeErrorCode = code;
    return new AgentRunBridgeError(message, code, this.finalizeBridgeMeta(meta));
  }

  private messageFromUnknown(error: unknown): string {
    if (isAgentClientError(error)) {
      const upstreamCode = error.upstreamErrorCode ? ` [${error.upstreamErrorCode}]` : '';
      const status = error.statusCode != null ? ` (HTTP ${error.statusCode})` : '';
      return `${error.message}${status}${upstreamCode}`.slice(0, 500);
    }
    return this.cleanMessage((error as Error | undefined)?.message, 'Agent request failed');
  }

  private cleanMessage(raw: unknown, fallback: string): string {
    const message = String(raw ?? '').trim();
    return (message || fallback).slice(0, 500);
  }

  private newMutableBridgeMeta(): MutableBridgeMeta {
    return {
      agentTaskId: null,
      agentRunId: null,
      pollAttempts: 0,
      lastAgentStatus: null,
      bridgeErrorCode: null,
    };
  }

  private finalizeBridgeMeta(meta: MutableBridgeMeta): AgentBridgeMeta {
    return {
      agent_task_id: meta.agentTaskId,
      agent_run_id: meta.agentRunId,
      poll_attempts: meta.pollAttempts,
      last_agent_status: meta.lastAgentStatus,
      bridge_error_code: meta.bridgeErrorCode,
    };
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), ms);
    });
  }
}
