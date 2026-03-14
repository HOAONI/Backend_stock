import { AnalysisService } from '../src/modules/analysis/analysis.service';
import { TaskWorkerService } from '../src/common/worker/task-worker.service';
import { TradingAccountService } from '../src/modules/trading-account/trading-account.service';

jest.mock('../src/modules/analysis/analysis.mapper', () => ({
  mapAgentRunToAnalysis: jest.fn(() => ({
    queryId: 'q-test',
    stockCode: '600121',
    stockName: '测试股票',
    report: {},
    historyRecord: {
      queryId: 'q-test',
      code: '600121',
      name: '测试股票',
      reportType: 'detailed',
      sentimentScore: 50,
      operationAdvice: '观望',
      trendPrediction: '观望',
      analysisSummary: 'ok',
      rawResult: '{}',
      newsContent: null,
      contextSnapshot: '{}',
      idealBuy: null,
      secondaryBuy: null,
      stopLoss: null,
      takeProfit: null,
    },
  })),
}));

describe('Runtime config forwarding and auto-order guards', () => {
  const createAiRuntimeService = (override?: Record<string, unknown>) => ({
    resolveEffectiveLlmFromProfile: jest.fn(async () => ({
      source: 'personal',
      hasPersonalToken: true,
      personalProvider: 'openai',
      hasSystemToken: true,
      systemDefault: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        hasToken: true,
      },
      effective: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
      },
      apiToken: 'personal-token-xyz',
      requiresProviderReselection: false,
      forwardRuntimeLlm: true,
      ...override,
    })),
  });

  const legacyExecutionMeta = {
    execution_mode: 'paper' as const,
    requested_execution_mode: 'auto' as const,
    broker_account_id: 3,
    auto_order_enabled: true,
    broker_plan_reason: 'legacy_worker_auto_order',
  };
  const brokerExecutionMeta = {
    execution_mode: 'broker' as const,
    requested_execution_mode: 'auto' as const,
    broker_account_id: 3,
    auto_order_enabled: true,
    broker_plan_reason: 'agent_execute_backtrader_local',
  };

  describe('AnalysisService.runSync', () => {
    it('forces runtime_config forwarding and refreshes trading context', async () => {
      const prisma = {
        adminUserProfile: {
          findUnique: jest.fn(async () => null),
        },
        adminUser: {
          findUnique: jest.fn(async () => ({ username: 'tester' })),
        },
        $transaction: jest.fn(async (queries: Array<Promise<unknown>>) => Promise.all(queries)),
        analysisHistory: { create: jest.fn(async () => ({})) },
      } as any;
      const agentRunBridge = {
        runViaAsyncTask: jest.fn(async () => ({
          run: {},
          bridgeMeta: {
            agent_task_id: 't1',
            agent_run_id: 'r1',
            poll_attempts: 0,
            last_agent_status: 'completed',
            bridge_error_code: null,
          },
        })),
      } as any;
      const brokerAccountsService = {
        resolveSimulationAccess: jest.fn(async () => ({ brokerAccountId: 3 })),
      } as any;
      const aiRuntimeService = createAiRuntimeService();
      const tradingAccountService = {
        getRuntimeContext: jest.fn(async () => ({
          broker_account_id: 3,
          broker_code: 'backtrader_local',
          provider_code: 'backtrader_local',
          provider_name: 'Backtrader Local Sim',
          account_uid: 'bt-3',
          account_display_name: '测试账户',
          snapshot_at: new Date().toISOString(),
          data_source: 'upstream',
          summary: {
            cash: 6507.96,
            total_market_value: 93464,
            total_asset: 99971.96,
          },
          positions: [
            {
              code: '600121',
              quantity: 20000,
              available_qty: 0,
              avg_cost: 4.6746,
              market_value: 93464,
            },
          ],
        })),
      } as any;

      const service = new AnalysisService(
        prisma,
        agentRunBridge,
        aiRuntimeService as any,
        brokerAccountsService,
        tradingAccountService,
      );

      await service.runSync({
        stockCode: '600121',
        reportType: 'detailed',
        userId: 1,
        executionMode: 'auto',
      });

      expect(tradingAccountService.getRuntimeContext).toHaveBeenCalledWith(1, true);
      expect(agentRunBridge.runViaAsyncTask).toHaveBeenCalledTimes(1);
      const options = (agentRunBridge.runViaAsyncTask as jest.Mock).mock.calls[0]?.[2] as Record<string, unknown>;
      expect(options.forceRuntimeConfig).toBe(true);
      expect(((options.runtimeConfig as Record<string, unknown>).llm as Record<string, unknown>).api_token).toBe('personal-token-xyz');
      expect((options.runtimeConfig as Record<string, unknown>).context).toBeDefined();
      expect(((options.runtimeConfig as Record<string, unknown>).execution as Record<string, unknown>).mode).toBe('broker');
    });

    it('maps SiliconFlow personal runtime to custom provider before forwarding to Agent', async () => {
      const prisma = {
        adminUserProfile: {
          findUnique: jest.fn(async () => null),
        },
        adminUser: {
          findUnique: jest.fn(async () => ({ username: 'tester' })),
        },
        $transaction: jest.fn(async (queries: Array<Promise<unknown>>) => Promise.all(queries)),
        analysisHistory: { create: jest.fn(async () => ({})) },
      } as any;
      const agentRunBridge = {
        runViaAsyncTask: jest.fn(async () => ({
          run: {},
          bridgeMeta: {
            agent_task_id: 't1',
            agent_run_id: 'r1',
            poll_attempts: 0,
            last_agent_status: 'completed',
            bridge_error_code: null,
          },
        })),
      } as any;
      const brokerAccountsService = {
        resolveSimulationAccess: jest.fn(async () => ({ brokerAccountId: 3 })),
      } as any;
      const aiRuntimeService = createAiRuntimeService({
        personalProvider: 'siliconflow',
        effective: {
          provider: 'siliconflow',
          baseUrl: 'https://api.siliconflow.cn/v1',
          model: 'Qwen/Qwen3-32B',
        },
      });
      const tradingAccountService = {
        getRuntimeContext: jest.fn(async () => ({
          broker_account_id: 3,
          broker_code: 'backtrader_local',
          provider_code: 'backtrader_local',
          provider_name: 'Backtrader Local Sim',
          account_uid: 'bt-3',
          account_display_name: '测试账户',
          snapshot_at: new Date().toISOString(),
          data_source: 'upstream',
          summary: {
            cash: 6507.96,
            total_market_value: 93464,
            total_asset: 99971.96,
          },
          positions: [],
        })),
      } as any;

      const service = new AnalysisService(
        prisma,
        agentRunBridge,
        aiRuntimeService as any,
        brokerAccountsService,
        tradingAccountService,
      );

      await service.runSync({
        stockCode: '600121',
        reportType: 'detailed',
        userId: 1,
        executionMode: 'auto',
      });

      const options = (agentRunBridge.runViaAsyncTask as jest.Mock).mock.calls[0]?.[2] as Record<string, unknown>;
      const llm = (options.runtimeConfig as Record<string, unknown>).llm as Record<string, unknown>;
      expect(llm.provider).toBe('custom');
      expect(llm.base_url).toBe('https://api.siliconflow.cn/v1');
      expect(llm.model).toBe('Qwen/Qwen3-32B');
      expect(llm.api_token).toBe('personal-token-xyz');
    });

    it('keeps paper mode account-agnostic and does not require broker runtime context', async () => {
      const prisma = {
        adminUserProfile: {
          findUnique: jest.fn(async () => null),
        },
        adminUser: {
          findUnique: jest.fn(async () => ({ username: 'tester' })),
        },
        $transaction: jest.fn(async (queries: Array<Promise<unknown>>) => Promise.all(queries)),
        analysisHistory: { create: jest.fn(async () => ({})) },
      } as any;
      const agentRunBridge = {
        runViaAsyncTask: jest.fn(async () => ({
          run: {},
          bridgeMeta: {
            agent_task_id: 't1',
            agent_run_id: 'r1',
            poll_attempts: 0,
            last_agent_status: 'completed',
            bridge_error_code: null,
          },
        })),
      } as any;
      const brokerAccountsService = {
        resolveSimulationAccess: jest.fn(async () => {
          throw new Error('paper mode should not resolve broker access');
        }),
      } as any;
      const aiRuntimeService = createAiRuntimeService();
      const tradingAccountService = {
        getRuntimeContext: jest.fn(async () => {
          throw new Error('paper mode should not refresh broker runtime context');
        }),
      } as any;

      const service = new AnalysisService(
        prisma,
        agentRunBridge,
        aiRuntimeService as any,
        brokerAccountsService,
        tradingAccountService,
      );

      await service.runSync({
        stockCode: '600121',
        reportType: 'detailed',
        userId: 1,
        executionMode: 'paper',
      });

      expect(brokerAccountsService.resolveSimulationAccess).not.toHaveBeenCalled();
      expect(tradingAccountService.getRuntimeContext).not.toHaveBeenCalled();
      const options = (agentRunBridge.runViaAsyncTask as jest.Mock).mock.calls[0]?.[2] as Record<string, unknown>;
      expect(((options.runtimeConfig as Record<string, unknown>).execution as Record<string, unknown>).mode).toBe('paper');
      expect((options.runtimeConfig as Record<string, unknown>).context).toBeUndefined();
    });

    it('preserves analysis-only fallback when auto order is globally disabled', async () => {
      const previous = process.env.ANALYSIS_AUTO_ORDER_ENABLED;
      process.env.ANALYSIS_AUTO_ORDER_ENABLED = 'false';

      const prisma = {
        adminUserProfile: {
          findUnique: jest.fn(async () => null),
        },
        adminUser: {
          findUnique: jest.fn(async () => ({ username: 'tester' })),
        },
        $transaction: jest.fn(async (queries: Array<Promise<unknown>>) => Promise.all(queries)),
        analysisHistory: { create: jest.fn(async () => ({})) },
      } as any;
      const agentRunBridge = {
        runViaAsyncTask: jest.fn(async () => ({
          run: {},
          bridgeMeta: {
            agent_task_id: 't1',
            agent_run_id: 'r1',
            poll_attempts: 0,
            last_agent_status: 'completed',
            bridge_error_code: null,
          },
        })),
      } as any;
      const brokerAccountsService = {
        resolveSimulationAccess: jest.fn(async () => {
          throw new Error('disabled auto order should not resolve broker access');
        }),
      } as any;
      const aiRuntimeService = createAiRuntimeService();
      const tradingAccountService = {
        getRuntimeContext: jest.fn(async () => {
          throw new Error('disabled auto order should not refresh broker runtime context');
        }),
      } as any;

      const service = new AnalysisService(
        prisma,
        agentRunBridge,
        aiRuntimeService as any,
        brokerAccountsService,
        tradingAccountService,
      );

      try {
        await service.runSync({
          stockCode: '600121',
          reportType: 'detailed',
          userId: 1,
          executionMode: 'auto',
        });
      } finally {
        if (previous == null) {
          delete process.env.ANALYSIS_AUTO_ORDER_ENABLED;
        } else {
          process.env.ANALYSIS_AUTO_ORDER_ENABLED = previous;
        }
      }

      expect(brokerAccountsService.resolveSimulationAccess).not.toHaveBeenCalled();
      expect(tradingAccountService.getRuntimeContext).not.toHaveBeenCalled();
      const options = (agentRunBridge.runViaAsyncTask as jest.Mock).mock.calls[0]?.[2] as Record<string, unknown>;
      expect(((options.runtimeConfig as Record<string, unknown>).execution as Record<string, unknown>).mode).toBe('paper');
      expect((options.runtimeConfig as Record<string, unknown>).context).toBeUndefined();
    });

    it('omits llm override when using the Agent built-in system default', async () => {
      const prisma = {
        adminUserProfile: {
          findUnique: jest.fn(async () => null),
        },
        adminUser: {
          findUnique: jest.fn(async () => ({ username: 'tester' })),
        },
        $transaction: jest.fn(async (queries: Array<Promise<unknown>>) => Promise.all(queries)),
        analysisHistory: { create: jest.fn(async () => ({})) },
      } as any;
      const agentRunBridge = {
        runViaAsyncTask: jest.fn(async () => ({
          run: {},
          bridgeMeta: {
            agent_task_id: 't1',
            agent_run_id: 'r1',
            poll_attempts: 0,
            last_agent_status: 'completed',
            bridge_error_code: null,
          },
        })),
      } as any;
      const brokerAccountsService = {
        resolveSimulationAccess: jest.fn(async () => {
          throw new Error('paper mode should not resolve broker access');
        }),
      } as any;
      const aiRuntimeService = createAiRuntimeService({
        source: 'system',
        hasPersonalToken: false,
        personalProvider: '',
        systemDefault: {
          provider: 'deepseek',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          hasToken: true,
        },
        effective: {
          provider: 'deepseek',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
        },
        apiToken: null,
        forwardRuntimeLlm: false,
      });
      const tradingAccountService = {
        getRuntimeContext: jest.fn(async () => {
          throw new Error('paper mode should not refresh broker runtime context');
        }),
      } as any;

      const service = new AnalysisService(
        prisma,
        agentRunBridge,
        aiRuntimeService as any,
        brokerAccountsService,
        tradingAccountService,
      );

      await service.runSync({
        stockCode: '600121',
        reportType: 'detailed',
        userId: 1,
        executionMode: 'paper',
      });

      const options = (agentRunBridge.runViaAsyncTask as jest.Mock).mock.calls[0]?.[2] as Record<string, unknown>;
      expect((options.runtimeConfig as Record<string, unknown>).llm).toBeUndefined();
    });
  });

  describe('TaskWorkerService.maybeAutoPlaceOrder', () => {
    const prevSessionEnv = process.env.ANALYSIS_AUTO_ORDER_ENFORCE_SESSION;

    beforeEach(() => {
      process.env.ANALYSIS_AUTO_ORDER_ENFORCE_SESSION = 'false';
    });

    afterEach(() => {
      if (prevSessionEnv == null) {
        delete process.env.ANALYSIS_AUTO_ORDER_ENFORCE_SESSION;
      } else {
        process.env.ANALYSIS_AUTO_ORDER_ENFORCE_SESSION = prevSessionEnv;
      }
    });

    it('skips buy when realtime cash is insufficient (no order submission)', async () => {
      const tradingAccountService = {
        getRuntimeContext: jest.fn(async () => ({
          broker_account_id: 3,
          broker_code: 'backtrader_local',
          provider_code: 'backtrader_local',
          provider_name: 'Backtrader Local Sim',
          account_uid: 'bt-3',
          account_display_name: '测试账户',
          snapshot_at: new Date().toISOString(),
          data_source: 'upstream',
          summary: { cash: 1000 },
          positions: [],
        })),
        placeOrder: jest.fn(async () => ({ order: {} })),
      } as any;

      const service = new TaskWorkerService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        tradingAccountService,
      );

      const result = await (service as any).maybeAutoPlaceOrder({
        task: {
          taskId: 'task-buy-1',
          stockCode: '600121',
          ownerUserId: 1,
        },
        runPayload: {
          execution_snapshot: {
            '600121': {
              action: 'buy',
              traded_qty: 20000,
              fill_price: 4.7,
            },
          },
        },
        executionMeta: legacyExecutionMeta,
      });

      expect(result).toMatchObject({
        status: 'skipped',
        reason: 'insufficient_cash_precheck',
      });
      expect(tradingAccountService.getRuntimeContext).toHaveBeenCalledWith(1, true);
      expect(tradingAccountService.placeOrder).not.toHaveBeenCalled();
    });

    it('skips sell when realtime available position is insufficient (no order submission)', async () => {
      const tradingAccountService = {
        getRuntimeContext: jest.fn(async () => ({
          broker_account_id: 3,
          broker_code: 'backtrader_local',
          provider_code: 'backtrader_local',
          provider_name: 'Backtrader Local Sim',
          account_uid: 'bt-3',
          account_display_name: '测试账户',
          snapshot_at: new Date().toISOString(),
          data_source: 'upstream',
          summary: { cash: 90000 },
          positions: [
            {
              code: '600121',
              quantity: 20000,
              available_qty: 100,
            },
          ],
        })),
        placeOrder: jest.fn(async () => ({ order: {} })),
      } as any;

      const service = new TaskWorkerService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        tradingAccountService,
      );

      const result = await (service as any).maybeAutoPlaceOrder({
        task: {
          taskId: 'task-sell-1',
          stockCode: '600121',
          ownerUserId: 1,
        },
        runPayload: {
          execution_snapshot: {
            '600121': {
              action: 'sell',
              traded_qty: 1000,
              fill_price: 4.7,
            },
          },
        },
        executionMeta: legacyExecutionMeta,
      });

      expect(result).toMatchObject({
        status: 'skipped',
        reason: 'insufficient_position_precheck',
      });
      expect(tradingAccountService.getRuntimeContext).toHaveBeenCalledWith(1, true);
      expect(tradingAccountService.placeOrder).not.toHaveBeenCalled();
    });

    it('does not trigger legacy worker placement when Agent already owns broker execution', async () => {
      const service = new TaskWorkerService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      expect((service as any).shouldAutoPlaceOrder(brokerExecutionMeta)).toBe(false);
      expect((service as any).deriveAutoOrderFromExecution({
        task: { stockCode: '600121' },
        runPayload: {
          execution_snapshot: {
            '600121': {
              state: 'ready',
              action: 'buy',
              traded_qty: 600,
              fill_price: 4.78,
              executed_via: 'backtrader_internal',
              broker_requested: true,
              broker_ticket_id: 'bt-order-11',
              order_id: 11,
              trade_id: 22,
              reason: 'broker_executed',
            },
          },
        },
        executionMeta: brokerExecutionMeta,
      })).toMatchObject({
        status: 'submitted',
        source: 'agent_execution',
        executed_via: 'backtrader_internal',
        provider_order_id: 'bt-order-11',
        order_id: 11,
        trade_id: 22,
      });
    });

    it('promotes upstream llm timeout code from agent task failures', async () => {
      const service = new TaskWorkerService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      expect((service as any).resolveFailurePresentation({
        code: 'agent_task_failed',
        message: '[llm_request_timeout] DeepSeek request timed out after 120000ms',
      })).toEqual({
        code: 'llm_request_timeout',
        message: 'DeepSeek request timed out after 120000ms',
      });
    });
  });

  describe('TradingAccountService.placeOrder audit semantics', () => {
    it('writes failed audit status when provider returns rejected', async () => {
      const upsert = jest.fn(async (..._args: any[]) => ({}));
      const findFirst = jest.fn(async (..._args: any[]) => null);
      const prisma = {
        analysisAutoOrder: {
          upsert,
          findFirst,
        },
      } as any;

      const resolveSimulationAccess = jest.fn(async () => ({
        userId: 1,
        brokerAccountId: 3,
        brokerCode: 'backtrader_local',
        environment: 'simulation',
        accountUid: 'bt-3',
        accountDisplayName: '测试账户',
        providerCode: 'backtrader_local',
        providerName: 'Backtrader Local Sim',
        credentials: {},
      }));

      const placeOrder = jest.fn(async () => ({
        status: 'rejected',
        provider_status: 'rejected',
        message: '可用资金不足',
      }));

      const brokerRegistry = {
        getAdapter: jest.fn(() => ({ placeOrder })),
      } as any;

      const service = new TradingAccountService(
        prisma,
        { resolveSimulationAccess } as any,
        brokerRegistry,
      );

      const response = await service.placeOrder(1, {
        stock_code: '600121',
        direction: 'buy',
        type: 'market',
        price: 4.7,
        quantity: 20000,
        source_task_id: 'task-reject-1',
      });

      expect(response.order).toMatchObject({
        provider_status: 'rejected',
      });
      expect(upsert).toHaveBeenCalledTimes(1);
      const firstUpsertCall = upsert.mock.calls[0] as any[] | undefined;
      expect(firstUpsertCall).toBeDefined();
      const upsertPayload = (firstUpsertCall?.[0] ?? {}) as Record<string, any>;
      expect(upsertPayload.create.status).toBe('failed');
      expect(upsertPayload.create.errorMessage).toBe('可用资金不足');
    });
  });
});
