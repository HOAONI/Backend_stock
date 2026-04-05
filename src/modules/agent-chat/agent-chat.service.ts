/** Agent 问股模块服务。 */

import { Injectable } from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { AgentClientService } from '@/common/agent/agent-client.service';
import { AgentRuntimeConfig } from '@/common/agent/agent.types';
import { PrismaService } from '@/common/database/prisma.service';
import { safeJsonStringify } from '@/common/utils/json';
import { evaluateTradingSessionGuardFromEnv, TradingSessionGuardResult } from '@/common/utils/trading-session';
import { AnalysisService } from '@/modules/analysis/analysis.service';
import { BrokerAccountsService } from '@/modules/broker-accounts/broker-accounts.service';
import { TradingAccountService } from '@/modules/trading-account/trading-account.service';
import { normalizeAgentChatPreferences } from '@/modules/user-settings/agent-chat-preferences';
import {
  normalizeAnalysisStrategy,
  normalizeMaxSingleTradeAmount,
  normalizeRiskProfile,
} from '@/modules/user-settings/agent-user-preferences';

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

function asArrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>>;
}

function pickDefined<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value != null) {
      return value;
    }
  }
  return null;
}

function normalizeTrendPrediction(value: unknown): string {
  const raw = asString(value);
  const normalized = raw.toUpperCase();
  if (normalized === 'BUY') {
    return '看多';
  }
  if (normalized === 'HOLD') {
    return '中性';
  }
  if (normalized === 'SELL') {
    return '看空';
  }
  return raw;
}

function buildAgentChatQueryId(sessionId: string, assistantMessageId: number, stockCode: string): string {
  return `agc_${sessionId}_${assistantMessageId}_${stockCode}`;
}

