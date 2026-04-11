import { BacktestAgentClientService } from '../src/common/agent/backtest-agent-client.service';
import {
  BacktestAiInterpretationService,
  STRATEGY_AI_INTERPRETATION_MAX_ATTEMPTS,
} from '../src/modules/backtest/backtest-ai-interpretation.service';

function createStrategyGroupRow() {
  return {
    id: 101,
    ownerUserId: 9,
    code: '600519',
    startDate: new Date('2024-01-01T00:00:00Z'),
    endDate: new Date('2024-12-31T00:00:00Z'),
    effectiveStartDate: new Date('2024-01-02T00:00:00Z'),
    effectiveEndDate: new Date('2024-12-31T00:00:00Z'),
    runs: [
      {
        id: 201,
        savedStrategyName: 'Fast MA',
        strategyCode: 'ma_cross',
        strategyVersion: 'v1',
        metricsJson: { total_return_pct: 12.3 },
        benchmarkJson: { total_return_pct: 8.1 },
      },
    ],
  };
}

describe('BacktestAiInterpretationService', () => {
  it('marks strategy ai job completed after successful processing', async () => {
    const updateMany = jest
      .fn(async () => ({ count: 1 }));
    const service = new BacktestAiInterpretationService(
      {
        strategyBacktestRunGroup: {
          findFirst: jest.fn(async () => ({ id: 101, aiInterpretationAttempts: 0 })),
          updateMany,
        },
      } as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service, 'ensureStrategyRunGroupInterpretations').mockResolvedValue(undefined);

    await expect(service.processNextStrategyRunGroupJob()).resolves.toBe(true);

    expect(updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: 101, aiInterpretationStatus: 'pending' }),
      data: expect.objectContaining({
        aiInterpretationStatus: 'processing',
        aiInterpretationStartedAt: expect.any(Date),
      }),
    }));
    expect(updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 101 },
      data: expect.objectContaining({
        aiInterpretationStatus: 'completed',
        aiInterpretationCompletedAt: expect.any(Date),
      }),
    }));
  });

  it('requeues failed strategy ai jobs with backoff before max attempts', async () => {
    const updateMany = jest
      .fn(async () => ({ count: 1 }));
    const service = new BacktestAiInterpretationService(
      {
        strategyBacktestRunGroup: {
          findFirst: jest.fn(async () => ({ id: 101, aiInterpretationAttempts: 0 })),
          updateMany,
        },
      } as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service, 'ensureStrategyRunGroupInterpretations').mockRejectedValue(new Error('temporary_failure'));

    await expect(service.processNextStrategyRunGroupJob()).resolves.toBe(true);

    expect(updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 101 },
      data: expect.objectContaining({
        aiInterpretationStatus: 'pending',
        aiInterpretationErrorMessage: 'temporary_failure',
        aiInterpretationNextRetryAt: expect.any(Date),
      }),
    }));
  });

  it('marks strategy ai jobs failed after max attempts are exhausted', async () => {
    const updateMany = jest
      .fn(async () => ({ count: 1 }));
    const service = new BacktestAiInterpretationService(
      {
        strategyBacktestRunGroup: {
          findFirst: jest.fn(async () => ({ id: 101, aiInterpretationAttempts: STRATEGY_AI_INTERPRETATION_MAX_ATTEMPTS - 1 })),
          updateMany,
        },
      } as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service, 'ensureStrategyRunGroupInterpretations').mockRejectedValue(new Error('permanent_failure'));

    await expect(service.processNextStrategyRunGroupJob()).resolves.toBe(true);

    expect(updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 101 },
      data: expect.objectContaining({
        aiInterpretationStatus: 'failed',
        aiInterpretationErrorMessage: 'permanent_failure',
        aiInterpretationCompletedAt: expect.any(Date),
        aiInterpretationNextRetryAt: null,
      }),
    }));
  });

  it('persists unavailable item interpretations and still completes the job', async () => {
    const updateMany = jest
      .fn(async () => ({ count: 1 }));
    const strategyRunUpdate = jest.fn(async (input: Record<string, unknown>) => input);
    const prisma = {
      strategyBacktestRunGroup: {
        findFirst: jest.fn(async () => ({ id: 101, aiInterpretationAttempts: 0 })),
        findUnique: jest.fn(async () => createStrategyGroupRow()),
        updateMany,
      },
      strategyBacktestRun: {
        update: strategyRunUpdate,
      },
      $transaction: jest.fn(async (promises: Array<Promise<unknown>>) => await Promise.all(promises)),
    };
    const service = new BacktestAiInterpretationService(
      prisma as any,
      {} as any,
      {
        buildRuntimeContext: jest.fn(async () => {
          throw new Error('runtime_unavailable');
        }),
      } as any,
    );

    await expect(service.processNextStrategyRunGroupJob()).resolves.toBe(true);

    expect(strategyRunUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        metricsJson: expect.objectContaining({
          ai_interpretation: expect.objectContaining({
            status: 'unavailable',
            summary: 'runtime_unavailable',
          }),
        }),
      }),
    }));
    expect(updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 101 },
      data: expect.objectContaining({
        aiInterpretationStatus: 'completed',
      }),
    }));
  });

  it('persists failed item interpretations when interpret request errors and still completes the job', async () => {
    const updateMany = jest
      .fn(async () => ({ count: 1 }));
    const strategyRunUpdate = jest.fn(async (input: Record<string, unknown>) => input);
    const prisma = {
      strategyBacktestRunGroup: {
        findFirst: jest.fn(async () => ({ id: 101, aiInterpretationAttempts: 0 })),
        findUnique: jest.fn(async () => createStrategyGroupRow()),
        updateMany,
      },
      strategyBacktestRun: {
        update: strategyRunUpdate,
      },
      $transaction: jest.fn(async (promises: Array<Promise<unknown>>) => await Promise.all(promises)),
    };
    const service = new BacktestAiInterpretationService(
      prisma as any,
      {
        interpret: jest.fn(async () => {
          throw new Error('llm_timeout');
        }),
      } as any,
      {
        buildRuntimeContext: jest.fn(async () => ({
          llmSource: 'personal',
          effectiveLlm: { provider: 'openai', model: 'gpt-4o-mini' },
          runtimeConfig: {
            llm: {
              provider: 'openai',
              base_url: 'https://api.openai.com/v1',
              model: 'gpt-4o-mini',
              has_token: true,
              api_token: 'secret',
            },
          },
        })),
      } as any,
    );

    await expect(service.processNextStrategyRunGroupJob()).resolves.toBe(true);

    expect(strategyRunUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        metricsJson: expect.objectContaining({
          ai_interpretation: expect.objectContaining({
            status: 'failed',
            error_message: 'llm_timeout',
          }),
        }),
      }),
    }));
    expect(updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 101 },
      data: expect.objectContaining({
        aiInterpretationStatus: 'completed',
      }),
    }));
  });

  it('persists agent-produced strategy interpretations and marks the run group completed', async () => {
    const strategyRunUpdate = jest.fn(async (input: Record<string, unknown>) => input);
    const strategyRunGroupUpdate = jest.fn(async (input: Record<string, unknown>) => input);
    const prisma = {
      strategyBacktestRunGroup: {
        findUnique: jest.fn(async () => createStrategyGroupRow()),
        update: strategyRunGroupUpdate,
      },
      strategyBacktestRun: {
        update: strategyRunUpdate,
      },
      $transaction: jest.fn(async (promises: Array<Promise<unknown>>) => await Promise.all(promises)),
    };
    const service = new BacktestAiInterpretationService(
      prisma as any,
      {} as any,
      {
        buildRuntimeContext: jest.fn(async () => ({
          llmSource: 'personal',
          effectiveLlm: { provider: 'openai', model: 'gpt-4o-mini' },
          runtimeConfig: {
            llm: {
              provider: 'openai',
              base_url: 'https://api.openai.com/v1',
              model: 'gpt-4o-mini',
              has_token: true,
              api_token: 'secret',
            },
          },
        })),
      } as any,
    );

    await expect(service.persistStrategyRunGroupInterpretationsFromAgent({
      ownerUserId: 9,
      runGroupId: 101,
      items: [
        {
          item_key: 'strategy-run-201',
          status: 'ready',
          verdict: '表现较强',
          summary: '收益占优，回撤可控。',
        },
      ],
    })).resolves.toEqual(expect.objectContaining({
      run_group_id: 101,
      saved_count: 1,
      ai_interpretation_status: 'completed',
    }));

    expect(strategyRunUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 201 },
      data: expect.objectContaining({
        metricsJson: expect.objectContaining({
          ai_interpretation: expect.objectContaining({
            status: 'ready',
            verdict: '表现较强',
            summary: '收益占优，回撤可控。',
            provider: 'openai',
            model: 'gpt-4o-mini',
          }),
        }),
      }),
    }));
    expect(strategyRunGroupUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 101 },
      data: expect.objectContaining({
        aiInterpretationStatus: 'completed',
        aiInterpretationStartedAt: expect.any(Date),
        aiInterpretationCompletedAt: expect.any(Date),
      }),
    }));
  });

});

