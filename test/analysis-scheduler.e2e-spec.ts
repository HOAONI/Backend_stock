/** 定时任务中心单测，覆盖 CRUD、冲突拦截、到期触发与状态回写。 */

import { AnalysisSchedulerService } from '../src/modules/analysis/analysis-scheduler.service';
import { UpdateAnalysisScheduleDto } from '../src/modules/analysis/analysis.dto';

jest.mock('node:crypto', () => ({
  randomUUID: jest.fn(() => 'schedule-uuid-0001'),
}));

describe('AnalysisSchedulerService', () => {
  const scopeMine = { userId: 7, includeAll: false };

  const makeSchedule = (overrides: Record<string, unknown> = {}) => ({
    id: 11,
    scheduleId: 'schedule-source',
    ownerUserId: 7,
    stockCode: '600519',
    reportType: 'detailed',
    requestedExecutionMode: 'auto',
    intervalMinutes: 15,
    enabled: true,
    nextRunAt: new Date('2026-03-20T10:00:00.000Z'),
    lastTriggeredAt: null,
    lastTaskId: null,
    lastTaskStatus: null,
    lastTaskMessage: null,
    lastCompletedAt: null,
    lastSkippedAt: null,
    lastSkippedReason: null,
    pausedAt: null,
    createdAt: new Date('2026-03-20T09:00:00.000Z'),
    updatedAt: new Date('2026-03-20T09:00:00.000Z'),
    ...overrides,
  });

  const createService = () => {
    const prisma = {
      analysisSchedule: {
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }) => makeSchedule(data)),
        update: jest.fn(async ({ data, where }) => makeSchedule({
          ...data,
          scheduleId: where?.scheduleId ?? 'schedule-source',
          updatedAt: new Date('2026-03-20T10:01:00.000Z'),
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
        delete: jest.fn(async () => ({})),
      },
      analysisTask: {
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      $transaction: jest.fn(async (callback: (client: any) => unknown) => await callback(prisma)),
    } as any;

    const analysisService = {
      findActiveTaskForOwnerStock: jest.fn(async () => null),
      buildAsyncTaskPayload: jest.fn(async () => ({
        requestPayload: { meta: { execution_mode: 'paper', requested_execution_mode: 'auto' } },
      })),
      createPendingAnalysisTask: jest.fn(async () => ({
        taskId: 'scheduleuuid0001',
        status: 'pending',
        message: '定时任务已触发，任务已加入队列',
      })),
      createFailedAnalysisTask: jest.fn(async () => ({
        taskId: 'scheduleuuid0001',
        status: 'failed',
        message: '定时任务触发失败',
      })),
      resolveExecutionMetaFromPayload: jest.fn(() => ({
        execution_mode: 'paper',
        requested_execution_mode: 'auto',
      })),
    } as any;

    const service = new AnalysisSchedulerService(prisma, analysisService);
    return { prisma, analysisService, service };
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('creates schedule with immediate next run and enabled state', async () => {
    const { prisma, service } = createService();

    const result = await service.createSchedule({
      stock_code: '600519',
      interval_minutes: 15,
      execution_mode: 'auto',
    }, scopeMine);

    expect(prisma.analysisSchedule.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        ownerUserId: 7,
        stockCode: '600519',
        intervalMinutes: 15,
        requestedExecutionMode: 'auto',
        enabled: true,
        nextRunAt: expect.any(Date),
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      schedule: expect.objectContaining({
        stock_code: '600519',
        interval_minutes: 15,
        execution_mode: 'auto',
        enabled: true,
      }),
    }));
  });

  it('rejects duplicate schedule configs for the same user', async () => {
    const { prisma, service } = createService();
    prisma.analysisSchedule.findFirst.mockResolvedValueOnce(makeSchedule());

    await expect(service.createSchedule({
      stock_code: '600519',
      interval_minutes: 15,
      execution_mode: 'auto',
    }, scopeMine)).rejects.toMatchObject({
      code: 'DUPLICATE_SCHEDULE',
    });
  });

  it('resets next run immediately when a paused schedule is resumed', async () => {
    const { prisma, service } = createService();
    prisma.analysisSchedule.findFirst
      .mockResolvedValueOnce(makeSchedule({ enabled: false, pausedAt: new Date('2026-03-20T09:30:00.000Z') }))
      .mockResolvedValueOnce(null);

    const result = await service.updateSchedule('schedule-source', { enabled: true }, scopeMine);

    expect(prisma.analysisSchedule.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { scheduleId: 'schedule-source' },
      data: expect.objectContaining({
        enabled: true,
        nextRunAt: expect.any(Date),
        pausedAt: null,
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      schedule: expect.objectContaining({
        enabled: true,
      }),
    }));
  });

  it('supports enabled-only dto patch payload without requiring stock_code', async () => {
    const { prisma, service } = createService();
    prisma.analysisSchedule.findFirst
      .mockResolvedValueOnce(makeSchedule())
      .mockResolvedValueOnce(null);

    const payload = new UpdateAnalysisScheduleDto();
    payload.enabled = false;

    const result = await service.updateSchedule('schedule-source', payload as unknown as Record<string, unknown>, scopeMine);

    expect(prisma.analysisSchedule.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { scheduleId: 'schedule-source' },
      data: expect.objectContaining({
        enabled: false,
        pausedAt: expect.any(Date),
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      schedule: expect.objectContaining({
        enabled: false,
      }),
    }));
  });

  it('marks due schedule as skipped when the same stock already has an active task', async () => {
    const { prisma, analysisService, service } = createService();
    prisma.analysisSchedule.findFirst.mockResolvedValueOnce(makeSchedule());
    analysisService.findActiveTaskForOwnerStock.mockResolvedValueOnce({
      id: 101,
      taskId: 'task-active',
      status: 'processing',
      createdAt: new Date('2026-03-20T09:59:00.000Z'),
    });

    const processed = await service.triggerNextDueSchedule();

    expect(processed).toBe(true);
    expect(prisma.analysisSchedule.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { scheduleId: 'schedule-source' },
      data: expect.objectContaining({
        lastTaskId: 'task-active',
        lastTaskStatus: 'skipped',
        lastSkippedReason: 'active_task_exists',
      }),
    }));
    expect(analysisService.createPendingAnalysisTask).not.toHaveBeenCalled();
  });

  it('creates a linked failed task when schedule trigger preparation fails', async () => {
    const { prisma, analysisService, service } = createService();
    prisma.analysisSchedule.findFirst.mockResolvedValueOnce(makeSchedule());
    analysisService.buildAsyncTaskPayload.mockRejectedValueOnce(new Error('simulation account unavailable'));

    const processed = await service.triggerNextDueSchedule();

    expect(processed).toBe(true);
    expect(analysisService.createFailedAnalysisTask).toHaveBeenCalledWith(expect.objectContaining({
      stockCode: '600519',
      scheduleId: 'schedule-source',
      errorMessage: 'simulation account unavailable',
      client: prisma,
    }));
    expect(prisma.analysisSchedule.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lastTaskStatus: 'failed',
      }),
    }));
  });

  it('updates linked schedule state only for the most recent task id', async () => {
    const { prisma, service } = createService();

    await service.recordScheduleTaskState({
      scheduleId: 'schedule-source',
      taskId: 'task-123',
      status: 'completed',
      message: '分析完成',
      completedAt: new Date('2026-03-20T10:05:00.000Z'),
    });

    expect(prisma.analysisSchedule.updateMany).toHaveBeenCalledWith({
      where: {
        scheduleId: 'schedule-source',
        lastTaskId: 'task-123',
      },
      data: {
        lastTaskStatus: 'completed',
        lastTaskMessage: '分析完成',
        lastSkippedAt: null,
        lastSkippedReason: null,
        lastCompletedAt: new Date('2026-03-20T10:05:00.000Z'),
      },
    });
  });
});
