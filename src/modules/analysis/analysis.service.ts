/** 股票分析模块的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AnalysisTaskStatus, Prisma } from '@prisma/client';

import { AgentExecutionMode, AgentRuntimeConfig, AgentRuntimeContext } from '@/common/agent/agent.types';
import { AgentRunBridgeService } from '@/common/agent/agent-run-bridge.service';
import { buildRuntimeConfigFromProfile, maskRuntimeConfig } from '@/common/agent/runtime-config.builder';
import { AiRuntimeService } from '@/common/ai/ai-runtime.service';
import { PrismaService } from '@/common/database/prisma.service';
import { safeJsonParse } from '@/common/utils/json';
import { canonicalStockCode } from '@/common/utils/stock-code';
import { BrokerAccountsService } from '@/modules/broker-accounts/broker-accounts.service';
import { TradingAccountService, TradingRuntimeContextPayload } from '@/modules/trading-account/trading-account.service';

import { AnalyzeRequestDto } from './analysis.dto';
import { mapAgentRunToAnalysis } from './analysis.mapper';

export interface RequesterScope {
  userId: number;
  includeAll: boolean;
}

type StageCode = 'data' | 'signal' | 'risk' | 'execution';
type StageStatus = 'pending' | 'done' | 'failed';

interface StageItem {
  code: StageCode;
  status: StageStatus;
  summary: string;
  duration_ms: number | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error_message: string | null;
}

interface RuntimeContext {
  runtimeConfig: AgentRuntimeConfig;
  maskedRuntimeConfig: AgentRuntimeConfig;
  accountName: string;
  llmSource: 'system' | 'personal';
  effectiveLlm: {
    provider: string;
    baseUrl: string;
    model: string;
    forwardRuntimeLlm: boolean;
  };
}

export interface AnalysisBrokerMeta {
  execution_mode: AgentExecutionMode;
  requested_execution_mode: RequestedExecutionMode;
  broker_account_id: number | null;
  auto_order_enabled: boolean;
  broker_plan_reason: string;
}

type RequestedExecutionMode = 'auto' | 'paper';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asPositiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }
  return n;
}

function asNumber(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return null;
  }
  return n;
}

function asExecutionMode(value: unknown): AgentExecutionMode {
  return String(value ?? '').trim().toLowerCase() === 'broker' ? 'broker' : 'paper';
}

function stageTitle(code: StageCode): string {
  if (code === 'data') return '数据获取 Agent';
  if (code === 'signal') return '信号策略 Agent';
  if (code === 'risk') return '风险控制 Agent';
  return '执行 Agent';
}

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class AnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRunBridge: AgentRunBridgeService,
    private readonly aiRuntimeService: AiRuntimeService,
    private readonly brokerAccountsService: BrokerAccountsService,
    private readonly tradingAccountService: TradingAccountService,
  ) {}

  // v1 只支持单股票分析，这里统一把 stock_code / stock_codes 收敛成同一份标准输入。
  normalizeRequest(request: AnalyzeRequestDto): {
    stockCode: string;
    reportType: string;
    forceRefresh: boolean;
    executionMode: RequestedExecutionMode;
  } {
    const codes = [
      ...(request.stock_code ? [request.stock_code] : []),
      ...(request.stock_codes ?? []),
    ]
      .map((x) => canonicalStockCode(x))
      .filter(Boolean);

    const dedup = [...new Set(codes)];
    if (dedup.length === 0) {
      const error = new Error('必须提供 stock_code 或 stock_codes 参数');
      (error as Error & { code: string }).code = 'VALIDATION_ERROR';
      throw error;
    }
    if (dedup.length > 1) {
      const error = new Error('当前接口仅支持单股票分析，请仅传入一个 stock_code');
      (error as Error & { code: string }).code = 'VALIDATION_ERROR';
      throw error;
    }

    return {
      stockCode: dedup[0],
      reportType: request.report_type ?? 'detailed',
      forceRefresh: Boolean(request.force_refresh),
      executionMode: request.execution_mode ?? 'auto',
    };
  }

  private isAutoOrderEnabled(): boolean {
    return (process.env.ANALYSIS_AUTO_ORDER_ENABLED ?? 'true').toLowerCase() === 'true';
  }

  // 每次执行前都按“当前用户画像 + 当前可用 AI 配置”重建 runtime，避免旧任务沿用过期配置。
  async buildRuntimeContext(userId: number, options?: { includeApiToken?: boolean }): Promise<RuntimeContext> {
    const [profile, user] = await this.prisma.$transaction([
      this.prisma.adminUserProfile.findUnique({ where: { userId } }),
      this.prisma.adminUser.findUnique({
        where: { id: userId },
        select: { username: true },
      }),
    ]);

    const resolvedLlm = await this.aiRuntimeService.resolveEffectiveLlmFromProfile(profile, {
      includeApiToken: options?.includeApiToken ?? true,
      requireSystemDefault: true,
    });
    const runtimeConfig = buildRuntimeConfigFromProfile(profile, user?.username ?? `u${userId}`, {
      llm: resolvedLlm.forwardRuntimeLlm
        ? {
            provider: resolvedLlm.effective.provider,
            baseUrl: resolvedLlm.effective.baseUrl,
            model: resolvedLlm.effective.model,
            hasToken: resolvedLlm.source === 'personal' ? resolvedLlm.hasPersonalToken : resolvedLlm.hasSystemToken,
            apiToken: resolvedLlm.apiToken,
          }
        : null,
    });
    return {
      runtimeConfig,
      maskedRuntimeConfig: maskRuntimeConfig(runtimeConfig),
      accountName: runtimeConfig.account.account_name,
      llmSource: resolvedLlm.source,
      effectiveLlm: {
        provider: resolvedLlm.effective.provider,
        baseUrl: resolvedLlm.effective.baseUrl,
        model: resolvedLlm.effective.model,
        forwardRuntimeLlm: resolvedLlm.forwardRuntimeLlm,
      },
    };
  }

  private buildOwnerFilter(scope: RequesterScope): { ownerUserId?: number } {
    if (scope.includeAll) {
      return {};
    }
    return { ownerUserId: scope.userId };
  }

  private parseRequestedExecutionMode(value: unknown): RequestedExecutionMode {
    const raw = String(value ?? '').trim().toLowerCase();
    if (raw === 'paper') {
      return raw;
    }
    return 'auto';
  }

  private cloneRuntimeConfig(runtimeConfig: AgentRuntimeConfig): AgentRuntimeConfig {
    return {
      account: { ...runtimeConfig.account },
      ...(runtimeConfig.llm ? { llm: { ...runtimeConfig.llm } } : {}),
      strategy: { ...runtimeConfig.strategy },
      execution: runtimeConfig.execution ? { ...runtimeConfig.execution } : undefined,
      context: runtimeConfig.context
        ? {
            account_snapshot: runtimeConfig.context.account_snapshot ? { ...runtimeConfig.context.account_snapshot } : undefined,
            summary: runtimeConfig.context.summary ? { ...runtimeConfig.context.summary } : undefined,
            positions: runtimeConfig.context.positions?.map((item) => ({ ...item })),
          }
        : undefined,
    };
  }

  private buildAgentRuntimeContext(payload: TradingRuntimeContextPayload): AgentRuntimeContext {
    const summary = asRecord(payload.summary) ?? {};
    const positions = Array.isArray(payload.positions) ? payload.positions.map((item) => ({ ...item })) : [];
    const cash = asNumber(summary.cash ?? summary.available_cash ?? summary.availableCash) ?? 0;
    const marketValue = asNumber(summary.market_value ?? summary.total_market_value ?? summary.marketValue) ?? 0;
    const totalAsset = asNumber(summary.total_asset ?? summary.totalAsset ?? summary.total_equity) ?? (cash + marketValue);

    return {
      summary,
      positions,
      account_snapshot: {
        broker_account_id: payload.broker_account_id,
        broker_code: payload.broker_code,
        provider_code: payload.provider_code,
        provider_name: payload.provider_name,
        account_uid: payload.account_uid,
        account_display_name: payload.account_display_name,
        snapshot_at: payload.snapshot_at,
        data_source: payload.data_source,
        cash,
        total_market_value: marketValue,
        total_asset: totalAsset,
        positions,
      },
    };
  }

  private async attachTradingRuntimeContext(userId: number, runtimeConfig: AgentRuntimeConfig): Promise<AgentRuntimeConfig> {
    const tradingRuntime = await this.tradingAccountService.getRuntimeContext(userId, true);
    return {
      ...runtimeConfig,
      context: this.buildAgentRuntimeContext(tradingRuntime),
    };
  }

  // 把前端请求的 auto/paper 翻译成 Agent 真正要执行的 broker/paper，并附带降级原因。
  async resolveExecutionPlan(
    userId: number,
    requestedModeInput?: string | null,
  ): Promise<AnalysisBrokerMeta> {
    const requestedMode = this.parseRequestedExecutionMode(requestedModeInput);
    const autoOrderEnabled = requestedMode === 'auto' && this.isAutoOrderEnabled();
    const access = requestedMode === 'auto' && autoOrderEnabled
      ? await this.brokerAccountsService.resolveSimulationAccess(userId, { requireVerified: true })
      : null;

    return {
      execution_mode: requestedMode === 'auto' && autoOrderEnabled ? 'broker' : 'paper',
      requested_execution_mode: requestedMode,
      broker_account_id: access?.brokerAccountId ?? null,
      auto_order_enabled: autoOrderEnabled,
      broker_plan_reason: requestedMode === 'paper'
        ? 'paper_analysis_only'
        : autoOrderEnabled
          ? 'agent_execute_backtrader_local'
          : 'auto_order_disabled',
    };
  }

  // 旧任务 payload 里可能缺字段或仍沿用旧命名，这里负责兼容回读并补上保守默认值。
  resolveExecutionMetaFromPayload(requestPayload: unknown): AnalysisBrokerMeta {
    const payload = asRecord(requestPayload);
    const meta = asRecord(payload?.meta);
    const executionMode = asExecutionMode(meta?.execution_mode);
    const requestedMode = this.parseRequestedExecutionMode(meta?.requested_execution_mode ?? meta?.execution_mode ?? 'auto');
    const brokerAccountId = asPositiveInt(meta?.broker_account_id);
    const autoOrderEnabled = Boolean(meta?.auto_order_enabled ?? (requestedMode === 'auto' ? this.isAutoOrderEnabled() : false));
    const reason = String(meta?.broker_plan_reason ?? '').trim() || 'legacy_default';

    return {
      execution_mode: executionMode,
      requested_execution_mode: requestedMode,
      broker_account_id: brokerAccountId,
      auto_order_enabled: autoOrderEnabled,
      broker_plan_reason: reason,
    };
  }

  // 真正发给 Agent 的 execution 字段统一在这里组装，避免同步/异步两条链路各自拼装出差异。
  buildRuntimeConfigForExecution(
    runtimeConfig: AgentRuntimeConfig,
    executionMeta: Pick<AnalysisBrokerMeta, 'execution_mode' | 'broker_account_id'>,
  ): AgentRuntimeConfig {
    const cloned = this.cloneRuntimeConfig(runtimeConfig);
    const brokerAccountId = asPositiveInt(executionMeta.broker_account_id);

    cloned.execution = {
      mode: executionMeta.execution_mode,
      has_ticket: false,
      ...(brokerAccountId ? { broker_account_id: brokerAccountId } : {}),
    };

    return cloned;
  }

  // 同步分析也复用 Agent async bridge，避免同步/异步两条链路出现结果映射差异。
  async runSync(input: {
    stockCode: string;
    reportType: string;
    userId: number;
    executionMode?: RequestedExecutionMode;
  }): Promise<Record<string, unknown>> {
    const runtime = await this.buildRuntimeContext(input.userId, {
      includeApiToken: true,
    });
    const executionMeta = await this.resolveExecutionPlan(input.userId, input.executionMode);
    const runRequestId = randomUUID().replace(/-/g, '');

    const runtimeConfigBase = this.buildRuntimeConfigForExecution(runtime.runtimeConfig, executionMeta);
    const runtimeConfig = executionMeta.execution_mode === 'broker' && executionMeta.broker_account_id
      ? await this.attachTradingRuntimeContext(input.userId, runtimeConfigBase)
      : runtimeConfigBase;

    const bridgeResult = await this.agentRunBridge.runViaAsyncTask([input.stockCode], runRequestId, {
      accountName: runtime.accountName,
      runtimeConfig,
      forceRuntimeConfig: true,
    }
    );
    const mapped = mapAgentRunToAnalysis(bridgeResult.run, input.stockCode, input.reportType);

    await this.prisma.analysisHistory.create({
      data: {
        ownerUserId: input.userId,
        queryId: mapped.historyRecord.queryId,
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

    return {
      query_id: mapped.queryId,
      stock_code: mapped.stockCode,
      stock_name: mapped.stockName,
      report: mapped.report,
      created_at: new Date().toISOString(),
    };
  }

  // 入队时只保存脱敏 runtime_config，真正执行时由 worker 按 owner_user_id 回源完整敏感配置。
  async submitAsync(input: {
    stockCode: string;
    reportType: string;
    forceRefresh: boolean;
    userId: number;
    executionMode?: RequestedExecutionMode;
  }): Promise<Record<string, unknown>> {
    const runtime = await this.buildRuntimeContext(input.userId, {
      includeApiToken: true,
    });
    const executionMeta = await this.resolveExecutionPlan(input.userId, input.executionMode);
    const maskedRuntime = maskRuntimeConfig(this.buildRuntimeConfigForExecution(runtime.runtimeConfig, executionMeta));
    const existing = await this.prisma.analysisTask.findFirst({
      where: {
        ownerUserId: input.userId,
        stockCode: input.stockCode,
        status: {
          in: [AnalysisTaskStatus.pending, AnalysisTaskStatus.processing],
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (existing) {
      const error = new Error(`股票 ${input.stockCode} 正在分析中`);
      (error as Error & { code: string; stockCode: string; existingTaskId: string }).code = 'DUPLICATE_TASK';
      (error as Error & { code: string; stockCode: string; existingTaskId: string }).stockCode = input.stockCode;
      (error as Error & { code: string; stockCode: string; existingTaskId: string }).existingTaskId = existing.taskId;
      throw error;
    }

    const taskId = randomUUID().replace(/-/g, '');
    const requestPayload: Prisma.InputJsonValue = {
      stock_code: input.stockCode,
      report_type: input.reportType,
      force_refresh: input.forceRefresh,
      async_mode: true,
      runtime_config: maskedRuntime as unknown as Prisma.InputJsonValue,
      meta: executionMeta as unknown as Prisma.InputJsonValue,
    };
    await this.prisma.analysisTask.create({
      data: {
        ownerUserId: input.userId,
        taskId,
        rootTaskId: taskId,
        retryOfTaskId: null,
        attemptNo: 1,
        priority: 100,
        stockCode: input.stockCode,
        reportType: input.reportType,
        status: AnalysisTaskStatus.pending,
        progress: 0,
        message: '任务已加入队列',
        requestPayload,
      },
    });

    return {
      task_id: taskId,
      status: 'pending',
      message: `分析任务已加入队列: ${input.stockCode}`,
    };
  }

  async getTaskList(statusFilter: string | null, limit: number, scope: RequesterScope): Promise<Record<string, unknown>> {
    const statuses = statusFilter
      ? statusFilter
          .split(',')
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean)
      : [];
    const validStatuses = statuses.filter((item): item is AnalysisTaskStatus =>
      Object.values(AnalysisTaskStatus).includes(item as AnalysisTaskStatus),
    );
    const ownerFilter = this.buildOwnerFilter(scope);

    const rows = await this.prisma.analysisTask.findMany({
      where: {
        ...ownerFilter,
        ...(validStatuses.length > 0
          ? {
              status: {
                in: validStatuses,
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const counts = await this.prisma.analysisTask.groupBy({
      by: ['status'],
      where: ownerFilter,
      _count: true,
    });

    const stats = {
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const count of counts) {
      const c = Number(count._count ?? 0);
      stats.total += c;
      if (count.status in stats) {
        (stats as Record<string, number>)[count.status] = c;
      }
    }

    const tasks = rows.map((row) => ({
      task_id: row.taskId,
      stock_code: row.stockCode,
      stock_name: null,
      status: row.status,
      progress: row.progress,
      message: row.message,
      report_type: row.reportType,
      created_at: row.createdAt.toISOString(),
      started_at: row.startedAt?.toISOString() ?? null,
      completed_at: row.completedAt?.toISOString() ?? null,
      error: row.error,
      owner_user_id: row.ownerUserId ?? null,
    }));

    return {
      total: stats.total,
      pending: stats.pending,
      processing: stats.processing,
      completed: stats.completed,
      failed: stats.failed,
      cancelled: stats.cancelled,
      tasks,
    };
  }

  private extractRawResultFromTaskPayload(resultPayload: Prisma.JsonValue | null): unknown {
    const payload = asRecord(resultPayload);
    const details = asRecord(payload?.details);
    return details?.raw_result ?? null;
  }

  private extractStagePayloads(rawResult: unknown): Record<StageCode, Record<string, unknown> | null> {
    const root = asRecord(rawResult) ?? {};
    const runPayload = asRecord(root.agent_run) ?? {};

    return {
      data: asRecord(root.data_snapshot) ?? asRecord(runPayload.data_snapshot),
      signal: asRecord(root.signal_snapshot) ?? asRecord(runPayload.signal_snapshot),
      risk: asRecord(root.risk_snapshot) ?? asRecord(runPayload.risk_snapshot),
      execution: asRecord(root.execution_snapshot) ?? asRecord(runPayload.execution_snapshot),
    };
  }

  private pickStageStatus(
    code: StageCode,
    payload: Record<string, unknown> | null,
    fallbackStatus?: AnalysisTaskStatus,
  ): StageStatus {
    if (payload) {
      const err = String(payload.error_message ?? payload.errorMessage ?? '').trim();
      if (err) {
        return 'failed';
      }
      if (Object.keys(payload).length > 0) {
        return 'done';
      }
    }

    if (fallbackStatus === AnalysisTaskStatus.failed && code === 'execution') {
      return 'failed';
    }

    return 'pending';
  }

  private pickStageSummary(code: StageCode, payload: Record<string, unknown> | null): string {
    if (!payload) {
      return `${stageTitle(code)} 暂无数据`;
    }

    if (code === 'data') {
      const hasQuote = Boolean(payload.realtime_quote ?? payload.realtime);
      const hasContext = Boolean(payload.analysis_context ?? payload.context);
      return `数据准备 ${hasQuote ? '含实时行情' : '无实时行情'}，${hasContext ? '含上下文' : '无上下文'}`;
    }

    if (code === 'signal') {
      const advice = String(payload.operation_advice ?? payload.operationAdvice ?? '').trim();
      const trend = String(payload.trend_signal ?? payload.trendPrediction ?? '').trim();
      return `信号输出：${advice || '--'} / 趋势：${trend || '--'}`;
    }

    if (code === 'risk') {
      const stopLoss = payload.stop_loss ?? payload.stopLoss;
      const takeProfit = payload.take_profit ?? payload.takeProfit;
      return `风控边界：止损 ${String(stopLoss ?? '--')}，止盈 ${String(takeProfit ?? '--')}`;
    }

    const state = String(payload.state ?? '').trim().toLowerCase();
    const action = String(payload.action ?? payload.order_action ?? payload.decision ?? '').trim();
    const executedVia = String(payload.executed_via ?? payload.executedVia ?? '').trim();
    const tradedQty = asPositiveInt(payload.traded_qty ?? payload.tradedQty ?? payload.quantity);

    if (state === 'failed') {
      return `执行失败：${action || '无明确指令'}`;
    }
    if (state === 'skipped' || action === 'none') {
      return `执行结果：未执行`;
    }
    if (executedVia === 'backtrader_internal' && tradedQty) {
      return `执行结果：${action} ${tradedQty} 股（仿真成交）`;
    }
    return `执行结果：${action || '无明确指令'}`;
  }

  private pickStageIO(payload: Record<string, unknown> | null): { input: Record<string, unknown> | null; output: Record<string, unknown> | null } {
    if (!payload) {
      return { input: null, output: null };
    }

    const input = asRecord(payload.input) ?? asRecord(payload.request) ?? asRecord(payload.request_payload);
    const output = asRecord(payload.output) ?? asRecord(payload.response) ?? asRecord(payload.ai_payload) ?? payload;
    return {
      input: input ?? null,
      output: output ?? null,
    };
  }

  private pickStageDuration(payload: Record<string, unknown> | null): number | null {
    if (!payload) {
      return null;
    }
    const raw = Number(payload.duration_ms ?? payload.durationMs);
    if (!Number.isFinite(raw) || raw < 0) {
      return null;
    }
    return raw;
  }

  private buildStages(
    rawResult: unknown,
    fallbackStatus?: AnalysisTaskStatus,
    fallbackError?: string | null,
  ): StageItem[] {
    const payloads = this.extractStagePayloads(rawResult);
    const codes: StageCode[] = ['data', 'signal', 'risk', 'execution'];

    return codes.map((code) => {
      const payload = payloads[code];
      const io = this.pickStageIO(payload);
      let errorMessage = String(payload?.error_message ?? payload?.errorMessage ?? '').trim() || null;
      const status = this.pickStageStatus(code, payload, fallbackStatus);
      if (status === 'failed' && !errorMessage && code === 'execution' && fallbackError) {
        errorMessage = fallbackError;
      }

      return {
        code,
        status,
        summary: this.pickStageSummary(code, payload),
        duration_ms: this.pickStageDuration(payload),
        input: io.input,
        output: io.output,
        error_message: errorMessage,
      };
    });
  }

  async getTaskStages(taskId: string, scope: RequesterScope): Promise<Record<string, unknown> | null> {
    const ownerFilter = this.buildOwnerFilter(scope);
    const task = scope.includeAll
      ? await this.prisma.analysisTask.findUnique({ where: { taskId } })
      : await this.prisma.analysisTask.findFirst({ where: { taskId, ...ownerFilter } });

    if (!task) {
      const history = await this.prisma.analysisHistory.findFirst({
        where: {
          queryId: taskId,
          ...ownerFilter,
        },
      });
      if (!history) {
        return null;
      }

      const historyRawResult = safeJsonParse<unknown>(history.rawResult, null);
      return {
        task_id: taskId,
        stages: this.buildStages(historyRawResult, AnalysisTaskStatus.completed, null),
      };
    }

    let rawResult = this.extractRawResultFromTaskPayload(task.resultPayload);
    if (!rawResult) {
      const history = await this.prisma.analysisHistory.findFirst({
        where: {
          queryId: task.resultQueryId ?? task.taskId,
          ...ownerFilter,
        },
      });
      rawResult = history ? safeJsonParse<unknown>(history.rawResult, null) : null;
    }

    return {
      task_id: task.taskId,
      stages: this.buildStages(rawResult, task.status, task.error),
    };
  }

  async getTaskStatus(taskId: string, scope: RequesterScope): Promise<Record<string, unknown> | null> {
    const ownerFilter = this.buildOwnerFilter(scope);
    const task = scope.includeAll
      ? await this.prisma.analysisTask.findUnique({ where: { taskId } })
      : await this.prisma.analysisTask.findFirst({ where: { taskId, ...ownerFilter } });
    if (!task) {
      const record = await this.prisma.analysisHistory.findFirst({
        where: {
          queryId: taskId,
          ...ownerFilter,
        },
      });
      if (!record) {
        return null;
      }

      const report = {
        meta: {
          query_id: record.queryId,
          stock_code: record.code,
          stock_name: record.name,
          report_type: record.reportType,
          created_at: record.createdAt.toISOString(),
        },
        summary: {
          analysis_summary: record.analysisSummary,
          operation_advice: record.operationAdvice,
          trend_prediction: record.trendPrediction,
          sentiment_score: record.sentimentScore,
        },
        strategy: {
          ideal_buy: record.idealBuy != null ? String(record.idealBuy) : null,
          secondary_buy: record.secondaryBuy != null ? String(record.secondaryBuy) : null,
          stop_loss: record.stopLoss != null ? String(record.stopLoss) : null,
          take_profit: record.takeProfit != null ? String(record.takeProfit) : null,
        },
      };

      return {
        task_id: taskId,
        status: 'completed',
        progress: 100,
        result: {
          query_id: taskId,
          stock_code: record.code,
          stock_name: record.name,
          report,
          created_at: record.createdAt.toISOString(),
        },
        error: null,
      };
    }

    const result =
      task.status === AnalysisTaskStatus.completed
        ? await this.prisma.analysisHistory.findFirst({
            where: {
              queryId: task.resultQueryId ?? task.taskId,
              ...ownerFilter,
            },
          })
        : null;

    return {
      task_id: task.taskId,
      status: task.status,
      progress: task.progress,
      result: result
        ? {
            query_id: result.queryId,
            stock_code: result.code,
            stock_name: result.name,
            report: {
              meta: {
                query_id: result.queryId,
                stock_code: result.code,
                stock_name: result.name,
                report_type: result.reportType,
                created_at: result.createdAt.toISOString(),
              },
              summary: {
                analysis_summary: result.analysisSummary,
                operation_advice: result.operationAdvice,
                trend_prediction: result.trendPrediction,
                sentiment_score: result.sentimentScore,
              },
            },
            created_at: result.createdAt.toISOString(),
          }
        : null,
      error: task.error,
    };
  }
}
