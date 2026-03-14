import { AnalysisTaskStatus } from '@prisma/client';

import { AnalysisService } from '../src/modules/analysis/analysis.service';

describe('AnalysisService.getTaskList', () => {
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

    return new AnalysisService(prisma, {} as any, {} as any, {} as any, {} as any);
  };

  it('returns completed failed cancelled counts from owner-scoped aggregates', async () => {
    const findMany = jest.fn(async () => [
      {
        taskId: 'task-1',
        stockCode: '600519',
        reportType: 'detailed',
        status: AnalysisTaskStatus.completed,
        progress: 100,
        message: '分析完成',
        error: null,
        ownerUserId: 7,
        createdAt: new Date('2026-03-07T10:00:00.000Z'),
        startedAt: new Date('2026-03-07T10:00:03.000Z'),
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

    expect(findMany).toHaveBeenCalledWith({
      where: { ownerUserId: 7 },
      orderBy: { createdAt: 'desc' },
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
          task_id: 'task-1',
          stock_code: '600519',
          stock_name: null,
          status: AnalysisTaskStatus.completed,
          progress: 100,
          message: '分析完成',
          report_type: 'detailed',
          created_at: '2026-03-07T10:00:00.000Z',
          started_at: '2026-03-07T10:00:03.000Z',
          completed_at: '2026-03-07T10:00:30.000Z',
          error: null,
          owner_user_id: 7,
        },
      ],
    });
  });
});
