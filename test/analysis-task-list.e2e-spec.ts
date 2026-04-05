/** 分析任务列表单测，确保 owner 维度的任务聚合与状态计数返回稳定。 */

import { AnalysisTaskStatus } from '@prisma/client';

import { AnalysisService } from '../src/modules/analysis/analysis.service';

describe('AnalysisService.getTaskList', () => {
  // 任务列表逻辑只依赖 analysisTask 读接口，用最小 Prisma mock 即可覆盖核心聚合行为。
  const createService = (overrides?: {
    findMany?: jest.Mock;
    groupBy?: jest.Mock;
  }): AnalysisService => {
    const prisma = {
      analysisTask: {
        findMany: overrides?.findMany ?? jest.fn(async () => []),
        groupBy: overrides?.groupBy ?? jest.fn(async () => []),
      },
    } as any;

    return new AnalysisService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
  };

  it('returns owner-scoped counts and keeps recently completed tasks ahead of newer-created running tasks', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([
        {
          taskId: 'task-running',
          stockCode: '600111',
          reportType: 'detailed',
          status: AnalysisTaskStatus.processing,
          progress: 10,
          message: '正在分析中...',
          error: null,
          ownerUserId: 7,
          createdAt: new Date('2026-03-07T10:00:20.000Z'),
          startedAt: new Date('2026-03-07T10:00:25.000Z'),
          completedAt: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          taskId: 'task-completed-late',
          stockCode: '600519',
          reportType: 'detailed',
          status: AnalysisTaskStatus.completed,
          progress: 100,
          message: '分析完成',
          error: null,
          ownerUserId: 7,
          createdAt: new Date('2026-03-07T09:50:00.000Z'),
          startedAt: new Date('2026-03-07T09:50:03.000Z'),
          completedAt: new Date('2026-03-07T10:00:30.000Z'),
        },
      ]);
    const groupBy = jest.fn(async () => [
      { status: AnalysisTaskStatus.pending, _count: 2 },
      { status: AnalysisTaskStatus.processing, _count: 1 },
      { status: AnalysisTaskStatus.completed, _count: 5 },
      { status: AnalysisTaskStatus.failed, _count: 3 },
      { status: AnalysisTaskStatus.cancelled, _count: 4 },
    ]);
    const service = createService({ findMany, groupBy });

    const result = await service.getTaskList(null, 20, { userId: 7, includeAll: false });

    expect(findMany).toHaveBeenNthCalledWith(1, {
      where: {
        ownerUserId: 7,
        status: {
          in: [AnalysisTaskStatus.pending, AnalysisTaskStatus.processing],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    expect(findMany).toHaveBeenNthCalledWith(2, {
      where: {
        ownerUserId: 7,
        status: {
          in: [AnalysisTaskStatus.completed, AnalysisTaskStatus.failed, AnalysisTaskStatus.cancelled],
        },
      },
      orderBy: [
        { completedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      take: 20,
    });
    expect(groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { ownerUserId: 7 },
      _count: true,
    });
    expect(result).toEqual({
      total: 15,
      pending: 2,
      processing: 1,
      completed: 5,
      failed: 3,
      cancelled: 4,
      tasks: [
        {
          task_id: 'task-completed-late',
          stock_code: '600519',
          stock_name: null,
          status: AnalysisTaskStatus.completed,
          progress: 100,
          message: '分析完成',
          report_type: 'detailed',
          created_at: '2026-03-07T09:50:00.000Z',
          started_at: '2026-03-07T09:50:03.000Z',
          completed_at: '2026-03-07T10:00:30.000Z',
          error: null,
          owner_user_id: 7,
        },
        {
          task_id: 'task-running',
          stock_code: '600111',
          stock_name: null,
          status: AnalysisTaskStatus.processing,
          progress: 10,
          message: '正在分析中...',
          report_type: 'detailed',
          created_at: '2026-03-07T10:00:20.000Z',
          started_at: '2026-03-07T10:00:25.000Z',
          completed_at: null,
          error: null,
          owner_user_id: 7,
        },
      ],
    });
  });

  it('uses completed time ordering when only terminal statuses are requested', async () => {
    const findMany = jest.fn(async () => [
      {
        taskId: 'task-failed',
        stockCode: '600123',
        reportType: 'detailed',
        status: AnalysisTaskStatus.failed,
        progress: 100,
        message: '分析失败',
        error: 'boom',
        ownerUserId: 7,
        createdAt: new Date('2026-03-07T10:00:00.000Z'),
        startedAt: new Date('2026-03-07T10:00:05.000Z'),
        completedAt: new Date('2026-03-07T10:02:00.000Z'),
      },
    ]);
    const groupBy = jest.fn(async () => []);
    const service = createService({ findMany, groupBy });

    await service.getTaskList('failed', 5, { userId: 7, includeAll: false });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        ownerUserId: 7,
        status: {
          in: [AnalysisTaskStatus.failed],
        },
      },
      orderBy: [
        { completedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      take: 5,
    });
  });
});
