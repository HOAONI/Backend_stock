import { Injectable } from '@nestjs/common';
import { AnalysisTaskStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '@/common/database/prisma.service';
import { canonicalStockCode } from '@/common/utils/stock-code';

import { AnalysisService, RequesterScope } from './analysis.service';

type PrismaTaskClient = PrismaService | Prisma.TransactionClient;
type ScheduleExecutionMode = 'auto' | 'paper';
type ScheduleLastTaskStatus = 'idle' | 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'skipped';

type ScheduleMutationInput = Record<string, unknown>;

type ScheduleRow = Prisma.AnalysisScheduleGetPayload<Record<string, never>>;
type ScheduleRunRow = Prisma.AnalysisTaskGetPayload<Record<string, never>>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeExecutionMode(value: unknown): ScheduleExecutionMode {
  return asString(value).toLowerCase() === 'paper' ? 'paper' : 'auto';
}

function normalizeIntervalMinutes(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10080) {
    return null;
  }
  return parsed;
}

function isValidStockCode(value: string): boolean {
  return [
    /^\d{6}$/,
    /^(SH|SZ)\d{6}$/,
    /^\d{5}$/,
    /^[A-Z]{1,6}(\.[A-Z]{1,2})?$/,
  ].some(pattern => pattern.test(value));
}

function safeMessage(value: unknown, max = 500): string | null {
  const text = asString(value);
  return text ? text.slice(0, max) : null;
}

function nextRunAtFrom(base: Date, intervalMinutes: number): Date {
  return new Date(base.getTime() + intervalMinutes * 60_000);
}

function hasProvidedField(value: unknown): boolean {
  return value !== undefined;
}

