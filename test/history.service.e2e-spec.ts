import { AnalysisTaskStatus } from '@prisma/client';

import { HistoryService } from '../src/modules/history/history.service';

describe('HistoryService.list', () => {
  const scopeMine = { userId: 7, includeAll: false };
  const scopeAdmin = { userId: 1, includeAll: true };
  const expectHistoryItemContract = (item: Record<string, unknown>, status: 'completed' | 'failed') => {
    expect(item).toHaveProperty('query_id');
    expect(item).toHaveProperty('task_id');
    expect(item).toHaveProperty('stock_code');
    expect(item).toHaveProperty('stock_name');
    expect(item).toHaveProperty('record_source');
    expect(item).toHaveProperty('report_type');
    expect(item).toHaveProperty('sentiment_score');
    expect(item).toHaveProperty('operation_advice');
    expect(item).toHaveProperty('status', status);
    expect(item).toHaveProperty('error_message');
    expect(item).toHaveProperty('created_at');
  };

  const createService = (overrides?: {
    historyCount?: jest.Mock;
    historyFindMany?: jest.Mock;
    taskCount?: jest.Mock;
    taskFindMany?: jest.Mock;
  }): HistoryService => {
    const prisma = {
      analysisHistory: {
        count: overrides?.historyCount ?? jest.fn(async () => 0),
        findMany: overrides?.historyFindMany ?? jest.fn(async () => []),
      },
      analysisTask: {
        count: overrides?.taskCount ?? jest.fn(async () => 0),
        findMany: overrides?.taskFindMany ?? jest.fn(async () => []),
      },
    } as any;

    return new HistoryService(prisma);
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns completed history items from analysis_history only', async () => {
    const historyCount = jest.fn(async () => 1);
    const historyFindMany = jest.fn(async () => [
      {
        queryId: 'query-1',
        code: '600519',
        name: '贵州茅台',
        recordSource: 'agent_chat',
        reportType: 'detailed',
        sentimentScore: 86,
        operationAdvice: '继续持有',
        createdAt: new Date('2026-03-18T10:00:00.000Z'),
      },
    ]);
    const taskCount = jest.fn(async () => 99);
    const taskFindMany = jest.fn(async () => []);
    const service = createService({ historyCount, historyFindMany, taskCount, taskFindMany });

    const result = await service.list({
      status: 'completed',
      page: 1,
      limit: 20,
      scope: scopeMine,
    });

    expect(historyCount).toHaveBeenCalledWith({
      where: { ownerUserId: 7 },
    });
    expect(historyFindMany).toHaveBeenCalledWith({
      where: { ownerUserId: 7 },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 20,
    });
    expect(taskCount).not.toHaveBeenCalled();
    expect(taskFindMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      total: 1,
      items: [
        {
          query_id: 'query-1',
          task_id: 'query-1',
          stock_code: '600519',
          stock_name: '贵州茅台',
          record_source: 'agent_chat',
          report_type: 'detailed',
          sentiment_score: 86,
          operation_advice: '继续持有',
          status: 'completed',
          error_message: null,
          created_at: '2026-03-18T10:00:00.000Z',
        },
      ],
    });
    expectHistoryItemContract(result.items[0], 'completed');
  });

  it('returns failed history items from analysis_tasks only', async () => {
    const historyCount = jest.fn(async () => 99);
    const historyFindMany = jest.fn(async () => []);
    const taskCount = jest.fn(async () => 1);
    const taskFindMany = jest.fn(async () => [
      {
        taskId: 'task-failed-1',
        stockCode: 'AAPL',
        reportType: 'detailed',
        status: AnalysisTaskStatus.failed,
        message: '分析失败(agent_timeout): 上游超时',
        error: '[agent_timeout] 上游超时',
        createdAt: new Date('2026-03-18T08:00:00.000Z'),
        completedAt: new Date('2026-03-18T08:05:00.000Z'),
      },
    ]);
    const service = createService({ historyCount, historyFindMany, taskCount, taskFindMany });

    const result = await service.list({
      status: 'failed',
      page: 1,
      limit: 20,
      scope: scopeMine,
    });

    expect(historyCount).not.toHaveBeenCalled();
    expect(historyFindMany).not.toHaveBeenCalled();
    expect(taskCount).toHaveBeenCalledWith({
      where: { ownerUserId: 7, status: AnalysisTaskStatus.failed },
    });
    expect(taskFindMany).toHaveBeenCalledWith({
      where: { ownerUserId: 7, status: AnalysisTaskStatus.failed },
      orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
      skip: 0,
      take: 20,
    });
    expect(result).toEqual({
      total: 1,
      items: [
        {
          query_id: 'task-failed-1',
          task_id: 'task-failed-1',
          stock_code: 'AAPL',
          stock_name: null,
          record_source: 'analysis_center',
          report_type: 'detailed',
          sentiment_score: null,
          operation_advice: null,
          status: 'failed',
          error_message: '[agent_timeout] 上游超时',
          created_at: '2026-03-18T08:05:00.000Z',
        },
      ],
    });
    expectHistoryItemContract(result.items[0], 'failed');
  });

  it('merges completed and failed histories by terminal time for all status', async () => {
    const historyCount = jest.fn(async () => 4);
    const historyFindMany = jest.fn(async () => [
      {
        queryId: 'query-1',
        code: '600519',
        name: '贵州茅台',
        recordSource: 'analysis_center',
        reportType: 'detailed',
        sentimentScore: 86,
        operationAdvice: '继续持有',
        createdAt: new Date('2026-03-18T12:00:00.000Z'),
      },
      {
        queryId: 'query-2',
        code: '000001',
        name: '平安银行',
        recordSource: 'agent_chat',
        reportType: 'detailed',
        sentimentScore: 61,
        operationAdvice: '谨慎观察',
        createdAt: new Date('2026-03-18T10:00:00.000Z'),
      },
      {
        queryId: 'query-3',
        code: 'TSLA',
        name: 'Tesla',
        recordSource: 'analysis_center',
        reportType: 'detailed',
        sentimentScore: 44,
        operationAdvice: '观望',
        createdAt: new Date('2026-03-18T08:00:00.000Z'),
      },
      {
        queryId: 'query-4',
        code: 'NVDA',
        name: 'NVIDIA',
        recordSource: 'analysis_center',
        reportType: 'detailed',
        sentimentScore: 70,
        operationAdvice: '偏多',
        createdAt: new Date('2026-03-18T06:00:00.000Z'),
      },
    ]);
    const taskCount = jest.fn(async () => 4);
    const taskFindMany = jest.fn(async () => [
      {
        taskId: 'task-failed-1',
        stockCode: 'AAPL',
        reportType: 'detailed',
        status: AnalysisTaskStatus.failed,
        message: '分析失败(agent_timeout): 上游超时',
        error: '[agent_timeout] 上游超时',
        createdAt: new Date('2026-03-18T11:30:00.000Z'),
        completedAt: new Date('2026-03-18T11:30:00.000Z'),
      },
      {
        taskId: 'task-failed-2',
        stockCode: 'MSFT',
        reportType: 'detailed',
        status: AnalysisTaskStatus.failed,
        message: '分析失败(rate_limit): 限流',
        error: '[rate_limit] 限流',
        createdAt: new Date('2026-03-18T09:30:00.000Z'),
        completedAt: new Date('2026-03-18T09:30:00.000Z'),
      },
      {
        taskId: 'task-failed-3',
        stockCode: 'META',
        reportType: 'detailed',
        status: AnalysisTaskStatus.failed,
        message: '分析失败',
        error: '[unknown] 未知错误',
        createdAt: new Date('2026-03-18T07:30:00.000Z'),
        completedAt: null,
      },
      {
        taskId: 'task-failed-4',
        stockCode: 'AMZN',
        reportType: 'detailed',
        status: AnalysisTaskStatus.failed,
        message: '分析失败',
        error: '[unknown] 未知错误',
        createdAt: new Date('2026-03-18T05:00:00.000Z'),
        completedAt: new Date('2026-03-18T05:00:00.000Z'),
      },
    ]);
    const service = createService({ historyCount, historyFindMany, taskCount, taskFindMany });

    const result = await service.list({
      status: 'all',
      page: 2,
      limit: 2,
      scope: scopeAdmin,
    });

    expect(historyCount).toHaveBeenCalledWith({ where: {} });
    expect(taskCount).toHaveBeenCalledWith({ where: { status: AnalysisTaskStatus.failed } });
    expect(historyFindMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      take: 4,
    });
    expect(taskFindMany).toHaveBeenCalledWith({
      where: { status: AnalysisTaskStatus.failed },
      orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
      take: 4,
    });
    expect(result).toEqual({
      total: 8,
      items: [
        {
          query_id: 'query-2',
          task_id: 'query-2',
          stock_code: '000001',
          stock_name: '平安银行',
          record_source: 'agent_chat',
          report_type: 'detailed',
          sentiment_score: 61,
          operation_advice: '谨慎观察',
          status: 'completed',
          error_message: null,
          created_at: '2026-03-18T10:00:00.000Z',
        },
        {
          query_id: 'task-failed-2',
          task_id: 'task-failed-2',
          stock_code: 'MSFT',
          stock_name: null,
          record_source: 'analysis_center',
          report_type: 'detailed',
          sentiment_score: null,
          operation_advice: null,
          status: 'failed',
          error_message: '[rate_limit] 限流',
          created_at: '2026-03-18T09:30:00.000Z',
        },
      ],
    });
    expectHistoryItemContract(result.items[0], 'completed');
    expectHistoryItemContract(result.items[1], 'failed');
  });
});

