/** 调度中心单测，覆盖 retry/rerun/cancel/priority/heartbeat 与 worker 抢任务规则。 */

import { AnalysisTaskStatus } from '@prisma/client';

import { TaskWorkerService } from '../src/common/worker/task-worker.service';
import { AnalysisSchedulerService } from '../src/modules/analysis/analysis-scheduler.service';

jest.mock('node:crypto', () => ({
  randomUUID: jest.fn(() => 'scheduler-uuid-0001'),
}));

describe('Analysis scheduler behavior', () => {
  const scopeMine = { userId: 7, includeAll: false };
  const scopeAdmin = { userId: 1, includeAll: true };

  // 用统一任务骨架构造不同状态的样本，避免每条用例都重复拼大段调度字段。
  const makeTask = (overrides: Record<string, unknown> = {}) => ({
    id: 11,
    taskId: 'task-source',
    rootTaskId: 'root-source',
    retryOfTaskId: null,
    attemptNo: 1,
    priority: 100,
    runAfter: null,
    cancelledAt: null,
    ownerUserId: 7,
    stockCode: '600519',
    reportType: 'detailed',
    status: AnalysisTaskStatus.failed,
    progress: 100,
    message: 'failed',
    resultQueryId: null,
    error: 'boom',
    createdAt: new Date('2026-03-07T10:00:00.000Z'),
    startedAt: new Date('2026-03-07T10:00:05.000Z'),
    completedAt: new Date('2026-03-07T10:01:00.000Z'),
    updatedAt: new Date('2026-03-07T10:01:00.000Z'),
    requestPayload: {
      force_refresh: false,
      runtime_config: {
        account: {
          account_name: 'user-7',
        },
      },
      meta: {
        execution_mode: 'paper',
        requested_execution_mode: 'auto',
      },
    },
    resultPayload: null,
    ownerUser: {
      id: 7,
      username: 'user7',
      displayName: '用户七',
    },
    ...overrides,
  });

  // 通过可覆写的 prisma mock，把每条用例真正关心的查询/更新动作单独拉出来断言。
  const createSchedulerService = (overrides?: {
    findFirst?: jest.Mock;
    findUnique?: jest.Mock;
    create?: jest.Mock;
    update?: jest.Mock;
    findMany?: jest.Mock;
    upsert?: jest.Mock;
  }) => {
    const prisma = {
      analysisTask: {
        findFirst: overrides?.findFirst ?? jest.fn(),
        findUnique: overrides?.findUnique ?? jest.fn(),
        create: overrides?.create ?? jest.fn(async () => ({})),
        update: overrides?.update ?? jest.fn(async () => ({})),
        findMany: overrides?.findMany ?? jest.fn(async () => []),
      },
      schedulerWorkerHeartbeat: {
        findUnique: jest.fn(async () => null),
        upsert: overrides?.upsert ?? jest.fn(async () => ({})),
      },
      $queryRaw: jest.fn(async () => [{ '?column?': 1 }]),
    } as any;

    const agentClient = {
      getHealthLive: jest.fn(async () => ({ status: 'ok' })),
      getHealthReady: jest.fn(async () => ({ status: 'ok' })),
    } as any;

    const analysisService = {
      resolveExecutionPlan: jest.fn(async () => ({
        execution_mode: 'broker',
        requested_execution_mode: 'auto',
        broker_account_id: 7,
        auto_order_enabled: true,
        broker_plan_reason: 'agent_execute_backtrader_local',
      })),
    } as any;

    const service = new AnalysisSchedulerService(prisma, agentClient, analysisService);
    return { prisma, analysisService, agentClient, service };
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('creates retry task on the same root chain with incremented attempt', async () => {
    const sourceTask = makeTask();
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(sourceTask)
      .mockResolvedValueOnce(null);
    const create = jest.fn(async () => ({}));

    const { analysisService, service } = createSchedulerService({
      findFirst,
      create,
    });

    const result = await service.retryTask('task-source', scopeMine);

    expect(analysisService.resolveExecutionPlan).toHaveBeenCalledWith(7, 'auto');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        taskId: 'scheduleruuid0001',
        rootTaskId: 'root-source',
        retryOfTaskId: 'task-source',
        attemptNo: 2,
        priority: 100,
        status: AnalysisTaskStatus.pending,
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      task_id: 'scheduleruuid0001',
      root_task_id: 'root-source',
      retry_of_task_id: 'task-source',
      attempt_no: 2,
      status: 'pending',
    }));
  });

  it('creates rerun task as a new root chain', async () => {
    const sourceTask = makeTask({
      status: AnalysisTaskStatus.completed,
      attemptNo: 4,
      rootTaskId: 'root-old',
    });
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(sourceTask)
      .mockResolvedValueOnce(null);
    const create = jest.fn(async () => ({}));

    const { service } = createSchedulerService({
      findFirst,
      create,
    });

    const result = await service.rerunTask('task-source', scopeMine);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        taskId: 'scheduleruuid0001',
        rootTaskId: 'scheduleruuid0001',
        retryOfTaskId: 'task-source',
        attemptNo: 1,
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      task_id: 'scheduleruuid0001',
      root_task_id: 'scheduleruuid0001',
      attempt_no: 1,
      status: 'pending',
    }));
  });

  it('cancels pending task only', async () => {
    const pendingTask = makeTask({
      status: AnalysisTaskStatus.pending,
      message: '任务已加入队列',
      startedAt: null,
      completedAt: null,
    });
    const findFirst = jest.fn().mockResolvedValueOnce(pendingTask);
    const update = jest.fn(async () => ({}));

    const { service } = createSchedulerService({
      findFirst,
      update,
    });

    const result = await service.cancelTask('task-source', scopeMine);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 11 },
      data: expect.objectContaining({
        status: AnalysisTaskStatus.cancelled,
        message: '任务已取消',
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      task_id: 'task-source',
      status: 'cancelled',
    }));
  });

  it('rejects priority changes for non-admin callers', async () => {
    const { service } = createSchedulerService();

    await expect(service.updatePriority('task-source', 5, scopeMine)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('updates priority for admin on pending task', async () => {
    const pendingTask = makeTask({
      status: AnalysisTaskStatus.pending,
      startedAt: null,
      completedAt: null,
    });
    const findUnique = jest.fn().mockResolvedValueOnce(pendingTask);
    const update = jest.fn(async () => ({
      ...pendingTask,
      priority: 5,
    }));

    const { service } = createSchedulerService({
      findUnique,
      update,
    });

    const result = await service.updatePriority('task-source', 5, scopeAdmin);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 11 },
      data: { priority: 5 },
    }));
    expect(result).toEqual(expect.objectContaining({
      task: expect.objectContaining({
        task_id: 'task-source',
        priority: 5,
      }),
    }));
  });

  it('updates worker heartbeat through upsert', async () => {
    const upsert = jest.fn(async () => ({}));
    const { service } = createSchedulerService({ upsert });

    await service.updateWorkerHeartbeat({
      workerName: 'analysis_task_worker',
      workerMode: 'external',
      lastTaskId: 'task-source',
      lastError: 'boom',
    });

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workerName: 'analysis_task_worker' },
      update: expect.objectContaining({
        workerMode: 'external',
        lastTaskId: 'task-source',
        lastError: 'boom',
      }),
    }));
  });

  it('picks pending tasks by priority and runAfter in worker loop', async () => {
    const prisma = {
      analysisTask: {
        findFirst: jest.fn(async () => null),
      },
    } as any;
    const heartbeatService = {
      updateWorkerHeartbeat: jest.fn(async () => undefined),
    } as any;

    const worker = new TaskWorkerService(
      prisma,
      {} as any,
      {} as any,
      heartbeatService,
      {} as any,
    );

    await (worker as any).processOne();

    expect(prisma.analysisTask.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: AnalysisTaskStatus.pending,
        OR: [
          { runAfter: null },
          { runAfter: { lte: expect.any(Date) } },
        ],
      }),
      orderBy: [
        { priority: 'asc' },
        { createdAt: 'asc' },
      ],
    }));
  });
});