describe('BacktestAgentClientService timeout config', () => {
  const originalEnv = {
    BACKTEST_AGENT_TIMEOUT_MS: process.env.BACKTEST_AGENT_TIMEOUT_MS,
    BACKTEST_AGENT_RUN_TIMEOUT_MS: process.env.BACKTEST_AGENT_RUN_TIMEOUT_MS,
    BACKTEST_AGENT_INTERPRET_TIMEOUT_MS: process.env.BACKTEST_AGENT_INTERPRET_TIMEOUT_MS,
  };
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env.BACKTEST_AGENT_TIMEOUT_MS = originalEnv.BACKTEST_AGENT_TIMEOUT_MS;
    process.env.BACKTEST_AGENT_RUN_TIMEOUT_MS = originalEnv.BACKTEST_AGENT_RUN_TIMEOUT_MS;
    process.env.BACKTEST_AGENT_INTERPRET_TIMEOUT_MS = originalEnv.BACKTEST_AGENT_INTERPRET_TIMEOUT_MS;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('uses an independent 180000ms default timeout for interpret requests', async () => {
    process.env.BACKTEST_AGENT_TIMEOUT_MS = '30000';
    delete process.env.BACKTEST_AGENT_RUN_TIMEOUT_MS;
    delete process.env.BACKTEST_AGENT_INTERPRET_TIMEOUT_MS;

    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    global.fetch = jest.fn(async () => ({
      ok: true,
      text: async () => '{"ok":true,"data":{}}',
    })) as any;

    const service = new BacktestAgentClientService();
    await service.interpret({ items: [] });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 180000);
  });

  it('uses dedicated timeout budgets for run and interpret requests', async () => {
    process.env.BACKTEST_AGENT_TIMEOUT_MS = '30000';
    process.env.BACKTEST_AGENT_RUN_TIMEOUT_MS = '123000';
    process.env.BACKTEST_AGENT_INTERPRET_TIMEOUT_MS = '61000';

    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    global.fetch = jest.fn(async () => ({
      ok: true,
      text: async () => '{"ok":true,"data":{}}',
    })) as any;

    const service = new BacktestAgentClientService();
    await service.strategyRun({ code: '600519' });
    await service.interpret({ items: [] });

    expect(timeoutSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 123000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 61000);
  });
});
