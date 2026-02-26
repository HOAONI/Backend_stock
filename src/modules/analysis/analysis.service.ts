import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AnalysisTaskStatus, Prisma, UserBrokerAccountStatus } from '@prisma/client';

import { AgentExecutionMode, AgentRunPayload, AgentRuntimeConfig } from '@/common/agent/agent.types';
import { AgentRunBridgeService } from '@/common/agent/agent-run-bridge.service';
import { buildRuntimeConfigFromProfile, maskRuntimeConfig } from '@/common/agent/runtime-config.builder';
import { PrismaService } from '@/common/database/prisma.service';
import { PersonalCryptoService } from '@/common/security/personal-crypto.service';
import { safeJsonParse } from '@/common/utils/json';
import { canonicalStockCode } from '@/common/utils/stock-code';
import { AgentBridgeService } from '@/modules/agent-bridge/agent-bridge.service';

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
}

export interface AnalysisBrokerMeta {
  execution_mode: AgentExecutionMode;
  requested_execution_mode: RequestedExecutionMode;
  broker_account_id: number | null;
  credential_ticket_id: number | null;
  broker_plan_reason: string;
}

type RequestedExecutionMode = 'auto' | 'paper' | 'broker';

interface IssuedTradeTicket {
  ticket: string;
  ticketId: number;
}

interface ServiceError extends Error {
  code?: string;
}

function createServiceError(code: string, message: string): ServiceError {
  const error = new Error(message) as ServiceError;
  error.code = code;
  return error;
}

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

function stageTitle(code: StageCode): string {
  if (code === 'data') return '数据获取 Agent';
  if (code === 'signal') return '信号策略 Agent';
  if (code === 'risk') return '风险控制 Agent';
  return '执行 Agent';
}

