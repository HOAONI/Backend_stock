import { AnalysisTaskStatus } from '@prisma/client';

import { TaskWorkerService } from '../src/common/worker/task-worker.service';

describe('TaskWorkerService stale processing recovery', () => {
  const previousTimeout = process.env.ANALYSIS_TASK_STALE_TIMEOUT_MS;

  const createService = (overrides?: {
    findMany?: jest.Mock;
    updateMany?: jest.Mock;
    triggerNextDueSchedule?: jest.Mock;
    recordScheduleTaskState?: jest.Mock;
    updateWorkerHeartbeat?: jest.Mock;
  }) => {
    const prisma = {
      analysisTask: {
        findMany: overrides?.findMany ?? jest.fn(async () => []),
        updateMany: overrides?.updateMany ?? jest.fn(async () => ({ count: 0 })),
      },
    } as any;

    const analysisSchedulerService = {
      triggerNextDueSchedule: overrides?.triggerNextDueSchedule ?? jest.fn(async () => false),
      recordScheduleTaskState: overrides?.recordScheduleTaskState ?? jest.fn(async () => undefined),
    } as any;

    const schedulerHeartbeatService = {
      updateWorkerHeartbeat: overrides?.updateWorkerHeartbeat ?? jest.fn(async () => undefined),
    } as any;

    const service = new TaskWorkerService(
      prisma,
      {} as any,
      {} as any,
      analysisSchedulerService,
      schedulerHeartbeatService,
      {} as any,
    );

    return {
      service,
      prisma,
      analysisSchedulerService,
      schedulerHeartbeatService,
    };
  };

  beforeEach(() => {
    process.env.ANALYSIS_TASK_STALE_TIMEOUT_MS = '900000';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    if (previousTimeout == null) {
      delete process.env.ANALYSIS_TASK_STALE_TIMEOUT_MS;
    } else {
      process.env.ANALYSIS_TASK_STALE_TIMEOUT_MS = previousTimeout;
    }
  });

  it('recovers stale processing tasks as failed and syncs schedule state', async () => {
    const findMany = jest.fn(async () => [
      {
        id: 61,
        taskId: '8fb6735087994351b055237df16e07ed',
        scheduleId: 'schedule-1',
        startedAt: new Date('2026-03-20T08:24:04.177Z'),
        resultPayload: {
          bridge_meta: {
            agent_task_id: 'agent-task-1',
          },
        },
      },
    ]);
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const recordScheduleTaskState = jest.fn(async () => undefined);
    const { service } = createService({
      findMany,
      updateMany,
      recordScheduleTaskState,
    });
    const now = new Date('2026-03-24T06:00:00.000Z');
    const cutoff = new Date('2026-03-24T05:45:00.000Z');

    const recovered = await (service as any).recoverStaleProcessingTasks(now);

    expect(recovered).toBe(true);

    const findManyArgs = (findMany.mock.calls.at(0)?.at(0) ?? null) as unknown as Record<string, any>;
    expect(findManyArgs.where.status).toBe(AnalysisTaskStatus.processing);
    expect(findManyArgs.where.completedAt).toBeNull();
    expect(findManyArgs.where.startedAt.lte.toISOString()).toBe(cutoff.toISOString());
    expect(findManyArgs.orderBy).toEqual({ startedAt: 'asc' });

    const updateManyArgs = (updateMany.mock.calls.at(0)?.at(0) ?? null) as unknown as Record<string, any>;
    expect(updateManyArgs.where).toMatchObject({
      id: 61,
      status: AnalysisTaskStatus.processing,
      completedAt: null,
    });
    expect(updateManyArgs.where.startedAt.lte.toISOString()).toBe(cutoff.toISOString());
    expect(updateManyArgs.data).toMatchObject({
      status: AnalysisTaskStatus.failed,
      progress: 100,
      message: '分析失败(task_stale_timeout): 任务执行超时或 worker 已中断',
      error: '[task_stale_timeout] 任务执行超时或 worker 已中断',
      resultPayload: {
        bridge_meta: {
          agent_task_id: 'agent-task-1',
        },
        error: {
          code: 'task_stale_timeout',
          message: '任务执行超时或 worker 已中断',
        },
      },
    });
    expect(updateManyArgs.data.completedAt.toISOString()).toBe(now.toISOString());
    expect(updateManyArgs.data.updatedAt.toISOString()).toBe(now.toISOString());

    expect(recordScheduleTaskState).toHaveBeenCalledWith({
      scheduleId: 'schedule-1',
      taskId: '8fb6735087994351b055237df16e07ed',
      status: 'failed',
      message: '分析失败(task_stale_timeout): 任务执行超时或 worker 已中断',
      completedAt: now,
    });
  });

  it('does not recover processing tasks when none exceed the stale timeout', async () => {
    const findMany = jest.fn(async () => []);
    const updateMany = jest.fn(async () => ({ count: 0 }));
    const recordScheduleTaskState = jest.fn(async () => undefined);
    const { service } = createService({
      findMany,
      updateMany,
      recordScheduleTaskState,
    });

    const recovered = await (service as any).recoverStaleProcessingTasks(new Date('2026-03-24T06:00:00.000Z'));

    expect(recovered).toBe(false);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();
    expect(recordScheduleTaskState).not.toHaveBeenCalled();
  });

  it('skips schedule sync when the stale task was already updated elsewhere', async () => {
    const findMany = jest.fn(async () => [
      {
        id: 62,
        taskId: 'task-concurrent-1',
        scheduleId: 'schedule-2',
        startedAt: new Date('2026-03-20T08:24:04.177Z'),
        resultPayload: null,
      },
    ]);
    const updateMany = jest.fn(async () => ({ count: 0 }));
    const recordScheduleTaskState = jest.fn(async () => undefined);
    const { service } = createService({
      findMany,
      updateMany,
      recordScheduleTaskState,
    });

    const recovered = await (service as any).recoverStaleProcessingTasks(new Date('2026-03-24T06:00:00.000Z'));

    expect(recovered).toBe(false);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(recordScheduleTaskState).not.toHaveBeenCalled();
  });
});