describe('HistoryService.detail', () => {
  it('returns record_source in report meta', async () => {
    const service = new HistoryService({
      analysisHistory: {
        findFirst: jest.fn(async () => ({
          queryId: 'agc_session_11_600519',
          code: '600519',
          name: '贵州茅台',
          recordSource: 'agent_chat',
          reportType: 'detailed',
          createdAt: new Date('2026-03-18T10:00:00.000Z'),
          analysisSummary: '偏多看待',
          operationAdvice: '买入',
          trendPrediction: '看多',
          sentimentScore: 88,
          idealBuy: 1660,
          secondaryBuy: 1630,
          stopLoss: 1590,
          takeProfit: 1760,
          newsContent: null,
          rawResult: '{"signal_snapshot":{"operation_advice":"买入"}}',
          contextSnapshot: JSON.stringify({
            enhanced_context: {},
            realtime_quote_raw: {
              price: 1680,
              change_pct: 1.88,
            },
          }),
        })),
      },
    } as any);

    const result = await service.detail('agc_session_11_600519', { userId: 7, includeAll: false });

    expect(result).toEqual(expect.objectContaining({
      meta: expect.objectContaining({
        query_id: 'agc_session_11_600519',
        record_source: 'agent_chat',
        current_price: 1680,
        change_pct: 1.88,
      }),
    }));
  });
});