@Injectable()
export class AnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRunBridge: AgentRunBridgeService,
    private readonly personalCrypto: PersonalCryptoService,
    private readonly agentBridgeService: AgentBridgeService,
  ) {}

  normalizeRequest(request: AnalyzeRequestDto): {
    stockCode: string;
    reportType: string;
    forceRefresh: boolean;
    executionMode: RequestedExecutionMode;
    brokerAccountId: number | null;
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

    return {
      stockCode: dedup[0],
      reportType: request.report_type ?? 'detailed',
      forceRefresh: Boolean(request.force_refresh),
      executionMode: request.execution_mode ?? 'auto',
      brokerAccountId: request.broker_account_id ?? null,
    };
  }

  private shouldForwardRuntimeConfig(): boolean {
    return (process.env.AGENT_FORWARD_RUNTIME_CONFIG ?? 'false').toLowerCase() === 'true';
  }

  private decryptProfileToken(profile: {
    aiTokenCiphertext: string | null;
    aiTokenIv: string | null;
    aiTokenTag: string | null;
  }): string | null {
    if (!profile.aiTokenCiphertext) {
      return null;
    }
    if (!profile.aiTokenIv || !profile.aiTokenTag) {
      throw new Error('个人 AI Token 缺少加密元数据，无法下发到 Agent');
    }

    return this.personalCrypto.decrypt({
      ciphertext: profile.aiTokenCiphertext,
      iv: profile.aiTokenIv,
      tag: profile.aiTokenTag,
    });
  }

  async buildRuntimeContext(userId: number, options?: { includeApiToken?: boolean }): Promise<RuntimeContext> {
    const [profile, user] = await this.prisma.$transaction([
      this.prisma.adminUserProfile.findUnique({ where: { userId } }),
      this.prisma.adminUser.findUnique({
        where: { id: userId },
        select: { username: true },
      }),
    ]);

    const includeApiToken = Boolean(options?.includeApiToken);
    const apiToken = includeApiToken && profile ? this.decryptProfileToken(profile) : null;
    const runtimeConfig = buildRuntimeConfigFromProfile(profile, user?.username ?? `u${userId}`, {
      apiToken,
    });
    return {
      runtimeConfig,
      maskedRuntimeConfig: maskRuntimeConfig(runtimeConfig),
      accountName: runtimeConfig.account.account_name,
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
    if (raw === 'paper' || raw === 'broker') {
      return raw;
    }
    return 'auto';
  }

  private cloneRuntimeConfig(runtimeConfig: AgentRuntimeConfig): AgentRuntimeConfig {
    return {
      account: { ...runtimeConfig.account },
      llm: { ...runtimeConfig.llm },
      strategy: { ...runtimeConfig.strategy },
      execution: runtimeConfig.execution ? { ...runtimeConfig.execution } : undefined,
    };
  }

  async resolveExecutionPlan(
    userId: number,
    requestedModeInput?: string | null,
    brokerAccountIdInput?: number | null,
  ): Promise<AnalysisBrokerMeta> {
    const requestedMode = this.parseRequestedExecutionMode(requestedModeInput);
    const requestedBrokerAccountId = brokerAccountIdInput == null ? null : asPositiveInt(brokerAccountIdInput);
    if (brokerAccountIdInput != null && !requestedBrokerAccountId) {
      throw createServiceError('VALIDATION_ERROR', 'broker_account_id 必须为正整数');
    }

    if (requestedMode === 'paper') {
      return {
        execution_mode: 'paper',
        requested_execution_mode: requestedMode,
        broker_account_id: null,
        credential_ticket_id: null,
        broker_plan_reason: 'forced_paper',
      };
    }

    const brokerAccount = await this.prisma.userBrokerAccount.findFirst({
      where: {
        userId,
        id: requestedBrokerAccountId ?? undefined,
        deletedAt: null,
        status: UserBrokerAccountStatus.active,
        isVerified: true,
      },
      orderBy: [{ isVerified: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });

    if (requestedMode === 'broker') {
      if (!brokerAccount) {
        throw createServiceError('VALIDATION_ERROR', '指定 broker 模式但未找到可用且已校验的券商账户');
      }
      return {
        execution_mode: 'broker',
        requested_execution_mode: requestedMode,
        broker_account_id: brokerAccount.id,
        credential_ticket_id: null,
        broker_plan_reason: requestedBrokerAccountId ? 'forced_broker_selected_account' : 'forced_broker_auto_pick',
      };
    }

    if (requestedBrokerAccountId && !brokerAccount) {
      throw createServiceError('VALIDATION_ERROR', `broker_account_id=${requestedBrokerAccountId} 不可用或尚未 verify`);
    }

    if (brokerAccount) {
      return {
        execution_mode: 'broker',
        requested_execution_mode: requestedMode,
        broker_account_id: brokerAccount.id,
        credential_ticket_id: null,
        broker_plan_reason: requestedBrokerAccountId ? 'auto_verified_selected_account' : 'auto_verified_account',
      };
    }

    return {
      execution_mode: 'paper',
      requested_execution_mode: requestedMode,
      broker_account_id: null,
      credential_ticket_id: null,
      broker_plan_reason: 'auto_no_verified_account',
    };
  }

  resolveExecutionMetaFromPayload(requestPayload: unknown): AnalysisBrokerMeta {
    const payload = asRecord(requestPayload);
    const meta = asRecord(payload?.meta);
    const executionMode = String(meta?.execution_mode ?? '').trim().toLowerCase() === 'broker' ? 'broker' : 'paper';
    const requestedMode = this.parseRequestedExecutionMode(meta?.requested_execution_mode ?? meta?.execution_mode ?? 'auto');
    const brokerAccountId = asPositiveInt(meta?.broker_account_id);
    const credentialTicketId = asPositiveInt(meta?.credential_ticket_id);
    const reason = String(meta?.broker_plan_reason ?? '').trim() || 'legacy_default';

    return {
      execution_mode: executionMode,
      requested_execution_mode: requestedMode,
      broker_account_id: brokerAccountId,
      credential_ticket_id: credentialTicketId,
      broker_plan_reason: reason,
    };
  }

  buildRuntimeConfigForExecution(
    runtimeConfig: AgentRuntimeConfig,
    executionMeta: Pick<AnalysisBrokerMeta, 'execution_mode' | 'broker_account_id' | 'credential_ticket_id'>,
    options?: { credentialTicket?: string | null; ticketId?: number | null },
  ): AgentRuntimeConfig {
    const cloned = this.cloneRuntimeConfig(runtimeConfig);
    const credentialTicket = String(options?.credentialTicket ?? '').trim();
    const ticketId = asPositiveInt(options?.ticketId ?? executionMeta.credential_ticket_id);
    const brokerAccountId = asPositiveInt(executionMeta.broker_account_id);

    cloned.execution = {
      mode: executionMeta.execution_mode,
      has_ticket: Boolean(credentialTicket),
      ...(credentialTicket ? { credential_ticket: credentialTicket } : {}),
      ...(ticketId ? { ticket_id: ticketId } : {}),
      ...(brokerAccountId ? { broker_account_id: brokerAccountId } : {}),
    };

    return cloned;
  }

  async issueTradeCredentialTicket(input: {
    userId: number;
    brokerAccountId: number;
    taskId: string;
  }): Promise<IssuedTradeTicket> {
    const brokerAccountId = asPositiveInt(input.brokerAccountId);
    if (!brokerAccountId) {
      throw createServiceError('VALIDATION_ERROR', '签发交易票据失败：缺少 broker_account_id');
    }

    const response = await this.agentBridgeService.issueCredentialTicket({
      user_id: input.userId,
      broker_account_id: brokerAccountId,
      scope: 'trade',
      task_id: input.taskId,
    });

    const ticket = String(response.ticket ?? '').trim();
    const ticketId = asPositiveInt(response.ticket_id);
    if (!ticket || !ticketId) {
      throw createServiceError('VALIDATION_ERROR', '签发交易票据响应异常：缺少 ticket 或 ticket_id');
    }

    return {
      ticket,
      ticketId,
    };
  }

  async updateTaskCredentialTicketMeta(taskRowId: number, ticketId: number): Promise<void> {
    const safeTicketId = asPositiveInt(ticketId);
    if (!safeTicketId) {
      return;
    }

    const task = await this.prisma.analysisTask.findUnique({
      where: { id: taskRowId },
      select: { requestPayload: true },
    });
    if (!task) {
      return;
    }

    const payload = asRecord(task.requestPayload) ?? {};
    const meta = asRecord(payload.meta) ?? {};
    const mergedPayload = {
      ...payload,
      meta: {
        ...meta,
        credential_ticket_id: safeTicketId,
      },
    };

    await this.prisma.analysisTask.update({
      where: { id: taskRowId },
      data: {
        requestPayload: mergedPayload as unknown as Prisma.InputJsonValue,
      },
    });
  }

  assertBrokerExecutionSucceeded(run: AgentRunPayload, stockCode: string): void {
    const root = asRecord(run.execution_snapshot);
    if (!root) {
      throw createServiceError('broker_execution_degraded', 'Agent 未返回 execution_snapshot，无法确认 broker 执行结果');
    }

    const byCode = asRecord(root[stockCode]);
    const snapshot = byCode ?? root;

    const executedVia = String(snapshot.executed_via ?? snapshot.executedVia ?? '').trim().toLowerCase();
    const fallbackReason = String(snapshot.fallback_reason ?? snapshot.fallbackReason ?? '').trim();
    const errorMessage = String(snapshot.error_message ?? snapshot.errorMessage ?? '').trim();

    if (executedVia !== 'broker' || fallbackReason || errorMessage) {
      const detail = [
        executedVia ? `executed_via=${executedVia}` : 'executed_via=unknown',
        fallbackReason ? `fallback_reason=${fallbackReason}` : null,
        errorMessage ? `error=${errorMessage}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      throw createServiceError('broker_execution_degraded', `真实执行未达成：${detail || 'agent returned degraded execution'}`);
    }
  }

  async runSync(input: {
    stockCode: string;
    reportType: string;
    userId: number;
    executionMode?: RequestedExecutionMode;
    brokerAccountId?: number | null;
  }): Promise<Record<string, unknown>> {
    const runtime = await this.buildRuntimeContext(input.userId, {
      includeApiToken: this.shouldForwardRuntimeConfig(),
    });
    const executionMeta = await this.resolveExecutionPlan(input.userId, input.executionMode, input.brokerAccountId);
    const runRequestId = randomUUID().replace(/-/g, '');

    let runtimeConfig = this.buildRuntimeConfigForExecution(runtime.runtimeConfig, executionMeta);
    let forceRuntimeConfig = false;
    if (executionMeta.execution_mode === 'broker') {
      const issued = await this.issueTradeCredentialTicket({
        userId: input.userId,
        brokerAccountId: executionMeta.broker_account_id as number,
        taskId: runRequestId,
      });
      runtimeConfig = this.buildRuntimeConfigForExecution(runtime.runtimeConfig, executionMeta, {
        credentialTicket: issued.ticket,
        ticketId: issued.ticketId,
      });
      forceRuntimeConfig = true;
    }

    const bridgeResult = await this.agentRunBridge.runViaAsyncTask([input.stockCode], runRequestId, {
      accountName: runtime.accountName,
      runtimeConfig,
      forceRuntimeConfig,
    });
    if (executionMeta.execution_mode === 'broker') {
      this.assertBrokerExecutionSucceeded(bridgeResult.run, input.stockCode);
    }
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

  async submitAsync(input: {
    stockCode: string;
    reportType: string;
    forceRefresh: boolean;
    userId: number;
    executionMode?: RequestedExecutionMode;
    brokerAccountId?: number | null;
  }): Promise<Record<string, unknown>> {
    const runtime = await this.buildRuntimeContext(input.userId);
    const executionMeta = await this.resolveExecutionPlan(input.userId, input.executionMode, input.brokerAccountId);
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

    const action = String(payload.action ?? payload.order_action ?? payload.decision ?? '').trim();
    return `执行建议：${action || '无明确指令'}`;
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