@Injectable()
export class AnalysisSchedulerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisService: AnalysisService,
  ) {}

  private scheduleOwnerWhere(scope: RequesterScope): Prisma.AnalysisScheduleWhereInput {
    return {
      ownerUserId: scope.userId,
    };
  }

  private normalizeScheduleInput(
    input: ScheduleMutationInput,
    options: { partial: boolean },
  ): {
    stockCode?: string;
    intervalMinutes?: number;
    executionMode?: ScheduleExecutionMode;
    enabled?: boolean;
  } {
    const normalized: {
      stockCode?: string;
      intervalMinutes?: number;
      executionMode?: ScheduleExecutionMode;
      enabled?: boolean;
    } = {};

    if (!options.partial || hasProvidedField(input.stock_code)) {
      const stockCode = canonicalStockCode(asString(input.stock_code));
      if (!stockCode) {
        const error = new Error('stock_code 不能为空');
        (error as Error & { code: string }).code = 'VALIDATION_ERROR';
        throw error;
      }
      if (!isValidStockCode(stockCode)) {
        const error = new Error('stock_code 格式不正确');
        (error as Error & { code: string }).code = 'VALIDATION_ERROR';
        throw error;
      }
      normalized.stockCode = stockCode;
    }

    if (!options.partial || hasProvidedField(input.interval_minutes)) {
      const intervalMinutes = normalizeIntervalMinutes(input.interval_minutes);
      if (intervalMinutes == null) {
        const error = new Error('interval_minutes 必须是 1 到 10080 的整数');
        (error as Error & { code: string }).code = 'VALIDATION_ERROR';
        throw error;
      }
      normalized.intervalMinutes = intervalMinutes;
    }

    if (!options.partial || hasProvidedField(input.execution_mode)) {
      normalized.executionMode = normalizeExecutionMode(input.execution_mode);
    }

    if (hasProvidedField(input.enabled)) {
      if (typeof input.enabled !== 'boolean') {
        const error = new Error('enabled 必须是布尔值');
        (error as Error & { code: string }).code = 'VALIDATION_ERROR';
        throw error;
      }
      normalized.enabled = input.enabled;
    }

    if (options.partial && Object.keys(normalized).length === 0) {
      const error = new Error('至少需要提供一个可更新字段');
      (error as Error & { code: string }).code = 'VALIDATION_ERROR';
      throw error;
    }

    return normalized;
  }

  private async findScheduleWithScope(
    scheduleId: string,
    scope: RequesterScope,
    client: PrismaTaskClient = this.prisma,
  ): Promise<ScheduleRow | null> {
    return await client.analysisSchedule.findFirst({
      where: {
        scheduleId,
        ...this.scheduleOwnerWhere(scope),
      },
    });
  }

  private async ensureNoDuplicateSchedule(
    input: {
      ownerUserId: number;
      stockCode: string;
      intervalMinutes: number;
      executionMode: ScheduleExecutionMode;
    },
    options?: {
      excludeScheduleId?: string | null;
      client?: PrismaTaskClient;
    },
  ): Promise<void> {
    const client = options?.client ?? this.prisma;
    const existing = await client.analysisSchedule.findFirst({
      where: {
        ownerUserId: input.ownerUserId,
        stockCode: input.stockCode,
        intervalMinutes: input.intervalMinutes,
        requestedExecutionMode: input.executionMode,
        ...(options?.excludeScheduleId
          ? {
              scheduleId: {
                not: options.excludeScheduleId,
              },
            }
          : {}),
      },
      select: {
        scheduleId: true,
      },
    });

    if (!existing) {
      return;
    }

    const error = new Error(`股票 ${input.stockCode} 的 ${input.intervalMinutes} 分钟 ${input.executionMode} 定时任务已存在`);
    (error as Error & { code: string }).code = 'DUPLICATE_SCHEDULE';
    throw error;
  }

  private mapScheduleRow(row: ScheduleRow): Record<string, unknown> {
    return {
      schedule_id: row.scheduleId,
      stock_code: row.stockCode,
      report_type: row.reportType,
      execution_mode: row.requestedExecutionMode,
      interval_minutes: row.intervalMinutes,
      enabled: row.enabled,
      next_run_at: row.nextRunAt.toISOString(),
      last_triggered_at: row.lastTriggeredAt?.toISOString() ?? null,
      last_task_id: row.lastTaskId,
      last_task_status: (row.lastTaskStatus as ScheduleLastTaskStatus | null) ?? 'idle',
      last_task_message: row.lastTaskMessage,
      last_completed_at: row.lastCompletedAt?.toISOString() ?? null,
      last_skipped_at: row.lastSkippedAt?.toISOString() ?? null,
      last_skipped_reason: row.lastSkippedReason,
      paused_at: row.pausedAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  private mapRunRow(row: ScheduleRunRow): Record<string, unknown> {
    const executionMeta = this.analysisService.resolveExecutionMetaFromPayload(row.requestPayload);
    return {
      task_id: row.taskId,
      schedule_id: row.scheduleId,
      root_task_id: row.rootTaskId ?? row.taskId,
      retry_of_task_id: row.retryOfTaskId,
      attempt_no: row.attemptNo,
      priority: row.priority,
      stock_code: row.stockCode,
      report_type: row.reportType,
      status: row.status,
      progress: row.progress,
      message: row.message,
      error: row.error,
      result_query_id: row.resultQueryId,
      execution_mode: executionMeta.execution_mode,
      requested_execution_mode: executionMeta.requested_execution_mode,
      created_at: row.createdAt.toISOString(),
      started_at: row.startedAt?.toISOString() ?? null,
      completed_at: row.completedAt?.toISOString() ?? null,
    };
  }

  async listSchedules(scope: RequesterScope): Promise<Record<string, unknown>> {
    const rows = await this.prisma.analysisSchedule.findMany({
      where: this.scheduleOwnerWhere(scope),
      orderBy: [
        { enabled: 'desc' },
        { nextRunAt: 'asc' },
        { updatedAt: 'desc' },
      ],
    });

    return {
      total: rows.length,
      items: rows.map(row => this.mapScheduleRow(row)),
    };
  }

  async createSchedule(input: ScheduleMutationInput, scope: RequesterScope): Promise<Record<string, unknown>> {
    const normalized = this.normalizeScheduleInput(input, { partial: false });
    const now = new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      await this.ensureNoDuplicateSchedule(
        {
          ownerUserId: scope.userId,
          stockCode: normalized.stockCode!,
          intervalMinutes: normalized.intervalMinutes!,
          executionMode: normalized.executionMode!,
        },
        { client: tx },
      );

      return await tx.analysisSchedule.create({
        data: {
          scheduleId: randomUUID().replace(/-/g, ''),
          ownerUserId: scope.userId,
          stockCode: normalized.stockCode!,
          reportType: 'detailed',
          requestedExecutionMode: normalized.executionMode!,
          intervalMinutes: normalized.intervalMinutes!,
          enabled: true,
          nextRunAt: now,
        },
      });
    });

    return {
      schedule: this.mapScheduleRow(created),
    };
  }

  async getScheduleDetail(scheduleId: string, scope: RequesterScope): Promise<Record<string, unknown> | null> {
    const schedule = await this.findScheduleWithScope(scheduleId, scope);
    if (!schedule) {
      return null;
    }

    const recentRuns = await this.prisma.analysisTask.findMany({
      where: {
        ownerUserId: scope.userId,
        scheduleId: schedule.scheduleId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 10,
    });

    return {
      schedule: this.mapScheduleRow(schedule),
      recent_runs: recentRuns.map(run => this.mapRunRow(run)),
    };
  }

  async updateSchedule(
    scheduleId: string,
    input: ScheduleMutationInput,
    scope: RequesterScope,
  ): Promise<Record<string, unknown> | null> {
    const current = await this.findScheduleWithScope(scheduleId, scope);
    if (!current) {
      return null;
    }

    const normalized = this.normalizeScheduleInput(input, { partial: true });
    const stockCode = normalized.stockCode ?? current.stockCode;
    const intervalMinutes = normalized.intervalMinutes ?? current.intervalMinutes;
    const executionMode = normalized.executionMode ?? (current.requestedExecutionMode as ScheduleExecutionMode);
    const enabled = normalized.enabled ?? current.enabled;
    const now = new Date();
    const configChanged = normalized.stockCode != null || normalized.intervalMinutes != null || normalized.executionMode != null;
    const resumed = current.enabled === false && enabled === true;

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.ensureNoDuplicateSchedule(
        {
          ownerUserId: scope.userId,
          stockCode,
          intervalMinutes,
          executionMode,
        },
        {
          excludeScheduleId: current.scheduleId,
          client: tx,
        },
      );

      return await tx.analysisSchedule.update({
        where: {
          scheduleId: current.scheduleId,
        },
        data: {
          stockCode,
          intervalMinutes,
          requestedExecutionMode: executionMode,
          enabled,
          nextRunAt: enabled && (configChanged || resumed) ? now : current.nextRunAt,
          pausedAt: enabled ? null : (normalized.enabled === false ? now : current.pausedAt),
        },
      });
    });

    return {
      schedule: this.mapScheduleRow(updated),
    };
  }

  async deleteSchedule(scheduleId: string, scope: RequesterScope): Promise<Record<string, unknown> | null> {
    const current = await this.findScheduleWithScope(scheduleId, scope);
    if (!current) {
      return null;
    }

    await this.prisma.analysisSchedule.delete({
      where: {
        scheduleId: current.scheduleId,
      },
    });

    return {
      schedule_id: current.scheduleId,
    };
  }

  async recordScheduleTaskState(input: {
    scheduleId: string;
    taskId: string;
    status: Exclude<ScheduleLastTaskStatus, 'idle' | 'skipped'>;
    message?: string | null;
    completedAt?: Date | null;
  }): Promise<void> {
    const data: Prisma.AnalysisScheduleUpdateManyMutationInput = {
      lastTaskStatus: input.status,
      lastTaskMessage: safeMessage(input.message),
      lastSkippedAt: null,
      lastSkippedReason: null,
    };

    if (input.status === 'completed') {
      data.lastCompletedAt = input.completedAt ?? new Date();
    }

    await this.prisma.analysisSchedule.updateMany({
      where: {
        scheduleId: input.scheduleId,
        lastTaskId: input.taskId,
      },
      data,
    });
  }

  async triggerNextDueSchedule(): Promise<boolean> {
    const now = new Date();
    const candidate = await this.prisma.analysisSchedule.findFirst({
      where: {
        enabled: true,
        nextRunAt: {
          lte: now,
        },
      },
      orderBy: [
        { nextRunAt: 'asc' },
        { updatedAt: 'asc' },
      ],
    });

    if (!candidate) {
      return false;
    }

    return await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.analysisSchedule.updateMany({
        where: {
          id: candidate.id,
          enabled: true,
          nextRunAt: candidate.nextRunAt,
        },
        data: {
          nextRunAt: nextRunAtFrom(now, candidate.intervalMinutes),
        },
      });

      if (claimed.count === 0) {
        return false;
      }

      const activeTask = await this.analysisService.findActiveTaskForOwnerStock(candidate.ownerUserId, candidate.stockCode, {
        client: tx,
      });

      if (activeTask) {
        const skippedMessage = `股票 ${candidate.stockCode} 已有进行中的任务 ${activeTask.taskId}，本轮跳过`;
        await tx.analysisSchedule.update({
          where: { scheduleId: candidate.scheduleId },
          data: {
            lastTriggeredAt: now,
            lastTaskId: activeTask.taskId,
            lastTaskStatus: 'skipped',
            lastTaskMessage: skippedMessage,
            lastSkippedAt: now,
            lastSkippedReason: 'active_task_exists',
          },
        });
        return true;
      }

      try {
        const payload = await this.analysisService.buildAsyncTaskPayload({
          stockCode: candidate.stockCode,
          reportType: candidate.reportType,
          forceRefresh: false,
          userId: candidate.ownerUserId,
          executionMode: candidate.requestedExecutionMode as ScheduleExecutionMode,
        });
        const queued = await this.analysisService.createPendingAnalysisTask({
          stockCode: candidate.stockCode,
          reportType: candidate.reportType,
          forceRefresh: false,
          userId: candidate.ownerUserId,
          executionMode: candidate.requestedExecutionMode as ScheduleExecutionMode,
          scheduleId: candidate.scheduleId,
          client: tx,
          requestPayload: payload.requestPayload,
          message: '定时任务已触发，任务已加入队列',
        });

        await tx.analysisSchedule.update({
          where: { scheduleId: candidate.scheduleId },
          data: {
            lastTriggeredAt: now,
            lastTaskId: queued.taskId,
            lastTaskStatus: 'pending',
            lastTaskMessage: safeMessage(queued.message),
            lastSkippedAt: null,
            lastSkippedReason: null,
          },
        });
      } catch (error: unknown) {
        const failed = await this.analysisService.createFailedAnalysisTask({
          stockCode: candidate.stockCode,
          reportType: candidate.reportType,
          userId: candidate.ownerUserId,
          executionMode: candidate.requestedExecutionMode as ScheduleExecutionMode,
          scheduleId: candidate.scheduleId,
          errorMessage: (error as Error).message || '定时任务触发失败',
          message: '定时任务触发失败',
          client: tx,
        });

        await tx.analysisSchedule.update({
          where: { scheduleId: candidate.scheduleId },
          data: {
            lastTriggeredAt: now,
            lastTaskId: failed.taskId,
            lastTaskStatus: 'failed',
            lastTaskMessage: safeMessage((error as Error).message || failed.message),
            lastSkippedAt: null,
            lastSkippedReason: null,
          },
        });
      }

      return true;
    });
  }
}
