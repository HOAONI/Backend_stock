/** 后台 Worker 基础设施的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable, Logger } from '@nestjs/common';
import { AnalysisTaskStatus } from '@prisma/client';

import { isAgentRunBridgeError } from '@/common/agent/agent.errors';
import { AgentRunBridgeService } from '@/common/agent/agent-run-bridge.service';
import type { AgentRuntimeConfig } from '@/common/agent/agent.types';
import { PrismaService } from '@/common/database/prisma.service';
import { evaluateTradingSessionGuardFromEnv } from '@/common/utils/trading-session';
import { mapAgentRunToAnalysis } from '@/modules/analysis/analysis.mapper';
import { AnalysisSchedulerService } from '@/modules/analysis/analysis-scheduler.service';
import { AnalysisBrokerMeta, AnalysisService } from '@/modules/analysis/analysis.service';
import { SchedulerHeartbeatService } from '@/modules/analysis/scheduler-heartbeat.service';
import { TradingAccountService, TradingRuntimeContextPayload } from '@/modules/trading-account/trading-account.service';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asPositiveNumber(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
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

function asNonNegativeNumber(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return n;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => item as Record<string, unknown>);
}

function normalizeStockCode(code: string): string {
  return String(code ?? '').trim().toUpperCase().replace(/\.(SH|SZ)$/, '');
}

function extractUpstreamFailure(rawMessage: string, fallbackCode: string): { code: string; message: string } {
  const trimmed = String(rawMessage ?? '').trim();
  const matched = trimmed.match(/^\[([a-z0-9_:-]+)\]\s*(.*)$/i);
  if (!matched) {
    return {
      code: fallbackCode,
      message: trimmed || 'Unknown task failure',
    };
  }

  return {
    code: String(matched[1] ?? '').trim() || fallbackCode,
    message: String(matched[2] ?? '').trim() || trimmed,
  };
}

const DEFAULT_STALE_TASK_TIMEOUT_MS = 15 * 60 * 1000;
const STALE_TASK_ERROR_CODE = 'task_stale_timeout';
const STALE_TASK_ERROR_MESSAGE = '任务执行超时或 worker 已中断';

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class TaskWorkerService {
  private readonly logger = new Logger(TaskWorkerService.name);
  private readonly workerName = 'analysis_task_worker';
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRunBridge: AgentRunBridgeService,
    private readonly analysisService: AnalysisService,
    private readonly analysisSchedulerService: AnalysisSchedulerService,
    private readonly schedulerHeartbeatService: SchedulerHeartbeatService,
    private readonly tradingAccountService: TradingAccountService,
  ) {}

  // Worker 自己维护心跳与退避节奏，调度中心依赖这两个信号判断“是否卡死”和“是否空闲”。
  async start(): Promise<void> {
    this.running = true;
    this.logger.log('Task worker started');
    await this.reportHeartbeat();
    await this.recoverStaleProcessingTasks();

    while (this.running) {
      try {
        const recovered = await this.recoverStaleProcessingTasks();
        const triggeredSchedule = await this.analysisSchedulerService.triggerNextDueSchedule();
        const processedTask = triggeredSchedule ? false : await this.processOne();
        const processed = recovered || triggeredSchedule || processedTask;
        await this.reportHeartbeat();
        if (!processed) {
          await this.sleep(1500);
        }
      } catch (error: unknown) {
        const message = (error as Error).stack || (error as Error).message;
        this.logger.error(message);
        await this.reportHeartbeat({ lastError: message });
        await this.sleep(2000);
      }
    }
  }

  private staleTaskTimeoutMs(): number {
    const raw = Number(process.env.ANALYSIS_TASK_STALE_TIMEOUT_MS ?? `${DEFAULT_STALE_TASK_TIMEOUT_MS}`);
    if (!Number.isFinite(raw) || raw <= 0) {
      return DEFAULT_STALE_TASK_TIMEOUT_MS;
    }
    return Math.floor(raw);
  }

  private staleTaskFailure(): {
    code: string;
    message: string;
    uiMessage: string;
    errorText: string;
  } {
    return {
      code: STALE_TASK_ERROR_CODE,
      message: STALE_TASK_ERROR_MESSAGE,
      uiMessage: `分析失败(${STALE_TASK_ERROR_CODE}): ${STALE_TASK_ERROR_MESSAGE}`.slice(0, 200),
      errorText: `[${STALE_TASK_ERROR_CODE}] ${STALE_TASK_ERROR_MESSAGE}`.slice(0, 500),
    };
  }

  private async recoverStaleProcessingTasks(now = new Date()): Promise<boolean> {
    const cutoff = new Date(now.getTime() - this.staleTaskTimeoutMs());
    const staleTasks = await this.prisma.analysisTask.findMany({
      where: {
        status: AnalysisTaskStatus.processing,
        completedAt: null,
        startedAt: {
          lte: cutoff,
        },
      },
      select: {
        id: true,
        taskId: true,
        scheduleId: true,
        startedAt: true,
        resultPayload: true,
      },
      orderBy: {
        startedAt: 'asc',
      },
    });

    if (staleTasks.length === 0) {
      return false;
    }

    const failure = this.staleTaskFailure();
    const completedAt = new Date(now);
    let recoveredAny = false;

    for (const task of staleTasks) {
      const existingPayload = asRecord(task.resultPayload) ?? {};
      const recovered = await this.prisma.analysisTask.updateMany({
        where: {
          id: task.id,
          status: AnalysisTaskStatus.processing,
          completedAt: null,
          startedAt: {
            lte: cutoff,
          },
        },
        data: {
          status: AnalysisTaskStatus.failed,
          progress: 100,
          message: failure.uiMessage,
          error: failure.errorText,
          resultPayload: {
            ...existingPayload,
            error: {
              code: failure.code,
              message: failure.message,
            },
          } as any,
          completedAt,
          updatedAt: completedAt,
        },
      });

      if (recovered.count === 0) {
        continue;
      }

      recoveredAny = true;
      this.logger.warn(
        `Recovered stale analysis task ${task.taskId} (startedAt=${task.startedAt?.toISOString() ?? 'unknown'})`,
      );
      await this.syncScheduleState({
        scheduleId: task.scheduleId,
        taskId: task.taskId,
        status: 'failed',
        message: failure.uiMessage,
        completedAt,
      });
    }

    return recoveredAny;
  }

  stop(): void {
    this.running = false;
  }

  private workerMode(): 'embedded' | 'external' {
    return (process.env.RUN_WORKER_IN_API ?? 'false').toLowerCase() === 'true' ? 'embedded' : 'external';
  }

  // 心跳更新失败只记日志不抛错，避免调度观测链路反向拖垮真正的任务执行链路。
  private async reportHeartbeat(input?: { lastTaskId?: string | null; lastError?: string | null }): Promise<void> {
    try {
      await this.schedulerHeartbeatService.updateWorkerHeartbeat({
        workerName: this.workerName,
        workerMode: this.workerMode(),
        lastTaskId: input?.lastTaskId ?? null,
        lastError: input?.lastError ?? null,
      });
    } catch (error: unknown) {
      this.logger.warn(`worker heartbeat update failed: ${(error as Error).message}`);
    }
  }

  private async syncScheduleState(input: {
    scheduleId?: string | null;
    taskId: string;
    status: 'processing' | 'completed' | 'failed' | 'cancelled';
    message?: string | null;
    completedAt?: Date | null;
  }): Promise<void> {
    if (!input.scheduleId) {
      return;
    }

    try {
      await this.analysisSchedulerService.recordScheduleTaskState({
        scheduleId: input.scheduleId,
        taskId: input.taskId,
        status: input.status,
        message: input.message ?? null,
        completedAt: input.completedAt ?? null,
      });
    } catch (error: unknown) {
      this.logger.warn(`schedule state sync failed: ${(error as Error).message}`);
    }
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

  private resolveFailurePresentation(error: unknown): { code: string; message: string } {
    const explicitCode = String((error as Error & { code?: string }).code ?? '').trim();
    const bridgeErrorCode = isAgentRunBridgeError(error) ? error.code : explicitCode || 'internal_error';
    const rawMessage = (error as Error).message || 'Unknown task failure';
    const parsed = extractUpstreamFailure(rawMessage, bridgeErrorCode);

    if (bridgeErrorCode === 'agent_task_failed' && parsed.code !== bridgeErrorCode) {
      return parsed;
    }

    return {
      code: bridgeErrorCode,
      message: rawMessage.slice(0, 500),
    };
  }

  private buildRuntimeContext(payload: TradingRuntimeContextPayload): NonNullable<AgentRuntimeConfig['context']> {
    const summary = asRecord(payload.summary) ?? {};
    const positions = asRecordArray(payload.positions);

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

  private async resolveRunOptions(task: {
    taskId: string;
    requestPayload: unknown;
    ownerUserId: number | null;
  }): Promise<{
    accountName: string | null;
    runtimeConfig?: AgentRuntimeConfig;
    forceRuntimeConfig: boolean;
    executionMeta: AnalysisBrokerMeta;
  }> {
    // 队列里存的是“入队瞬间”的脱敏快照，这里负责在真正执行前决定是否要回源用户实时配置。
    const executionMeta = this.analysisService.resolveExecutionMetaFromPayload(task.requestPayload);

    if (task.ownerUserId != null) {
      // 对真实用户任务优先回源当前用户档案重建 runtime_config，避免队列里残留的是脱敏旧快照。
      const runtime = await this.analysisService.buildRuntimeContext(task.ownerUserId, {
        includeApiToken: true,
      });
      const runtimeConfig = this.analysisService.buildRuntimeConfigForExecution(runtime.runtimeConfig, executionMeta);

      return {
        accountName: runtime.accountName,
        runtimeConfig: executionMeta.execution_mode === 'broker' && executionMeta.broker_account_id
          ? {
              ...runtimeConfig,
              context: this.buildRuntimeContext(
                await this.tradingAccountService.getRuntimeContext(task.ownerUserId, true),
              ),
            }
          : runtimeConfig,
        forceRuntimeConfig: true,
        executionMeta,
      };
    }

    const runtimeConfig = this.resolveRuntimeConfigFromPayload(task);
    return {
      accountName: this.resolveAccountNameFromPayload(task),
      runtimeConfig: runtimeConfig
        ? this.analysisService.buildRuntimeConfigForExecution(runtimeConfig, executionMeta)
        : undefined,
      forceRuntimeConfig: Boolean(runtimeConfig),
      executionMeta,
    };
  }

  // 只有“用户请求 auto，但执行计划被降级到 paper，同时全局仍允许 auto”时，才触发本地补偿下单。
  private shouldAutoPlaceOrder(meta: AnalysisBrokerMeta): boolean {
    return meta.requested_execution_mode === 'auto'
      && meta.execution_mode === 'paper'
      && Boolean(meta.auto_order_enabled);
  }

  private resolveExecutionSnapshot(runPayload: Record<string, unknown>, stockCode: string): Record<string, unknown> {
    const executionRoot = asRecord(runPayload.execution_snapshot) ?? {};
    return asRecord(executionRoot[stockCode]) ?? executionRoot;
  }

  private deriveAutoOrderFromExecution(input: {
    task: { stockCode: string };
    runPayload: Record<string, unknown>;
    executionMeta: AnalysisBrokerMeta;
  }): Record<string, unknown> | null {
    // 只要 Agent 已经给出明确的执行快照，就直接把它收敛成 Backend 自己的 auto_order 结构。
    if (input.executionMeta.requested_execution_mode !== 'auto') {
      return null;
    }

    const execution = this.resolveExecutionSnapshot(input.runPayload, input.task.stockCode);
    const state = String(execution.state ?? '').trim().toLowerCase();
    const action = String(execution.action ?? '').trim().toLowerCase();
    const executedVia = String(execution.executed_via ?? execution.executedVia ?? '').trim();
    const brokerRequested = Boolean(execution.broker_requested ?? execution.brokerRequested);
    const providerOrderId = String(execution.broker_ticket_id ?? execution.brokerTicketId ?? '').trim() || null;

    if (input.executionMeta.execution_mode !== 'broker' && executedVia !== 'backtrader_internal' && !brokerRequested) {
      return null;
    }

    if (state === 'failed') {
      return {
        status: 'failed',
        source: 'agent_execution',
        executed_via: executedVia || 'backtrader_internal',
        reason: String(execution.reason ?? 'broker_rejected').trim() || 'broker_rejected',
        error: String(execution.error_message ?? execution.errorMessage ?? '').trim() || null,
        provider_order_id: providerOrderId,
        order_id: execution.order_id ?? execution.orderId ?? null,
        trade_id: execution.trade_id ?? execution.tradeId ?? null,
      };
    }

    if (state === 'skipped' || action === 'none') {
      return {
        status: 'skipped',
        source: 'agent_execution',
        executed_via: executedVia || 'backtrader_internal',
        reason: String(execution.reason ?? 'target_matched').trim() || 'target_matched',
      };
    }

    return {
      status: 'submitted',
      source: 'agent_execution',
      executed_via: executedVia || 'backtrader_internal',
      reason: String(execution.reason ?? 'broker_executed').trim() || 'broker_executed',
      action,
      traded_qty: execution.traded_qty ?? execution.tradedQty ?? null,
      fill_price: execution.fill_price ?? execution.fillPrice ?? null,
      provider_order_id: providerOrderId,
      order_id: execution.order_id ?? execution.orderId ?? null,
      trade_id: execution.trade_id ?? execution.tradeId ?? null,
    };
  }

  private isAShare(code: string): boolean {
    return /^(60|68|00|30)\d{4}$/.test(code);
  }

  private resolveAutoOrderCandidate(run: Record<string, unknown>, stockCode: string): {
    direction: 'buy' | 'sell';
    quantity: number;
    price: number;
  } | null {
    const executionRoot = asRecord(run.execution_snapshot) ?? {};
    const execution = asRecord(executionRoot[stockCode]) ?? executionRoot;
    const action = String(execution.action ?? '').trim().toLowerCase();
    if (action !== 'buy' && action !== 'sell') {
      return null;
    }

    const qty = asPositiveNumber(
      execution.traded_qty
      ?? execution.target_qty
      ?? execution.quantity
      ?? execution.order_quantity,
    );
    if (!qty) {
      return null;
    }

    const dataRoot = asRecord(run.data_snapshot) ?? {};
    const data = asRecord(dataRoot[stockCode]) ?? dataRoot;
    const quote = asRecord(data.realtime_quote) ?? {};
    const price = asPositiveNumber(
      execution.fill_price
      ?? quote.price
      ?? quote.current_price
      ?? execution.price,
    );
    if (!price) {
      return null;
    }

    return {
      direction: action as 'buy' | 'sell',
      quantity: Math.floor(qty),
      price,
    };
  }

  private applyAutoOrderLimits(candidate: { quantity: number; price: number }): { quantity: number; skippedReason?: string } {
    const maxQty = Math.max(1, Number(process.env.ANALYSIS_AUTO_ORDER_MAX_QTY ?? '20000'));
    const maxNotional = Math.max(1000, Number(process.env.ANALYSIS_AUTO_ORDER_MAX_NOTIONAL ?? '200000'));
    const safeQtyByNotional = Math.floor(maxNotional / candidate.price);
    const safeQty = Math.min(candidate.quantity, maxQty, safeQtyByNotional > 0 ? safeQtyByNotional : 0);
    if (safeQty <= 0) {
      return { quantity: 0, skippedReason: 'auto_order_limit_rejected' };
    }
    return { quantity: safeQty };
  }

  private resolvePrecheckCash(summary: Record<string, unknown>): number {
    return Math.max(
      0,
      asNonNegativeNumber(summary.cash ?? summary.available_cash ?? summary.availableCash) ?? 0,
    );
  }

  private resolvePrecheckAvailableQty(positions: Array<Record<string, unknown>>, stockCode: string): number {
    const targetCode = normalizeStockCode(stockCode);
    for (const row of positions) {
      const rowCode = normalizeStockCode(String(row.code ?? row.stock_code ?? row.symbol ?? ''));
      if (rowCode !== targetCode) {
        continue;
      }
      return Math.max(
        0,
        Math.floor(asNonNegativeNumber(row.available_qty ?? row.available ?? row.quantity ?? row.qty ?? 0) ?? 0),
      );
    }
    return 0;
  }

  private estimateBuyRequiredCash(price: number, quantity: number): number {
    const commissionRate = Math.max(0, asNonNegativeNumber(process.env.BACKTRADER_DEFAULT_COMMISSION ?? '0.0003') ?? 0.0003);
    const slippageBps = Math.max(0, asNonNegativeNumber(process.env.BACKTRADER_DEFAULT_SLIPPAGE_BPS ?? '2') ?? 2);
    const effectivePrice = price * (1 + slippageBps / 10000);
    return effectivePrice * quantity * (1 + commissionRate);
  }

  private async runAutoOrderPrecheck(input: {
    userId: number;
    stockCode: string;
    direction: 'buy' | 'sell';
    quantity: number;
    price: number;
  }): Promise<{ ok: true } | { ok: false; reason: string; details: Record<string, unknown> }> {
    // 补偿下单前再做一次本地资金/持仓校验，避免分析结果合理但账户状态已经变化时误下单。
    const runtime = await this.tradingAccountService.getRuntimeContext(input.userId, true);
    const summary = asRecord(runtime.summary) ?? {};
    const positions = asRecordArray(runtime.positions);

    if (input.direction === 'buy') {
      const cash = this.resolvePrecheckCash(summary);
      const requiredCash = this.estimateBuyRequiredCash(input.price, input.quantity);
      if (cash + 1e-6 < requiredCash) {
        return {
          ok: false,
          reason: 'insufficient_cash_precheck',
          details: {
            cash: Number(cash.toFixed(4)),
            required_cash: Number(requiredCash.toFixed(4)),
            quantity: input.quantity,
            price: input.price,
          },
        };
      }
      return { ok: true };
    }

    const availableQty = this.resolvePrecheckAvailableQty(positions, input.stockCode);
    if (availableQty < input.quantity) {
      return {
        ok: false,
        reason: 'insufficient_position_precheck',
        details: {
          available_qty: availableQty,
          requested_qty: input.quantity,
        },
      };
    }
    return { ok: true };
  }

  private resolveAutoOrderStatus(orderPayload: Record<string, unknown>): 'submitted' | 'failed' {
    const providerStatus = String(
      orderPayload.provider_status
      ?? orderPayload.providerStatus
      ?? orderPayload.status
      ?? '',
    )
      .trim()
      .toLowerCase();
    return providerStatus === 'rejected' || providerStatus === 'failed' ? 'failed' : 'submitted';
  }

  private async maybeAutoPlaceOrder(input: {
    task: { taskId: string; stockCode: string; ownerUserId: number | null };
    runPayload: Record<string, unknown>;
    executionMeta: AnalysisBrokerMeta;
  }): Promise<Record<string, unknown> | null> {
    // 如果 Agent 侧已经真正执行过 broker 订单，就直接复用 execution_snapshot，不再由 Backend 二次下单。
    if (!this.shouldAutoPlaceOrder(input.executionMeta)) {
      return null;
    }
    if (!input.task.ownerUserId) {
      throw new Error('auto 模式任务缺少 owner_user_id，无法自动下单');
    }

    const stockCode = normalizeStockCode(input.task.stockCode);
    if ((process.env.ANALYSIS_AUTO_ORDER_A_SHARE_ONLY ?? 'true').toLowerCase() === 'true' && !this.isAShare(stockCode)) {
      return {
        status: 'skipped',
        reason: 'non_a_share',
      };
    }
    if (!evaluateTradingSessionGuardFromEnv().allowed) {
      return {
        status: 'skipped',
        reason: 'outside_trading_session',
      };
    }

    const candidate = this.resolveAutoOrderCandidate(input.runPayload, input.task.stockCode);
    if (!candidate) {
      return {
        status: 'skipped',
        reason: 'no_executable_signal',
      };
    }
    const limit = this.applyAutoOrderLimits({
      quantity: candidate.quantity,
      price: candidate.price,
    });
    if (limit.quantity <= 0) {
      return {
        status: 'skipped',
        reason: limit.skippedReason ?? 'auto_order_limit_rejected',
      };
    }

    const precheck = await this.runAutoOrderPrecheck({
      userId: input.task.ownerUserId,
      stockCode,
      direction: candidate.direction,
      quantity: limit.quantity,
      price: candidate.price,
    });
    if (!precheck.ok) {
      return {
        status: 'skipped',
        reason: precheck.reason,
        precheck: precheck.details,
      };
    }

    const orderType = (process.env.ANALYSIS_AUTO_ORDER_TYPE ?? 'market').toLowerCase() === 'limit' ? 'limit' : 'market';
    const idempotencyKey = `analysis-auto:${input.task.taskId}:${stockCode}`;

    const response = await this.tradingAccountService.placeOrder(input.task.ownerUserId, {
      stock_code: stockCode,
      direction: candidate.direction,
      type: orderType,
      price: candidate.price,
      quantity: limit.quantity,
      idempotency_key: idempotencyKey,
      source_task_id: input.task.taskId,
      payload: {
        source: 'analysis_auto_order',
      },
    });
    const orderPayload = asRecord(response.order) ?? {};
    const status = this.resolveAutoOrderStatus(orderPayload);

    return {
      status,
      ...(status === 'failed' ? { reason: 'provider_rejected' } : {}),
      idempotency_key: idempotencyKey,
      order_type: orderType,
      order: response.order,
    };
  }

  // 先读一条 pending 候选，再用条件更新抢锁，保证多 worker 并发时同一任务只会被一个实例消费。
  private async processOne(): Promise<boolean> {
    const now = new Date();
    const candidate = await this.prisma.analysisTask.findFirst({
      where: {
        status: AnalysisTaskStatus.pending,
        OR: [
          { runAfter: null },
          { runAfter: { lte: now } },
        ],
      },
      orderBy: [
        { priority: 'asc' },
        { createdAt: 'asc' },
      ],
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

    await this.reportHeartbeat({ lastTaskId: candidate.taskId });
    await this.syncScheduleState({
      scheduleId: candidate.scheduleId,
      taskId: candidate.taskId,
      status: 'processing',
      message: '正在分析中...',
    });
    await this.handleTask(candidate.id);
    return true;
  }

  // 任务完成后会同时写 analysis_history 和 analysis_task：前者保历史查询，后者保调度态与可观测信息。
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
      // 统一先把 Agent 结果折叠成历史记录，再把桥接元信息和自动下单状态附着到任务结果里。
      const mapped = mapAgentRunToAnalysis(bridgeResult.run, task.stockCode, task.reportType);
      const autoOrder = this.deriveAutoOrderFromExecution({
        task: {
          stockCode: task.stockCode,
        },
        runPayload: bridgeResult.run as unknown as Record<string, unknown>,
        executionMeta: options.executionMeta,
      }) ?? await this.maybeAutoPlaceOrder({
        task: {
          taskId: task.taskId,
          stockCode: task.stockCode,
          ownerUserId: task.ownerUserId,
        },
        runPayload: bridgeResult.run as unknown as Record<string, unknown>,
        executionMeta: options.executionMeta,
      });
      const resultPayload = {
        ...mapped.report,
        bridge_meta: bridgeResult.bridgeMeta,
        auto_order: autoOrder,
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

      const completedAt = new Date();
      await this.prisma.analysisTask.update({
        where: { id: task.id },
        data: {
          status: AnalysisTaskStatus.completed,
          progress: 100,
          message: '分析完成',
          completedAt,
          resultQueryId: task.taskId,
          resultPayload: resultPayload as any,
          updatedAt: new Date(),
        },
      });
      await this.syncScheduleState({
        scheduleId: task.scheduleId,
        taskId: task.taskId,
        status: 'completed',
        message: '分析完成',
        completedAt,
      });
      await this.reportHeartbeat({ lastTaskId: task.taskId });
    } catch (error: unknown) {
      // 失败分支也要把 bridge_meta 和稳定错误码写回，方便前端、调度中心和排障日志统一消费。
      const failure = this.resolveFailurePresentation(error);
      const bridgeErrorCode = failure.code;
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
      const safeMessage = failure.message.slice(0, 500);
      const uiMessage = `分析失败(${bridgeErrorCode}): ${safeMessage}`.slice(0, 200);

      this.logger.error(`Task failed: ${task.taskId} [${bridgeErrorCode}] ${safeMessage}`);

      const completedAt = new Date();
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
          completedAt,
          updatedAt: new Date(),
        },
      });
      await this.syncScheduleState({
        scheduleId: task.scheduleId,
        taskId: task.taskId,
        status: 'failed',
        message: `[${bridgeErrorCode}] ${safeMessage}`.slice(0, 500),
        completedAt,
      });
      await this.reportHeartbeat({ lastTaskId: task.taskId, lastError: safeMessage });
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), ms);
    });
  }
}
