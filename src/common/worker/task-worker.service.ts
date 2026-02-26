import { Injectable, Logger } from '@nestjs/common';
import { AnalysisTaskStatus } from '@prisma/client';

import { isAgentRunBridgeError } from '@/common/agent/agent.errors';
import { AgentRunBridgeService } from '@/common/agent/agent-run-bridge.service';
import type { AgentRuntimeConfig } from '@/common/agent/agent.types';
import { PrismaService } from '@/common/database/prisma.service';
import { mapAgentRunToAnalysis } from '@/modules/analysis/analysis.mapper';
import { AnalysisService } from '@/modules/analysis/analysis.service';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

@Injectable()
export class TaskWorkerService {
  private readonly logger = new Logger(TaskWorkerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRunBridge: AgentRunBridgeService,
    private readonly analysisService: AnalysisService,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.logger.log('Task worker started');

    while (this.running) {
      try {
        const processed = await this.processOne();
        if (!processed) {
          await this.sleep(1500);
        }
      } catch (error: unknown) {
        this.logger.error((error as Error).stack || (error as Error).message);
        await this.sleep(2000);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private shouldForwardRuntimeConfig(): boolean {
    return (process.env.AGENT_FORWARD_RUNTIME_CONFIG ?? 'false').toLowerCase() === 'true';
  }

  private resolveRuntimeConfigFromPayload(task: { requestPayload: unknown }): AgentRuntimeConfig | null {
    const payload = (task.requestPayload ?? {}) as Record<string, unknown>;
    const runtime = payload.runtime_config;
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
      return null;
    }
    return runtime as AgentRuntimeConfig;
  }

  private resolveAccountNameFromPayload(task: { requestPayload: unknown; ownerUserId: number | null }): string | null {
    const payload = (task.requestPayload ?? {}) as Record<string, unknown>;
    const runtime = (payload.runtime_config ?? {}) as Record<string, unknown>;
    const account = (runtime.account ?? {}) as Record<string, unknown>;
    const accountName = String(account.account_name ?? '').trim();
    if (accountName) {
      return accountName;
    }

    if (task.ownerUserId != null) {
      return `user-${task.ownerUserId}`;
    }
    return null;
  }

  private async resolveRunOptions(task: {
    id: number;
    taskId: string;
    requestPayload: unknown;
    ownerUserId: number | null;
  }): Promise<{
    accountName: string | null;
    runtimeConfig?: AgentRuntimeConfig;
    forceRuntimeConfig: boolean;
    executionMode: 'paper' | 'broker';
  }> {
    const executionMeta = this.analysisService.resolveExecutionMetaFromPayload(task.requestPayload);
    const shouldUseBroker = executionMeta.execution_mode === 'broker';

    if (task.ownerUserId != null) {
      const runtime = await this.analysisService.buildRuntimeContext(task.ownerUserId, {
        includeApiToken: this.shouldForwardRuntimeConfig(),
      });
      let runtimeConfig = this.analysisService.buildRuntimeConfigForExecution(runtime.runtimeConfig, executionMeta);
      if (shouldUseBroker) {
        if (!executionMeta.broker_account_id) {
          const error = new Error('broker 模式任务缺少 broker_account_id') as Error & { code: string };
          error.code = 'VALIDATION_ERROR';
          throw error;
        }
        const issued = await this.analysisService.issueTradeCredentialTicket({
          userId: task.ownerUserId,
          brokerAccountId: executionMeta.broker_account_id,
          taskId: task.taskId,
        });
        runtimeConfig = this.analysisService.buildRuntimeConfigForExecution(runtime.runtimeConfig, executionMeta, {
          credentialTicket: issued.ticket,
          ticketId: issued.ticketId,
        });
        await this.analysisService.updateTaskCredentialTicketMeta(task.id, issued.ticketId);
      }

      return {
        accountName: runtime.accountName,
        runtimeConfig,
        forceRuntimeConfig: shouldUseBroker,
        executionMode: executionMeta.execution_mode,
      };
    }

    if (shouldUseBroker) {
      const error = new Error('broker 模式任务缺少 owner_user_id，无法签发凭据票据') as Error & { code: string };
      error.code = 'VALIDATION_ERROR';
      throw error;
    }

    const runtimeConfig = this.resolveRuntimeConfigFromPayload(task);
    return {
      accountName: this.resolveAccountNameFromPayload(task),
      runtimeConfig: runtimeConfig
        ? this.analysisService.buildRuntimeConfigForExecution(runtimeConfig, executionMeta)
        : undefined,
      forceRuntimeConfig: false,
      executionMode: executionMeta.execution_mode,
    };
  }

  private async processOne(): Promise<boolean> {
    const candidate = await this.prisma.analysisTask.findFirst({
      where: { status: AnalysisTaskStatus.pending },
      orderBy: { createdAt: 'asc' },
    });

    if (!candidate) {
      return false;
    }

    const lock = await this.prisma.analysisTask.updateMany({
      where: {
        id: candidate.id,
        status: AnalysisTaskStatus.pending,
      },
      data: {
        status: AnalysisTaskStatus.processing,
        progress: 10,
        message: '正在分析中...',
        startedAt: new Date(),
      },
    });

    if (lock.count === 0) {
      return false;
    }

    await this.handleTask(candidate.id);
    return true;
  }

  private async handleTask(taskRowId: number): Promise<void> {
    const task = await this.prisma.analysisTask.findUnique({ where: { id: taskRowId } });
    if (!task) {
      return;
    }

    try {
      const options = await this.resolveRunOptions(task);
      const bridgeResult = await this.agentRunBridge.runViaAsyncTask([task.stockCode], task.taskId, {
        accountName: options.accountName,
        runtimeConfig: options.runtimeConfig,
        forceRuntimeConfig: options.forceRuntimeConfig,
      });
      if (options.executionMode === 'broker') {
        try {
          this.analysisService.assertBrokerExecutionSucceeded(bridgeResult.run, task.stockCode);
        } catch (error: unknown) {
          const degraded = new Error((error as Error).message) as Error & {
            code: string;
            bridgeMeta: Record<string, unknown>;
          };
          degraded.code = String((error as Error & { code?: string }).code ?? 'broker_execution_degraded');
          degraded.bridgeMeta = bridgeResult.bridgeMeta as unknown as Record<string, unknown>;
          throw degraded;
        }
      }
      const mapped = mapAgentRunToAnalysis(bridgeResult.run, task.stockCode, task.reportType);
      const resultPayload = {
        ...mapped.report,
        bridge_meta: bridgeResult.bridgeMeta,
      };

      await this.prisma.analysisHistory.create({
        data: {
          ownerUserId: task.ownerUserId,
          queryId: task.taskId,
          code: mapped.historyRecord.code,
          name: mapped.historyRecord.name,
          reportType: mapped.historyRecord.reportType,
          sentimentScore: mapped.historyRecord.sentimentScore,
          operationAdvice: mapped.historyRecord.operationAdvice,
          trendPrediction: mapped.historyRecord.trendPrediction,
          analysisSummary: mapped.historyRecord.analysisSummary,
          rawResult: mapped.historyRecord.rawResult,
          newsContent: mapped.historyRecord.newsContent,
          contextSnapshot: mapped.historyRecord.contextSnapshot,
          idealBuy: mapped.historyRecord.idealBuy,
          secondaryBuy: mapped.historyRecord.secondaryBuy,
          stopLoss: mapped.historyRecord.stopLoss,
          takeProfit: mapped.historyRecord.takeProfit,
        },
      });

      await this.prisma.analysisTask.update({
        where: { id: task.id },
        data: {
          status: AnalysisTaskStatus.completed,
          progress: 100,
          message: '分析完成',
          completedAt: new Date(),
          resultQueryId: task.taskId,
          resultPayload: resultPayload as any,
          updatedAt: new Date(),
        },
      });
    } catch (error: unknown) {
      const explicitCode = String((error as Error & { code?: string }).code ?? '').trim();
      const bridgeErrorCode = isAgentRunBridgeError(error) ? error.code : explicitCode || 'internal_error';
      const explicitBridgeMeta = asRecord((error as { bridgeMeta?: unknown }).bridgeMeta);
      const bridgeMeta = isAgentRunBridgeError(error)
        ? error.bridgeMeta
        : explicitBridgeMeta
          ? {
              agent_task_id: String(explicitBridgeMeta.agent_task_id ?? '') || null,
              agent_run_id: String(explicitBridgeMeta.agent_run_id ?? '') || null,
              poll_attempts: Number.isFinite(Number(explicitBridgeMeta.poll_attempts ?? 0))
                ? Number(explicitBridgeMeta.poll_attempts ?? 0)
                : 0,
              last_agent_status: explicitBridgeMeta.last_agent_status
                ? String(explicitBridgeMeta.last_agent_status)
                : null,
              bridge_error_code: bridgeErrorCode,
            }
          : {
            agent_task_id: null,
            agent_run_id: null,
            poll_attempts: 0,
            last_agent_status: null,
            bridge_error_code: bridgeErrorCode,
          };
      const rawMessage = (error as Error).message || 'Unknown task failure';
      const safeMessage = rawMessage.slice(0, 500);
      const uiMessage = `分析失败(${bridgeErrorCode}): ${safeMessage}`.slice(0, 200);

      this.logger.error(`Task failed: ${task.taskId} [${bridgeErrorCode}] ${safeMessage}`);

      await this.prisma.analysisTask.update({
        where: { id: task.id },
        data: {
          status: AnalysisTaskStatus.failed,
          progress: 100,
          message: uiMessage,
          error: `[${bridgeErrorCode}] ${safeMessage}`.slice(0, 500),
          resultPayload: {
            bridge_meta: {
              ...bridgeMeta,
              bridge_error_code: bridgeErrorCode,
            },
            error: {
              code: bridgeErrorCode,
              message: safeMessage,
            },
          } as any,
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), ms);
    });
  }
}
