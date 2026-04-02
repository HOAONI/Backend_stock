/** Agent 问股模块服务。 */

import { Injectable } from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { AgentClientService } from '@/common/agent/agent-client.service';
import { AgentRuntimeConfig } from '@/common/agent/agent.types';
import { PrismaService } from '@/common/database/prisma.service';
import { safeJsonStringify } from '@/common/utils/json';
import { AnalysisService } from '@/modules/analysis/analysis.service';
import { BrokerAccountsService } from '@/modules/broker-accounts/broker-accounts.service';
import { TradingAccountService } from '@/modules/trading-account/trading-account.service';

import { AgentChatRequestDto } from './agent-chat.dto';

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

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown, fallback = ''): string {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function asNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 负责承接 Agent 问股的前端代理、用户隔离和内部工具数据聚合。 */
@Injectable()
export class AgentChatService {
  constructor(
    private readonly agentClient: AgentClientService,
    private readonly prisma: PrismaService,
    private readonly analysisService: AnalysisService,
    private readonly brokerAccountsService: BrokerAccountsService,
    private readonly tradingAccountService: TradingAccountService,
  ) {}

  private buildOwnerWhere(ownerUserId: number): { ownerUserId: number } {
    return { ownerUserId };
  }

  private buildRuntimeContextIntoConfig(
    runtimeConfig: AgentRuntimeConfig,
    runtimeContext: Record<string, unknown> | null,
  ): AgentRuntimeConfig {
    const next: AgentRuntimeConfig = {
      ...runtimeConfig,
    };
    if (!runtimeContext) {
      return next;
    }

    const summary = asRecord(runtimeContext.summary);
    const positions = Array.isArray(runtimeContext.positions)
      ? runtimeContext.positions.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>>
      : [];

    next.context = {
      account_snapshot: {
        broker_account_id: runtimeContext.broker_account_id,
        provider_code: runtimeContext.provider_code,
        provider_name: runtimeContext.provider_name,
        account_uid: runtimeContext.account_uid,
        account_display_name: runtimeContext.account_display_name,
        snapshot_at: runtimeContext.snapshot_at,
        data_source: runtimeContext.data_source,
        cash: summary.cash ?? summary.available_cash ?? null,
        initial_cash: summary.initial_capital ?? summary.initial_cash ?? null,
        total_market_value: summary.market_value ?? summary.total_market_value ?? null,
        total_asset: summary.total_asset ?? summary.total_equity ?? null,
        positions,
      },
      summary,
      positions,
    };
    return next;
  }

  private async buildAgentPayload(userId: number, username: string, body: AgentChatRequestDto): Promise<Record<string, unknown>> {
    const [runtime, simulationAccount] = await Promise.all([
      this.analysisService.buildRuntimeContext(userId, { includeApiToken: true }),
      this.brokerAccountsService.getMySimulationAccountStatus(userId),
    ]);

    let runtimeContext: Record<string, unknown> | null = null;
    if (simulationAccount.is_bound && simulationAccount.is_verified) {
      try {
        runtimeContext = await this.tradingAccountService.getRuntimeContext(userId, true) as unknown as Record<string, unknown>;
      } catch {
        runtimeContext = null;
      }
    }

    const runtimeConfig = this.buildRuntimeContextIntoConfig(runtime.runtimeConfig, runtimeContext);
    const nextContext = {
      ...(body.context ?? {}),
      simulation_account: simulationAccount,
    };

    return {
      owner_user_id: userId,
      username,
      message: body.message,
      session_id: body.session_id,
      context: nextContext,
      runtime_config: runtimeConfig,
    };
  }

  async chat(userId: number, username: string, body: AgentChatRequestDto): Promise<Record<string, unknown>> {
    const payload = await this.buildAgentPayload(userId, username, body);
    return await this.agentClient.createChat(payload);
  }

  async openChatStream(userId: number, username: string, body: AgentChatRequestDto): Promise<Response> {
    const payload = await this.buildAgentPayload(userId, username, body);
    return await this.agentClient.openChatStream(payload);
  }

  async listSessions(userId: number, limit = 50): Promise<Record<string, unknown>> {
    return await this.agentClient.listChatSessions(userId, limit);
  }

  async getSession(userId: number, sessionId: string): Promise<Record<string, unknown>> {
    return await this.agentClient.getChatSession(userId, sessionId);
  }

  async deleteSession(userId: number, sessionId: string): Promise<Record<string, unknown>> {
    return await this.agentClient.deleteChatSession(userId, sessionId);
  }

  async getRuntimeContextForAgent(ownerUserId: number, refresh = true): Promise<Record<string, unknown>> {
    const simulationAccount = await this.brokerAccountsService.getMySimulationAccountStatus(ownerUserId);
    let runtimeContext: Record<string, unknown> | null = null;
    if (simulationAccount.is_bound && simulationAccount.is_verified) {
      try {
        runtimeContext = await this.tradingAccountService.getRuntimeContext(ownerUserId, refresh) as unknown as Record<string, unknown>;
      } catch {
        runtimeContext = null;
      }
    }
    return {
      simulation_account: simulationAccount,
      runtime_context: runtimeContext,
    };
  }

  async getAnalysisHistoryForAgent(
    ownerUserId: number,
    stockCodes: string[] = [],
    limit = 5,
  ): Promise<Record<string, unknown>> {
    const normalizedCodes = stockCodes.map(code => code.trim()).filter(Boolean);
    const completedWhere: Prisma.AnalysisHistoryWhereInput = {
      ...this.buildOwnerWhere(ownerUserId),
      ...(normalizedCodes.length > 0 ? { code: { in: normalizedCodes } } : {}),
    };
    const failedWhere: Prisma.AnalysisTaskWhereInput = {
      ...this.buildOwnerWhere(ownerUserId),
      status: 'failed',
      ...(normalizedCodes.length > 0 ? { stockCode: { in: normalizedCodes } } : {}),
    };

    const [completedRows, failedRows] = await Promise.all([
      this.prisma.analysisHistory.findMany({
        where: completedWhere,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.analysisTask.findMany({
        where: failedWhere,
        orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
        take: limit,
      }),
    ]);

    const items = [
      ...completedRows.map(row => ({
        query_id: row.queryId,
        stock_code: row.code,
        stock_name: row.name,
        operation_advice: row.operationAdvice,
        sentiment_score: row.sentimentScore,
        status: 'completed',
        created_at: row.createdAt.toISOString(),
      })),
      ...failedRows.map(row => ({
        query_id: row.resultQueryId ?? row.taskId,
        stock_code: row.stockCode,
        stock_name: null,
        operation_advice: null,
        sentiment_score: null,
        status: 'failed',
        created_at: (row.completedAt ?? row.createdAt).toISOString(),
        error_message: row.error ?? row.message,
      })),
    ]
      .sort((left, right) => new Date(String(right.created_at)).getTime() - new Date(String(left.created_at)).getTime())
      .slice(0, limit);

    return {
      total: items.length,
      items,
    };
  }

  async getBacktestSummaryForAgent(
    ownerUserId: number,
    stockCodes: string[] = [],
    limit = 6,
  ): Promise<Record<string, unknown>> {
    const normalizedCodes = stockCodes.map(code => code.trim()).filter(Boolean);
    const strategyWhere: Prisma.StrategyBacktestRunGroupWhereInput = {
      ...this.buildOwnerWhere(ownerUserId),
      ...(normalizedCodes.length > 0 ? { code: { in: normalizedCodes } } : {}),
    };
    const agentWhere: Prisma.AgentBacktestRunGroupWhereInput = {
      ...this.buildOwnerWhere(ownerUserId),
      ...(normalizedCodes.length > 0 ? { code: { in: normalizedCodes } } : {}),
    };

    const [strategyGroups, agentGroups] = await Promise.all([
      this.prisma.strategyBacktestRunGroup.findMany({
        where: strategyWhere,
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          runs: {
            orderBy: { id: 'asc' },
            take: 3,
          },
        },
      }),
      this.prisma.agentBacktestRunGroup.findMany({
        where: agentWhere,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ]);

    const items = [
      ...strategyGroups.map((group) => {
        const firstRun = group.runs[0];
        const metrics = asRecord(firstRun?.metricsJson);
        const totalReturn = asNumber(metrics.total_return_pct);
        const winRate = asNumber(metrics.win_rate_pct);
        return {
          kind: 'strategy',
          code: group.code,
          created_at: group.createdAt.toISOString(),
          summary: `策略回测 ${group.code}${totalReturn != null ? ` 总收益 ${totalReturn}%` : ''}${winRate != null ? `，胜率 ${winRate}%` : ''}`,
          metrics,
        };
      }),
      ...agentGroups.map((group) => {
        const summary = asRecord(group.summaryJson);
        const totalReturn = asNumber(summary.total_return_pct);
        const winRate = asNumber(summary.win_rate_pct);
        return {
          kind: 'agent',
          code: group.code,
          created_at: group.createdAt.toISOString(),
          summary: `Agent 回放 ${group.code}${totalReturn != null ? ` 总收益 ${totalReturn}%` : ''}${winRate != null ? `，胜率 ${winRate}%` : ''}`,
          metrics: summary,
        };
      }),
    ]
      .sort((left, right) => new Date(String(right.created_at)).getTime() - new Date(String(left.created_at)).getTime())
      .slice(0, limit);

    return {
      total: items.length,
      items,
    };
  }

  private normalizeOrderStatus(payload: Record<string, unknown>): string {
    const order = asRecord(payload.order);
    const status = asString(order.provider_status ?? order.status ?? payload.status).toLowerCase();
    if (status === 'filled') {
      return 'filled';
    }
    if (status === 'partial_filled') {
      return 'partial_filled';
    }
    if (status) {
      return 'submitted';
    }
    return 'submitted';
  }

  private async writeExecutionAudit(input: {
    ownerUserId: number;
    brokerAccountId: number;
    taskId: string;
    status: string;
    payload: Record<string, unknown>;
    errorCode?: string | null;
  }): Promise<void> {
    await this.prisma.agentExecutionEvent.create({
      data: {
        userId: input.ownerUserId,
        brokerAccountId: input.brokerAccountId,
        taskId: input.taskId,
        eventType: 'place_simulated_order',
        payloadJson: safeJsonStringify(input.payload),
        status: input.status,
        errorCode: input.errorCode ?? null,
      },
    });
  }

  async placeSimulatedOrderForAgent(
    ownerUserId: number,
    sessionId: string,
    candidateOrder: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const code = asString(candidateOrder.code);
    const stockName = asString(candidateOrder.stock_name);
    const direction = asString(candidateOrder.action).toLowerCase();
    const quantity = Math.floor(asNumber(candidateOrder.quantity) ?? 0);
    const price = Number((asNumber(candidateOrder.price) ?? 0).toFixed(4));

    if (!code) {
      throw createServiceError('VALIDATION_ERROR', 'candidate_order.code 不能为空');
    }
    if (direction !== 'buy' && direction !== 'sell') {
      throw createServiceError('VALIDATION_ERROR', 'candidate_order.action 必须是 buy 或 sell');
    }
    if (quantity <= 0) {
      throw createServiceError('VALIDATION_ERROR', 'candidate_order.quantity 必须大于 0');
    }
    if (price <= 0) {
      throw createServiceError('VALIDATION_ERROR', 'candidate_order.price 必须大于 0');
    }

    const simulationAccount = await this.brokerAccountsService.getMySimulationAccountStatus(ownerUserId);
    const brokerAccountId = Number(simulationAccount.broker_account_id ?? 0);
    if (brokerAccountId <= 0) {
      throw createServiceError('SIMULATION_ACCOUNT_REQUIRED', '请先初始化并校验模拟盘账户');
    }

    try {
      const payload = await this.tradingAccountService.placeOrder(ownerUserId, {
        stock_code: code,
        stock_name: stockName || undefined,
        direction: direction as 'buy' | 'sell',
        type: 'market',
        price,
        quantity,
        idempotency_key: `agent-chat:${sessionId}:${code}:${direction}:${quantity}`,
        source_task_id: sessionId,
        payload: {
          source: 'agent_chat',
          candidate_order: candidateOrder,
        },
      });
      const status = this.normalizeOrderStatus(payload);
      await this.writeExecutionAudit({
        ownerUserId,
        brokerAccountId,
        taskId: sessionId,
        status,
        payload,
      });
      return {
        status,
        candidate_order: candidateOrder,
        ...payload,
      };
    } catch (error: unknown) {
      const err = error as ServiceError;
      await this.writeExecutionAudit({
        ownerUserId,
        brokerAccountId,
        taskId: sessionId,
        status: 'failed',
        payload: {
          candidate_order: candidateOrder,
          message: err.message,
        },
        errorCode: err.code ?? 'ORDER_FAILED',
      });
      throw error;
    }
  }
}
