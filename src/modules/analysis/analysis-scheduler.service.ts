/** 股票分析模块的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable } from '@nestjs/common';
import { AnalysisTaskStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AgentClientService } from '@/common/agent/agent-client.service';
import { PrismaService } from '@/common/database/prisma.service';

import { AnalysisService, RequesterScope } from './analysis.service';

type SchedulerViewScope = 'mine' | 'all';
type WorkerMode = 'embedded' | 'external';

interface SchedulerTaskListQuery {
  page: number;
  limit: number;
  status?: string | null;
  stockCode?: string | null;
  username?: string | null;
  executionMode?: string | null;
  staleOnly?: boolean;
  startDate?: string | null;
  endDate?: string | null;
  scope?: SchedulerViewScope | null;
}

interface HeartbeatUpdateInput {
  workerName: string;
  workerMode: WorkerMode;
  lastTaskId?: string | null;
  lastError?: string | null;
}

type SchedulerTaskRow = Prisma.AnalysisTaskGetPayload<{
  include: {
    ownerUser: {
      select: { id: true; username: true; displayName: true };
    };
  };
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return String(value ?? '').trim();
}

function asExecutionMode(
  task: { requestPayload: Prisma.JsonValue | null },
): { executionMode: 'paper' | 'broker'; requestedExecutionMode: 'auto' | 'paper' } {
  const payload = asRecord(task.requestPayload);
  const meta = asRecord(payload?.meta);
  const executionMode = asString(meta?.execution_mode).toLowerCase() === 'broker' ? 'broker' : 'paper';
  const requestedExecutionMode = asString(meta?.requested_execution_mode).toLowerCase() === 'paper' ? 'paper' : 'auto';
  return { executionMode, requestedExecutionMode };
}

function normalizeScope(scope: RequesterScope, requested: string | null | undefined): SchedulerViewScope {
  if (scope.includeAll && String(requested ?? '').trim().toLowerCase() === 'all') {
    return 'all';
  }
  return 'mine';
}

function parseDateInput(value: string | null | undefined, edge: 'start' | 'end'): Date | null {
  const text = asString(value);
  if (!text) {
    return null;
  }

  const suffix = edge === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z';
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}${suffix}` : text;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizeStatusList(value: string | null | undefined): AnalysisTaskStatus[] {
  const all = new Set(Object.values(AnalysisTaskStatus));
  return asString(value)
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter((item): item is AnalysisTaskStatus => all.has(item as AnalysisTaskStatus));
}

function normalizePriority(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 9999) {
    return null;
  }
  return parsed;
}

function normalizeTaskSortStatus(status: AnalysisTaskStatus): number {
  if (status === AnalysisTaskStatus.pending) return 0;
  if (status === AnalysisTaskStatus.processing) return 1;
  if (status === AnalysisTaskStatus.failed) return 2;
  if (status === AnalysisTaskStatus.cancelled) return 3;
  return 4;
}

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class AnalysisSchedulerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentClient: AgentClientService,
    private readonly analysisService: AnalysisService,
  ) {}

  private staleTimeoutMs(): number {
    return Math.max(60_000, Number(process.env.ANALYSIS_TASK_STALE_TIMEOUT_MS ?? '900000'));
  }

  private heartbeatTtlMs(): number {
    return Math.max(5_000, Number(process.env.SCHEDULER_HEARTBEAT_TTL_MS ?? '15000'));
  }

  private defaultPriority(): number {
    return 100;
  }

  private workerMode(): WorkerMode {
    return (process.env.RUN_WORKER_IN_API ?? 'false').toLowerCase() === 'true' ? 'embedded' : 'external';
  }

  private buildOwnerWhere(scope: RequesterScope, viewScope: SchedulerViewScope): Prisma.AnalysisTaskWhereInput {
    if (scope.includeAll && viewScope === 'all') {
      return {};
    }
    return { ownerUserId: scope.userId };
  }

  private isTaskStale(task: {
    status: AnalysisTaskStatus;
    createdAt: Date;
    startedAt: Date | null;
    runAfter: Date | null;
  }, now = new Date()): boolean {
    const cutoff = now.getTime() - this.staleTimeoutMs();
    if (task.status === AnalysisTaskStatus.processing) {
      return Boolean(task.startedAt && task.startedAt.getTime() <= cutoff);
    }
    if (task.status === AnalysisTaskStatus.pending) {
      if (task.runAfter && task.runAfter.getTime() > now.getTime()) {
        return false;
      }
      return task.createdAt.getTime() <= cutoff;
    }
    return false;
  }

  private mapTaskRow(
    row: SchedulerTaskRow,
    now = new Date(),
  ): Record<string, unknown> {
    const { executionMode, requestedExecutionMode } = asExecutionMode(row);
    return {
      task_id: row.taskId,
      root_task_id: row.rootTaskId ?? row.taskId,
      retry_of_task_id: row.retryOfTaskId,
      attempt_no: row.attemptNo,
      priority: row.priority,
      run_after: row.runAfter?.toISOString() ?? null,
      cancelled_at: row.cancelledAt?.toISOString() ?? null,
      stock_code: row.stockCode,
      report_type: row.reportType,
      status: row.status,
      progress: row.progress,
      message: row.message,
      result_query_id: row.resultQueryId,
      error: row.error,
      created_at: row.createdAt.toISOString(),
      started_at: row.startedAt?.toISOString() ?? null,
      completed_at: row.completedAt?.toISOString() ?? null,
      owner_user_id: row.ownerUserId,
      owner_username: row.ownerUser?.username ?? null,
      owner_display_name: row.ownerUser?.displayName ?? null,
      execution_mode: executionMode,
      requested_execution_mode: requestedExecutionMode,
      is_stale: this.isTaskStale(row, now),
    };
  }

  private sortTasks(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return [...items].sort((left, right) => {
      const leftStatus = normalizeTaskSortStatus(left.status as AnalysisTaskStatus);
      const rightStatus = normalizeTaskSortStatus(right.status as AnalysisTaskStatus);
      if (leftStatus !== rightStatus) {
        return leftStatus - rightStatus;
      }

      if (left.status === AnalysisTaskStatus.pending) {
        const leftPriority = Number(left.priority ?? this.defaultPriority());
        const rightPriority = Number(right.priority ?? this.defaultPriority());
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        return new Date(String(left.created_at)).getTime() - new Date(String(right.created_at)).getTime();
      }

      if (left.status === AnalysisTaskStatus.processing) {
        return new Date(String(left.started_at ?? left.created_at)).getTime() - new Date(String(right.started_at ?? right.created_at)).getTime();
      }

      return new Date(String(right.created_at)).getTime() - new Date(String(left.created_at)).getTime();
    });
  }

  private async loadTaskWithScope(
    taskId: string,
    scope: RequesterScope,
  ): Promise<SchedulerTaskRow | null> {
    if (scope.includeAll) {
      return await this.prisma.analysisTask.findUnique({
        where: { taskId },
        include: {
          ownerUser: {
            select: { id: true, username: true, displayName: true },
          },
        },
      });
    }
    return await this.prisma.analysisTask.findFirst({
      where: { taskId, ownerUserId: scope.userId },
      include: {
        ownerUser: {
          select: { id: true, username: true, displayName: true },
        },
      },
    });
  }

  private async ensureNoActiveSiblingTask(task: {
    ownerUserId: number | null;
    stockCode: string;
    taskId: string;
  }): Promise<void> {
    if (!task.ownerUserId) {
      throw new Error('任务缺少 owner_user_id，无法重新入队');
    }

    const existing = await this.prisma.analysisTask.findFirst({
      where: {
        ownerUserId: task.ownerUserId,
        stockCode: task.stockCode,
        taskId: { not: task.taskId },
        status: {
          in: [AnalysisTaskStatus.pending, AnalysisTaskStatus.processing],
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      const error = new Error(`股票 ${task.stockCode} 正在分析中`);
      (error as Error & { code: string; stockCode: string; existingTaskId: string }).code = 'DUPLICATE_TASK';
      (error as Error & { code: string; stockCode: string; existingTaskId: string }).stockCode = task.stockCode;
      (error as Error & { code: string; stockCode: string; existingTaskId: string }).existingTaskId = existing.taskId;
      throw error;
    }
  }

  private async rebuildRequestPayload(task: {
    ownerUserId: number | null;
    stockCode: string;
    reportType: string;
    requestPayload: Prisma.JsonValue | null;
  }): Promise<Prisma.InputJsonValue> {
    if (!task.ownerUserId) {
      throw new Error('任务缺少 owner_user_id，无法重建请求');
    }
    const payload = asRecord(task.requestPayload);
    const forceRefresh = Boolean(payload?.force_refresh ?? false);
    const requestedMode = asString(
      asRecord(payload?.meta)?.requested_execution_mode ?? payload?.execution_mode ?? 'auto',
    ).toLowerCase() === 'paper'
      ? 'paper'
      : 'auto';
    const executionMeta = await this.analysisService.resolveExecutionPlan(task.ownerUserId, requestedMode);

    return {
      stock_code: task.stockCode,
      report_type: task.reportType,
      force_refresh: forceRefresh,
      async_mode: true,
      runtime_config: payload?.runtime_config ?? Prisma.JsonNull,
      meta: executionMeta as unknown as Prisma.InputJsonValue,
    };
  }

  private async createDerivedTask(
    source: SchedulerTaskRow,
    options: {
      mode: 'retry' | 'rerun';
      message: string;
    },
  ): Promise<Record<string, unknown>> {
    // retry / rerun 都会新建任务，避免覆盖原始记录并保留完整任务链供排障使用。
    await this.ensureNoActiveSiblingTask(source);
    const requestPayload = await this.rebuildRequestPayload(source);
    const taskId = randomUUID().replace(/-/g, '');

    const rootTaskId = options.mode === 'retry'
      ? source.rootTaskId ?? source.taskId
      : taskId;
    const attemptNo = options.mode === 'retry'
      ? Math.max(1, Number(source.attemptNo ?? 1)) + 1
      : 1;

    await this.prisma.analysisTask.create({
      data: {
        ownerUserId: source.ownerUserId,
        taskId,
        rootTaskId,
        retryOfTaskId: source.taskId,
        attemptNo,
        priority: source.priority || this.defaultPriority(),
        stockCode: source.stockCode,
        reportType: source.reportType,
        status: AnalysisTaskStatus.pending,
        progress: 0,
        message: options.message,
        requestPayload,
      },
    });

    return {
      task_id: taskId,
      root_task_id: rootTaskId,
      retry_of_task_id: source.taskId,
      attempt_no: attemptNo,
      status: 'pending',
      message: options.message,
    };
  }

  // 先按数据库字段过滤，再补 execution_mode / staleOnly 等派生条件，避免 JSON 查询过于脆弱。
  async listTasks(query: SchedulerTaskListQuery, scope: RequesterScope): Promise<Record<string, unknown>> {
    const page = Math.max(1, Number(query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
    const viewScope = normalizeScope(scope, query.scope);
    const statusList = normalizeStatusList(query.status);
    const startDate = parseDateInput(query.startDate, 'start');
    const endDate = parseDateInput(query.endDate, 'end');
    const stockCode = asString(query.stockCode).toUpperCase();
    const username = asString(query.username);
    const executionModeFilter = asString(query.executionMode).toLowerCase();

    const rows = await this.prisma.analysisTask.findMany({
      where: {
        ...this.buildOwnerWhere(scope, viewScope),
        ...(statusList.length > 0 ? { status: { in: statusList } } : {}),
        ...(stockCode ? { stockCode: { contains: stockCode } } : {}),
        ...(username && scope.includeAll && viewScope === 'all'
          ? {
              ownerUser: {
                username: {
                  contains: username,
                  mode: 'insensitive',
                },
              },
            }
          : {}),
        ...(startDate || endDate
          ? {
              createdAt: {
                ...(startDate ? { gte: startDate } : {}),
                ...(endDate ? { lte: endDate } : {}),
              },
            }
          : {}),
      },
      include: {
        ownerUser: {
          select: { id: true, username: true, displayName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    const now = new Date();
    const mapped = rows
      .map(row => this.mapTaskRow(row, now))
      .filter((item) => {
        if (executionModeFilter && item.execution_mode !== executionModeFilter) {
          return false;
        }
        if (query.staleOnly && !item.is_stale) {
          return false;
        }
        return true;
      });

    const sorted = this.sortTasks(mapped);
    const offset = (page - 1) * limit;
    const items = sorted.slice(offset, offset + limit);

    return {
      page,
      limit,
      total: sorted.length,
      items,
    };
  }

  async getTaskDetail(taskId: string, scope: RequesterScope): Promise<Record<string, unknown> | null> {
    const task = await this.loadTaskWithScope(taskId, scope);
    if (!task) {
      return null;
    }

    const rootTaskId = task.rootTaskId ?? task.taskId;
    const chainRows = await this.prisma.analysisTask.findMany({
      where: {
        OR: [
          { rootTaskId },
          { taskId: rootTaskId },
        ],
      },
      include: {
        ownerUser: {
          select: { id: true, username: true, displayName: true },
        },
      },
      orderBy: [
        { attemptNo: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    const payload = asRecord(task.resultPayload);
    return {
      task: this.mapTaskRow(task),
      request_payload: task.requestPayload,
      result_payload: task.resultPayload,
      bridge_meta: payload?.bridge_meta ?? null,
      auto_order: payload?.auto_order ?? null,
      task_chain: chainRows.map(row => this.mapTaskRow(row)),
    };
  }

  async getOverview(scope: RequesterScope, requestedScope?: string | null): Promise<Record<string, unknown>> {
    const viewScope = normalizeScope(scope, requestedScope);
    const rows = await this.prisma.analysisTask.findMany({
      where: this.buildOwnerWhere(scope, viewScope),
      select: {
        status: true,
        createdAt: true,
        startedAt: true,
        runAfter: true,
      },
      take: 1000,
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    let pendingCount = 0;
    let processingCount = 0;
    let failedCount = 0;
    let staleProcessingCount = 0;
    let oldestPendingWaitMs = 0;
    let completed24h = 0;
    let failed24h = 0;

    rows.forEach((row) => {
      if (row.status === AnalysisTaskStatus.pending) {
        pendingCount += 1;
        if (this.isTaskStale(row, now)) {
          oldestPendingWaitMs = Math.max(oldestPendingWaitMs, now.getTime() - row.createdAt.getTime());
        } else if (!row.runAfter || row.runAfter.getTime() <= now.getTime()) {
          oldestPendingWaitMs = Math.max(oldestPendingWaitMs, now.getTime() - row.createdAt.getTime());
        }
      }
      if (row.status === AnalysisTaskStatus.processing) {
        processingCount += 1;
        if (this.isTaskStale(row, now)) {
          staleProcessingCount += 1;
        }
      }
      if (row.status === AnalysisTaskStatus.failed) {
        failedCount += 1;
      }
      if (row.createdAt.getTime() >= windowStart.getTime()) {
        if (row.status === AnalysisTaskStatus.completed) {
          completed24h += 1;
        }
        if (row.status === AnalysisTaskStatus.failed) {
          failed24h += 1;
        }
      }
    });

    const denominator = completed24h + failed24h;
    const successRate24h = denominator > 0 ? Number(((completed24h / denominator) * 100).toFixed(2)) : null;

    return {
      pending_count: pendingCount,
      processing_count: processingCount,
      failed_count: failedCount,
      queue_depth: pendingCount + processingCount,
      success_rate_24h: successRate24h,
      completed_24h: completed24h,
      failed_24h: failed24h,
      oldest_pending_wait_ms: oldestPendingWaitMs,
      stale_processing_count: staleProcessingCount,
      updated_at: now.toISOString(),
    };
  }

  // health 同时聚合 Backend、Agent、Worker 心跳和队列指标，便于一个接口完成调度排障。
  async getHealth(): Promise<Record<string, unknown>> {
    const now = new Date();
    const heartbeat = await this.prisma.schedulerWorkerHeartbeat.findUnique({
      where: { workerName: 'analysis_task_worker' },
    });

    let backendReady = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      backendReady = true;
    } catch {
      backendReady = false;
    }

    let agentLive = false;
    let agentReady = false;
    let agentLiveError: string | null = null;
    let agentReadyError: string | null = null;

    try {
      const payload = await this.agentClient.getHealthLive();
      agentLive = asString(payload.status).toLowerCase() === 'ok';
    } catch (error: unknown) {
      agentLiveError = (error as Error).message || 'Agent live check failed';
    }

    try {
      const payload = await this.agentClient.getHealthReady();
      agentReady = asString(payload.status).toLowerCase() === 'ok';
    } catch (error: unknown) {
      agentReadyError = (error as Error).message || 'Agent ready check failed';
    }

    const workerHealthy = Boolean(
      heartbeat && (now.getTime() - heartbeat.lastSeenAt.getTime()) <= this.heartbeatTtlMs(),
    );
    const queueMetrics = await this.getOverview({ userId: 0, includeAll: true }, 'all');

    return {
      backend_ready: backendReady,
      agent_live: agentLive,
      agent_ready: agentReady,
      agent_live_error: agentLiveError,
      agent_ready_error: agentReadyError,
      worker_mode: heartbeat?.workerMode ?? this.workerMode(),
      worker_healthy: workerHealthy,
      worker_heartbeat: heartbeat
        ? {
            worker_name: heartbeat.workerName,
            worker_mode: heartbeat.workerMode,
            last_seen_at: heartbeat.lastSeenAt.toISOString(),
            last_task_id: heartbeat.lastTaskId,
            last_error: heartbeat.lastError,
          }
        : null,
      queue_metrics: queueMetrics,
      policy_snapshot: {
        run_worker_in_api: this.workerMode() === 'embedded',
        agent_task_poll_interval_ms: Math.max(200, Number(process.env.AGENT_TASK_POLL_INTERVAL_MS ?? '2000')),
        agent_task_poll_timeout_ms: Math.max(10_000, Number(process.env.AGENT_TASK_POLL_TIMEOUT_MS ?? '600000')),
        agent_task_poll_max_retries: Math.max(0, Number(process.env.AGENT_TASK_POLL_MAX_RETRIES ?? '3')),
        analysis_task_stale_timeout_ms: this.staleTimeoutMs(),
        scheduler_heartbeat_ttl_ms: this.heartbeatTtlMs(),
      },
      updated_at: now.toISOString(),
    };
  }

  // retry 仍然沿用原 rootTaskId，语义上表示“这次失败了，再试一次”。
  async retryTask(taskId: string, scope: RequesterScope): Promise<Record<string, unknown> | null> {
    const source = await this.loadTaskWithScope(taskId, scope);
    if (!source) {
      return null;
    }
    if (source.status !== AnalysisTaskStatus.failed) {
      const error = new Error('只有失败任务允许重试');
      (error as Error & { code: string }).code = 'INVALID_TASK_STATUS';
      throw error;
    }

    return await this.createDerivedTask(source, {
      mode: 'retry',
      message: `任务已重新加入队列: ${source.stockCode}`,
    });
  }

  // rerun 会开启新根任务链，语义上表示“把这只股票重新完整分析一遍”。
  async rerunTask(taskId: string, scope: RequesterScope): Promise<Record<string, unknown> | null> {
    const source = await this.loadTaskWithScope(taskId, scope);
    if (!source) {
      return null;
    }
    if (source.status !== AnalysisTaskStatus.completed && source.status !== AnalysisTaskStatus.failed) {
      const error = new Error('仅已完成或失败的任务允许重跑');
      (error as Error & { code: string }).code = 'INVALID_TASK_STATUS';
      throw error;
    }

    return await this.createDerivedTask(source, {
      mode: 'rerun',
      message: `任务已重新加入队列: ${source.stockCode}`,
    });
  }

  async cancelTask(taskId: string, scope: RequesterScope): Promise<Record<string, unknown> | null> {
    const source = await this.loadTaskWithScope(taskId, scope);
    if (!source) {
      return null;
    }
    if (source.status !== AnalysisTaskStatus.pending) {
      const error = new Error('仅排队中的任务允许取消');
      (error as Error & { code: string }).code = 'INVALID_TASK_STATUS';
      throw error;
    }

    const cancelledAt = new Date();
    await this.prisma.analysisTask.update({
      where: { id: source.id },
      data: {
        status: AnalysisTaskStatus.cancelled,
        progress: 100,
        message: '任务已取消',
        cancelledAt,
        completedAt: cancelledAt,
      },
    });

    return {
      task_id: source.taskId,
      status: 'cancelled',
      cancelled_at: cancelledAt.toISOString(),
    };
  }

  // 优先级只允许作用于 pending 任务，避免运行中的任务被外部请求突然插队。
  async updatePriority(
    taskId: string,
    priorityValue: unknown,
    scope: RequesterScope,
  ): Promise<Record<string, unknown> | null> {
    if (!scope.includeAll) {
      const error = new Error('只有管理员允许调整调度优先级');
      (error as Error & { code: string }).code = 'FORBIDDEN';
      throw error;
    }

    const priority = normalizePriority(priorityValue);
    if (priority == null) {
      const error = new Error('priority 必须是 1 到 9999 的整数');
      (error as Error & { code: string }).code = 'VALIDATION_ERROR';
      throw error;
    }

    const task = await this.prisma.analysisTask.findUnique({
      where: { taskId },
      include: {
        ownerUser: {
          select: { id: true, username: true, displayName: true },
        },
      },
    });
    if (!task) {
      return null;
    }
    if (task.status !== AnalysisTaskStatus.pending) {
      const error = new Error('仅排队中的任务允许调整优先级');
      (error as Error & { code: string }).code = 'INVALID_TASK_STATUS';
      throw error;
    }

    const updated = await this.prisma.analysisTask.update({
      where: { id: task.id },
      data: { priority },
      include: {
        ownerUser: {
          select: { id: true, username: true, displayName: true },
        },
      },
    });

    return {
      task: this.mapTaskRow(updated),
    };
  }

  // 心跳使用 upsert，确保 worker 首次上线和后续续命都落到同一条记录里。
  async updateWorkerHeartbeat(input: HeartbeatUpdateInput): Promise<void> {
    await this.prisma.schedulerWorkerHeartbeat.upsert({
      where: { workerName: input.workerName },
      update: {
        workerMode: input.workerMode,
        lastSeenAt: new Date(),
        lastTaskId: asString(input.lastTaskId) || null,
        lastError: asString(input.lastError).slice(0, 500) || null,
      },
      create: {
        workerName: input.workerName,
        workerMode: input.workerMode,
        lastSeenAt: new Date(),
        lastTaskId: asString(input.lastTaskId) || null,
        lastError: asString(input.lastError).slice(0, 500) || null,
      },
    });
  }
}