function toSessionGuardPayload(snapshot: TradingSessionGuardResult): Record<string, unknown> {
  return {
    timezone: snapshot.timezone,
    sessions: snapshot.sessions,
    evaluated_at: snapshot.evaluatedAt,
    next_open_at: snapshot.nextOpenAt,
  };
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
    const [runtime, simulationAccount, profile] = await Promise.all([
      this.analysisService.buildRuntimeContext(userId, { includeApiToken: true }),
      this.brokerAccountsService.getMySimulationAccountStatus(userId),
      this.prisma.adminUserProfile.findUnique({
        where: { userId },
      } as any),
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
      agent_chat_preferences: normalizeAgentChatPreferences((profile as Record<string, unknown> | null)?.agentChatPreferencesJson),
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

  async getAccountStateForAgent(ownerUserId: number, refresh = true): Promise<Record<string, unknown>> {
    const simulationAccount = await this.brokerAccountsService.getMySimulationAccountStatus(ownerUserId);
    let runtimeContext: Record<string, unknown> | null = null;
    let accountState: Record<string, unknown> | null = null;

    if (simulationAccount.is_bound && simulationAccount.is_verified) {
      try {
        const [runtime, account] = await Promise.all([
          this.tradingAccountService.getRuntimeContext(ownerUserId, refresh),
          this.tradingAccountService.getAccountState(ownerUserId, refresh),
        ]);
        runtimeContext = runtime as unknown as Record<string, unknown>;
        accountState = account as unknown as Record<string, unknown>;
      } catch {
        runtimeContext = null;
        accountState = null;
      }
    }

    return {
      simulation_account: simulationAccount,
      account_state: accountState,
      runtime_context: runtimeContext,
    };
  }

  async getUserPreferencesForAgent(
    ownerUserId: number,
    sessionOverrides?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const profile = await this.prisma.adminUserProfile.findUnique({
      where: { userId: ownerUserId },
    } as any);
    const source = asRecord(profile as Record<string, unknown> | null);
    const sessionSource = asRecord(sessionOverrides);
    const persistentTrading = {
      riskProfile: normalizeRiskProfile(source.strategyRiskProfile),
      analysisStrategy: normalizeAnalysisStrategy(source.strategyAnalysisStrategy),
      maxSingleTradeAmount: normalizeMaxSingleTradeAmount(source.strategyMaxSingleTradeAmount),
      positionMaxPct: asNumber(source.strategyPositionMaxPct) ?? 30,
      stopLossPct: asNumber(source.strategyStopLossPct) ?? 8,
      takeProfitPct: asNumber(source.strategyTakeProfitPct) ?? 15,
    };
    const persistentChat = normalizeAgentChatPreferences(source.agentChatPreferencesJson);
    const effectiveTrading = {
      riskProfile: normalizeRiskProfile(sessionSource.riskProfile ?? sessionSource.risk_profile ?? persistentTrading.riskProfile),
      analysisStrategy: normalizeAnalysisStrategy(
        sessionSource.analysisStrategy ?? sessionSource.analysis_strategy ?? persistentTrading.analysisStrategy,
      ),
      maxSingleTradeAmount: normalizeMaxSingleTradeAmount(
        pickDefined(
          sessionSource.maxSingleTradeAmount,
          sessionSource.max_single_trade_amount,
          persistentTrading.maxSingleTradeAmount,
        ),
      ),
      positionMaxPct: asNumber(
        pickDefined(sessionSource.positionMaxPct, sessionSource.position_max_pct, persistentTrading.positionMaxPct),
      ) ?? persistentTrading.positionMaxPct,
      stopLossPct: asNumber(
        pickDefined(sessionSource.stopLossPct, sessionSource.stop_loss_pct, persistentTrading.stopLossPct),
      ) ?? persistentTrading.stopLossPct,
      takeProfitPct: asNumber(
        pickDefined(sessionSource.takeProfitPct, sessionSource.take_profit_pct, persistentTrading.takeProfitPct),
      ) ?? persistentTrading.takeProfitPct,
    };
    const effectiveChat = normalizeAgentChatPreferences({
      ...persistentChat,
      ...sessionSource,
    });

    return {
      persistent: {
        trading: persistentTrading,
        chat: persistentChat,
      },
      session_overrides: sessionSource,
      effective: {
        trading: effectiveTrading,
        chat: effectiveChat,
      },
      source: {
        trading: {
          riskProfile: sessionSource.riskProfile != null || sessionSource.risk_profile != null ? 'session' : 'profile',
          analysisStrategy: sessionSource.analysisStrategy != null || sessionSource.analysis_strategy != null ? 'session' : 'profile',
          maxSingleTradeAmount: sessionSource.maxSingleTradeAmount != null || sessionSource.max_single_trade_amount != null ? 'session' : 'profile',
          positionMaxPct: sessionSource.positionMaxPct != null || sessionSource.position_max_pct != null ? 'session' : 'profile',
          stopLossPct: sessionSource.stopLossPct != null || sessionSource.stop_loss_pct != null ? 'session' : 'profile',
          takeProfitPct: sessionSource.takeProfitPct != null || sessionSource.take_profit_pct != null ? 'session' : 'profile',
        },
        chat: {
          executionPolicy: sessionSource.executionPolicy != null ? 'session' : 'profile',
          confirmationShortcutsEnabled: sessionSource.confirmationShortcutsEnabled != null ? 'session' : 'profile',
          followupFocusResolutionEnabled: sessionSource.followupFocusResolutionEnabled != null ? 'session' : 'profile',
          responseStyle: sessionSource.responseStyle != null ? 'session' : 'profile',
        },
      },
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

  private unwrapAgentAnalysisResult(analysisResult: Record<string, unknown>): Record<string, unknown> {
    if (Array.isArray(analysisResult.stocks)) {
      return analysisResult;
    }

    const nestedAnalysis = asRecord(analysisResult.analysis);
    if (Array.isArray(nestedAnalysis.stocks)) {
      return nestedAnalysis;
    }

    const nestedStructured = asRecord(analysisResult.structured_result);
    if (Array.isArray(nestedStructured.stocks)) {
      return nestedStructured;
    }

    return analysisResult;
  }

  private buildAgentAnalysisRawResult(
    analysisResult: Record<string, unknown>,
    stock: Record<string, unknown>,
  ): Record<string, unknown> {
    const code = asString(stock.code);
    const raw = asRecord(stock.raw);
    const dataSnapshot = asRecord(raw.data);
    const signalSnapshot = asRecord(raw.signal);
    const riskSnapshot = asRecord(raw.risk);
    const executionSnapshot = asRecord(raw.execution);

    return {
      agent_run: {
        run_id: asString(analysisResult.run_id),
        trade_date: asString(analysisResult.trade_date),
        data_snapshot: code ? { [code]: dataSnapshot } : {},
        signal_snapshot: code ? { [code]: signalSnapshot } : {},
        risk_snapshot: code ? { [code]: riskSnapshot } : {},
        execution_snapshot: code ? { [code]: executionSnapshot } : {},
      },
      data_snapshot: dataSnapshot,
      signal_snapshot: signalSnapshot,
      risk_snapshot: riskSnapshot,
      execution_snapshot: executionSnapshot,
    };
  }

  private buildAgentAnalysisContextSnapshot(input: {
    analysisResult: Record<string, unknown>;
    stock: Record<string, unknown>;
    sessionId: string;
    assistantMessageId: number;
  }): Record<string, unknown> {
    const raw = asRecord(input.stock.raw);
    const dataSnapshot = asRecord(raw.data);
    const portfolioSummary = asRecord(input.analysisResult.portfolio_summary);

    return {
      enhanced_context: asRecord(dataSnapshot.analysis_context),
      realtime_quote_raw: asRecord(dataSnapshot.realtime_quote),
      agent_chat: {
        source: 'agent_chat',
        session_id: input.sessionId,
        assistant_message_id: input.assistantMessageId,
        run_id: asString(input.analysisResult.run_id),
        trade_date: asString(input.analysisResult.trade_date),
        stock_code: asString(input.stock.code),
        candidate_order_count: asNumber(portfolioSummary.candidate_order_count) ?? 0,
        has_candidate_order: Boolean(asRecord(input.stock.candidate_order).code),
      },
    };
  }

  async saveAnalysisHistoryFromAgent(
    ownerUserId: number,
    sessionId: string,
    assistantMessageId: number,
    analysisResultInput: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const normalizedSessionId = asString(sessionId);
    if (!normalizedSessionId) {
      throw createServiceError('VALIDATION_ERROR', 'session_id 不能为空');
    }
    if (!Number.isInteger(assistantMessageId) || assistantMessageId <= 0) {
      throw createServiceError('VALIDATION_ERROR', 'assistant_message_id 必须是正整数');
    }

    const analysisResult = this.unwrapAgentAnalysisResult(asRecord(analysisResultInput));
    const stocks = asArrayOfRecords(analysisResult.stocks);
    if (stocks.length === 0) {
      return {
        saved_count: 0,
        skipped_count: 0,
        items: [],
      };
    }

    const items: Array<Record<string, unknown>> = [];
    let savedCount = 0;
    let skippedCount = 0;

    for (const stock of stocks) {
      const stockCode = asString(stock.code);
      if (!stockCode) {
        skippedCount += 1;
        items.push({
          stock_code: '',
          status: 'skipped_invalid',
          reason: 'missing_stock_code',
        });
        continue;
      }

      const queryId = buildAgentChatQueryId(normalizedSessionId, assistantMessageId, stockCode);
      const existing = await this.prisma.analysisHistory.findFirst({
        where: {
          ownerUserId,
          queryId,
        },
      });
      if (existing) {
        skippedCount += 1;
        items.push({
          query_id: queryId,
          stock_code: stockCode,
          status: 'skipped_existing',
        });
        continue;
      }

      const name = asString(stock.name, stockCode);
      const raw = asRecord(stock.raw);
      const signalSnapshot = asRecord(raw.signal);
      const riskSnapshot = asRecord(raw.risk);
      const aiPayload = asRecord(signalSnapshot.ai_payload);
      const sniperPoints = asRecord(aiPayload.sniper_points);
      const operationAdvice = asString(stock.operation_advice || signalSnapshot.operation_advice, '观望');
      const sentimentScore = Math.round(asNumber(stock.sentiment_score ?? signalSnapshot.sentiment_score) ?? 50);
      const trendPrediction = normalizeTrendPrediction(
        stock.trend_signal ?? signalSnapshot.trend_signal ?? aiPayload.trend_prediction,
      );
      const analysisSummary = asString(
        aiPayload.analysis_summary ?? aiPayload.summary,
        `${name} 当前建议为 ${operationAdvice}`,
      );
      const idealBuy = asNumber(sniperPoints.ideal_buy);
      const secondaryBuy = asNumber(sniperPoints.secondary_buy);
      const stopLoss = asNumber(
        pickDefined(
          riskSnapshot.effective_stop_loss,
          riskSnapshot.stop_loss,
          stock.stop_loss,
          signalSnapshot.stop_loss,
          sniperPoints.stop_loss,
        ),
      );
      const takeProfit = asNumber(
        pickDefined(
          riskSnapshot.effective_take_profit,
          riskSnapshot.take_profit,
          stock.take_profit,
          signalSnapshot.take_profit,
          sniperPoints.take_profit,
        ),
      );

      await this.prisma.analysisHistory.create({
        data: {
          ownerUserId,
          queryId,
          code: stockCode,
          name,
          recordSource: 'agent_chat' as any,
          reportType: 'detailed',
          sentimentScore,
          operationAdvice,
          trendPrediction: trendPrediction || null,
          analysisSummary,
          rawResult: safeJsonStringify(this.buildAgentAnalysisRawResult(analysisResult, stock)),
          newsContent: null,
          contextSnapshot: safeJsonStringify(this.buildAgentAnalysisContextSnapshot({
            analysisResult,
            stock,
            sessionId: normalizedSessionId,
            assistantMessageId,
          })),
          idealBuy,
          secondaryBuy,
          stopLoss,
          takeProfit,
        },
      });

      savedCount += 1;
      items.push({
        query_id: queryId,
        stock_code: stockCode,
        stock_name: name,
        status: 'saved',
      });
    }

    return {
      saved_count: savedCount,
      skipped_count: skippedCount,
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
    if (status === 'blocked') {
      return 'blocked';
    }
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

    const sessionGuard = evaluateTradingSessionGuardFromEnv();
    if (!sessionGuard.allowed) {
      const blockedPayload = {
        status: 'blocked',
        reason: 'outside_trading_session',
        message: sessionGuard.message,
        candidate_order: candidateOrder,
        session_guard: toSessionGuardPayload(sessionGuard),
      };
      await this.writeExecutionAudit({
        ownerUserId,
        brokerAccountId,
        taskId: sessionId,
        status: 'blocked',
        payload: blockedPayload,
      });
      return blockedPayload;
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
