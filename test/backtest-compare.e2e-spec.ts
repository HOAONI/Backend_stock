/** 回测比较与 DTO 校验单测，保证 compare 接口的输入约束和转发载荷保持稳定。 */

import { HttpException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  AgentBacktestRunRequestDto,
  AgentBacktestRunsQueryDto,
  BacktestCompareRequestDto,
  BacktestController,
  BacktestStrategyCreateDto,
  BacktestStrategyRunRequestDto,
  BacktestStrategyUpdateDto,
} from '../src/modules/backtest/backtest.controller';
import { AgentBacktestService } from '../src/modules/backtest/agent-backtest.service';
import { HealthController } from '../src/modules/health/health.controller';
import { BacktestService } from '../src/modules/backtest/backtest.service';
import { UserBacktestStrategyService } from '../src/modules/backtest/user-backtest-strategy.service';

describe('Backtest compare validation and forwarding', () => {
  describe('BacktestCompareRequestDto', () => {
    it('accepts valid strategy_codes and backward-compatible payload', () => {
      const validWithStrategies = plainToInstance(BacktestCompareRequestDto, {
        code: '600519',
        eval_window_days_list: [5, 10, 20],
        strategy_codes: ['agent_v1', 'ma20_trend', 'rsi14_mean_reversion'],
      });
      const validLegacy = plainToInstance(BacktestCompareRequestDto, {
        code: '600519',
        eval_window_days_list: [5, 10, 20],
      });

      expect(validateSync(validWithStrategies)).toHaveLength(0);
      expect(validateSync(validLegacy)).toHaveLength(0);
    });

    it('rejects illegal strategy_codes values', () => {
      const invalid = plainToInstance(BacktestCompareRequestDto, {
        eval_window_days_list: [5, 10],
        strategy_codes: ['agent_v1', 'not_allowed'],
      });
      const errors = validateSync(invalid);

      expect(errors.some((item) => item.property === 'strategy_codes')).toBe(true);
    });
  });

  describe('BacktestStrategyRunRequestDto', () => {
    it('accepts valid date-range strategy payload', () => {
      const valid = plainToInstance(BacktestStrategyRunRequestDto, {
        code: '600519',
        start_date: '2024-01-01',
        end_date: '2024-12-31',
        strategy_ids: [101, 202],
        initial_capital: 100000,
        commission_rate: 0.0003,
        slippage_bps: 2,
      });

      expect(validateSync(valid)).toHaveLength(0);
    });

    it('rejects illegal strategy codes for date-range run', () => {
      const invalid = plainToInstance(BacktestStrategyRunRequestDto, {
        code: '600519',
        start_date: '2024-01-01',
        end_date: '2024-12-31',
        strategy_codes: ['agent_v1'],
      });

      const errors = validateSync(invalid);
      expect(errors.some(item => item.property === 'strategy_codes')).toBe(true);
    });
  });

  describe('BacktestStrategyCreateDto', () => {
    it('accepts valid user strategy payload', () => {
      const valid = plainToInstance(BacktestStrategyCreateDto, {
        name: 'Fast MA',
        description: 'Custom moving average strategy',
        template_code: 'ma_cross',
        params: { maWindow: 10 },
      });

      expect(validateSync(valid)).toHaveLength(0);
    });
  });

  describe('BacktestStrategyUpdateDto', () => {
    it('accepts partial update payload', () => {
      const valid = plainToInstance(BacktestStrategyUpdateDto, {
        description: 'Updated',
        params: { maWindow: 30 },
      });

      expect(validateSync(valid)).toHaveLength(0);
    });
  });

  describe('AgentBacktestRunRequestDto', () => {
    it('accepts valid agent replay payload', () => {
      const valid = plainToInstance(AgentBacktestRunRequestDto, {
        code: '600519',
        start_date: '2024-01-01',
        end_date: '2024-12-31',
        initial_capital: 100000,
        commission_rate: 0.0003,
        slippage_bps: 2,
        runtime_strategy: {
          positionMaxPct: 30,
          stopLossPct: 8,
          takeProfitPct: 15,
        },
        enable_refine: true,
      });

      expect(validateSync(valid)).toHaveLength(0);
    });

    it('rejects invalid runtime strategy values', () => {
      const invalid = plainToInstance(AgentBacktestRunRequestDto, {
        code: '600519',
        start_date: '2024-01-01',
        end_date: '2024-12-31',
        runtime_strategy: {
          positionMaxPct: 300,
        },
      });

      const errors = validateSync(invalid);
      expect(errors.some(item => item.property === 'runtime_strategy')).toBe(true);
    });
  });

  describe('AgentBacktestRunsQueryDto', () => {
    it('accepts optional date filters for restore lookups', () => {
      const valid = plainToInstance(AgentBacktestRunsQueryDto, {
        code: '600519',
        status: 'refining',
        start_date: '2024-01-01',
        end_date: '2024-12-31',
        page: 1,
        limit: 20,
      });

      expect(validateSync(valid)).toHaveLength(0);
    });
  });

  describe('BacktestService.compareWindows', () => {
    it('forwards windows, strategies and assembled rows to agent', async () => {
      const findMany = jest
        .fn()
        .mockResolvedValueOnce([
          {
            code: '600519',
            analysisDate: new Date('2026-01-02T00:00:00Z'),
            evaluatedAt: new Date('2026-01-12T00:00:00Z'),
            simulatedReturnPct: 2.4,
            stockReturnPct: 2.4,
            evalStatus: 'completed',
            positionRecommendation: 'long',
            operationAdvice: '买入',
            stopLoss: 9.5,
            takeProfit: 12.0,
          },
        ])
        .mockResolvedValueOnce([]);

      const prisma = {
        backtestResult: {
          findMany,
        },
      };

      const compare = jest.fn(async (_payload: Record<string, unknown>) => ({
        metric_definition_version: 'v2',
        items: [
          {
            strategy_code: 'agent_v1',
            strategy_name: 'Agent v1',
            eval_window_days: 5,
            total_evaluations: 1,
            completed_count: 1,
            direction_accuracy_pct: 100,
            win_rate_pct: 100,
            avg_simulated_return_pct: 2.4,
            avg_stock_return_pct: 2.4,
            max_drawdown_pct: 0,
            data_source: 'api',
          },
        ],
      }));
      const service = new BacktestService(prisma as any, { compare } as any, {} as any);

      // 这里既校验筛出来的样本行结构，也校验 compare Agent 接收到的 rows_by_window 形状。
      const response = await service.compareWindows({
        code: '600519',
        evalWindowDaysList: [5, 10],
        strategyCodes: ['agent_v1'],
        requester: { userId: 1, includeAll: false },
      });

      expect(findMany).toHaveBeenCalledTimes(2);
      expect(compare).toHaveBeenCalledTimes(1);

      const payload = (compare.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
      expect(payload.eval_window_days_list).toEqual([5, 10]);
      expect(payload.strategy_codes).toEqual(['agent_v1']);

      const rowsByWindow = payload.rows_by_window as Record<string, unknown[]>;
      expect(Array.isArray(rowsByWindow['5'])).toBe(true);
      expect(Array.isArray(rowsByWindow['10'])).toBe(true);
      expect(rowsByWindow['5']).toHaveLength(1);
      expect(rowsByWindow['10']).toHaveLength(0);
      expect(rowsByWindow['5']?.[0]).toMatchObject({
        code: '600519',
        operation_advice: '买入',
        stop_loss: 9.5,
        take_profit: 12,
      });

      expect(response).toEqual({
        metric_definition_version: 'v2',
        items: [
          {
            strategy_code: 'agent_v1',
            strategy_name: 'Agent v1',
            eval_window_days: 5,
            total_evaluations: 1,
            completed_count: 1,
            direction_accuracy_pct: 100,
            win_rate_pct: 100,
            avg_simulated_return_pct: 2.4,
            avg_stock_return_pct: 2.4,
            max_drawdown_pct: 0,
            data_source: 'api',
          },
        ],
      });
    });

    it('uses default strategies when strategyCodes is omitted', async () => {
      const prisma = {
        backtestResult: {
          findMany: jest.fn(async () => []),
        },
      };

      const compare = jest.fn(async (_payload: Record<string, unknown>) => ({ items: [] }));
      const service = new BacktestService(prisma as any, { compare } as any, {} as any);

      await service.compareWindows({
        evalWindowDaysList: [5],
        requester: { userId: 1, includeAll: false },
      });

      const payload = (compare.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
      expect(payload.strategy_codes).toEqual(['agent_v1', 'ma20_trend', 'rsi14_mean_reversion']);
    });
  });

  describe('BacktestService.run/recomputeAll guards', () => {
    it('applies anti-join filter for incremental run (force=false)', async () => {
      const analysisFindMany = jest.fn(async () => []);
      const service = new BacktestService(
        {
          analysisHistory: { findMany: analysisFindMany },
          backtestResult: { deleteMany: jest.fn() },
          backtestSummary: { deleteMany: jest.fn() },
        } as any,
        {} as any,
        {} as any,
      );

      await service.run({
        force: false,
        limit: 100,
        scope: { userId: 9, includeAll: false },
      });

      const runFindManyCall = analysisFindMany.mock.calls[0] as unknown[] | undefined;
      const where = ((runFindManyCall?.[0] as Record<string, unknown> | undefined)?.where ?? {}) as Record<string, unknown>;
      expect(where.ownerUserId).toBe(9);
      expect(where.backtestResults).toBeDefined();
      expect((where.backtestResults as Record<string, unknown>).none).toBeDefined();
    });

    it('scopes recomputeAll deleteMany by window+engine version', async () => {
      const resultDeleteMany = jest.fn(async () => ({}));
      const summaryDeleteMany = jest.fn(async () => ({}));
      const analysisFindMany = jest.fn(async () => []);
      const service = new BacktestService(
        {
          analysisHistory: { findMany: analysisFindMany },
          backtestResult: { deleteMany: resultDeleteMany },
          backtestSummary: { deleteMany: summaryDeleteMany },
        } as any,
        {} as any,
        {} as any,
      );

      await service.recomputeAll({
        evalWindowDays: 10,
        scope: { userId: 7, includeAll: false },
      });

      const resultDeleteCall = resultDeleteMany.mock.calls[0] as unknown[] | undefined;
      const summaryDeleteCall = summaryDeleteMany.mock.calls[0] as unknown[] | undefined;
      const resultWhere = ((resultDeleteCall?.[0] as Record<string, unknown> | undefined)?.where ?? {}) as Record<string, unknown>;
      const summaryWhere = ((summaryDeleteCall?.[0] as Record<string, unknown> | undefined)?.where ?? {}) as Record<string, unknown>;
      expect(resultWhere.ownerUserId).toBe(7);
      expect(resultWhere.evalWindowDays).toBe(10);
      expect(resultWhere.engineVersion).toBeDefined();
      expect(summaryWhere.ownerUserId).toBe(7);
      expect(summaryWhere.evalWindowDays).toBe(10);
      expect(summaryWhere.engineVersion).toBeDefined();
    });
  });

  describe('BacktestService.runStrategyRange', () => {
    it('forwards payload to agent and persists run group/details', async () => {
      const createGroup = jest.fn(async () => ({ id: 1001 }));
      const createRun = jest.fn(async () => ({ id: 2001 }));
      const createTradeMany = jest.fn(async () => ({}));
      const createEquityMany = jest.fn(async () => ({}));
      const tx = {
        strategyBacktestRunGroup: { create: createGroup },
        strategyBacktestRun: { create: createRun },
        strategyBacktestTrade: { createMany: createTradeMany },
        strategyBacktestEquityPoint: { createMany: createEquityMany },
      };

      const findFirst = jest.fn(async () => ({
        id: 1001,
        code: '600519',
        engineVersion: 'backtrader_v1',
        startDate: new Date('2024-01-01T00:00:00Z'),
        endDate: new Date('2024-12-31T00:00:00Z'),
        effectiveStartDate: new Date('2024-01-02T00:00:00Z'),
        effectiveEndDate: new Date('2024-12-31T00:00:00Z'),
        createdAt: new Date('2026-03-05T00:00:00Z'),
        runs: [
          {
            id: 2001,
            savedStrategyId: 88,
            savedStrategyName: 'Fast MA',
            strategyCode: 'ma_cross',
            strategyVersion: 'v1',
            paramsJson: { maWindow: 10 },
            metricsJson: { total_return_pct: 12.3 },
            benchmarkJson: { total_return_pct: 8.1 },
            trades: [],
            equityPoints: [],
          },
        ],
      }));

      const strategyRun = jest.fn(async (_payload: Record<string, unknown>) => ({
        engine_version: 'backtrader_v1',
        requested_range: { start_date: '2024-01-01', end_date: '2024-12-31' },
        effective_range: { start_date: '2024-01-02', end_date: '2024-12-31' },
        items: [
          {
            strategy_id: 88,
            strategy_name: 'Fast MA',
            strategy_code: 'ma_cross',
            template_code: 'ma_cross',
            template_name: 'MA Cross',
            strategy_version: 'v1',
            params: { maWindow: 10 },
            metrics: { total_return_pct: 12.3 },
            benchmark: { total_return_pct: 8.1 },
            trades: [],
            equity: [],
          },
        ],
      }));

      const resolveRunStrategies = jest.fn(async () => ([
        {
          strategyId: 88,
          strategyName: 'Fast MA',
          templateCode: 'ma_cross',
          templateName: 'MA Cross',
          params: { maWindow: 10 },
        },
      ]));

      const service = new BacktestService(
        {
          $transaction: jest.fn(async (callback: (trx: any) => Promise<number>) => callback(tx)),
          strategyBacktestRunGroup: { findFirst },
        } as any,
        { strategyRun } as any,
        { resolveRunStrategies } as any,
      );

      const response = await service.runStrategyRange({
        code: '600519',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        strategyIds: [88],
        requester: { userId: 9, includeAll: false },
      });

      expect(resolveRunStrategies).toHaveBeenCalledWith({
        userId: 9,
        strategyIds: [88],
        strategyCodes: undefined,
      });
      expect(strategyRun).toHaveBeenCalledTimes(1);
      const payload = strategyRun.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(payload.code).toBe('600519');
      expect(payload.strategies).toEqual([
        {
          strategy_id: 88,
          strategy_name: 'Fast MA',
          template_code: 'ma_cross',
          params: { maWindow: 10 },
        },
      ]);

      expect(createGroup).toHaveBeenCalledTimes(1);
      expect(createRun).toHaveBeenCalledTimes(1);
      expect(createRun).toHaveBeenCalledWith({
        data: expect.objectContaining({
          savedStrategyId: 88,
          savedStrategyName: 'Fast MA',
          strategyCode: 'ma_cross',
        }),
      });
      expect(response).toMatchObject({
        run_group_id: 1001,
        code: '600519',
        items: [
          expect.objectContaining({
            strategy_id: 88,
            strategy_name: 'Fast MA',
            template_code: 'ma_cross',
            template_name: 'MA Cross',
          }),
        ],
        legacy_event_backtest: false,
      });
    });
  });

  describe('UserBacktestStrategyService', () => {
    it('creates and normalizes private strategy records', async () => {
      const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 9,
        ownerUserId: 7,
        name: data.name,
        description: data.description ?? null,
        templateCode: data.templateCode,
        paramsJson: data.paramsJson,
        createdAt: new Date('2026-03-10T00:00:00Z'),
        updatedAt: new Date('2026-03-10T00:00:00Z'),
      }));
      const service = new UserBacktestStrategyService({
        userBacktestStrategy: { create },
      } as any);

      const response = await service.createUserStrategy(7, {
        name: 'RSI Swing',
        description: 'Short-term RSI template',
        templateCode: 'rsi_threshold',
        params: {
          rsiPeriod: 10,
          oversoldThreshold: 25,
          overboughtThreshold: 75,
        },
      })

      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ownerUserId: 7,
          name: 'RSI Swing',
          templateCode: 'rsi_threshold',
          paramsJson: {
            rsiPeriod: 10,
            oversoldThreshold: 25,
            overboughtThreshold: 75,
          },
        }),
      })
      expect(response).toMatchObject({
        id: 9,
        name: 'RSI Swing',
        template_code: 'rsi_threshold',
        template_name: 'RSI Threshold',
      });
    });

    it('rejects duplicate names with conflict code', async () => {
      const service = new UserBacktestStrategyService({
        userBacktestStrategy: {
          create: jest.fn(async () => {
            throw {
              code: 'P2002',
            };
          }),
        },
      } as any);

      await expect(service.createUserStrategy(1, {
        name: 'Fast MA',
        templateCode: 'ma_cross',
        params: { maWindow: 10 },
      })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });

    it('resolves owned strategy ids for backtest execution', async () => {
      const findMany = jest.fn(async () => ([
        {
          id: 5,
          ownerUserId: 3,
          name: 'Fast MA',
          description: null,
          templateCode: 'ma_cross',
          paramsJson: { maWindow: 10 },
          createdAt: new Date('2026-03-10T00:00:00Z'),
          updatedAt: new Date('2026-03-10T00:00:00Z'),
        },
      ]));
      const service = new UserBacktestStrategyService({
        userBacktestStrategy: { findMany },
      } as any);

      const result = await service.resolveRunStrategies({
        userId: 3,
        strategyIds: [5],
      })

      expect(result).toEqual([
        {
          strategyId: 5,
          strategyName: 'Fast MA',
          templateCode: 'ma_cross',
          templateName: 'MA Cross',
          params: { maWindow: 10 },
        },
      ]);
    });
  });

  describe('BacktestController strategy error mapping', () => {
    it('maps Prisma P2021 to schema_not_ready response', async () => {
      const controller = new BacktestController(
        {
          runStrategyRange: jest.fn(async () => {
            throw {
              code: 'P2021',
              message: 'The table `public.strategy_backtest_run_groups` does not exist in the current database.',
              meta: { table: 'public.strategy_backtest_run_groups' },
            };
          }),
        } as any,
        {} as any,
      );

      const req = {
        authUser: {
          id: 1,
          roleCodes: ['admin'],
        },
      } as any;

      try {
        await controller.runStrategy(req, {
          code: '600519',
          start_date: '2024-01-01',
          end_date: '2024-12-31',
          strategy_codes: ['ma20_trend'],
        } as BacktestStrategyRunRequestDto);
        throw new Error('should throw');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(HttpException);
        const httpError = error as HttpException;
        expect(httpError.getStatus()).toBe(503);
        expect(httpError.getResponse()).toEqual({
          error: 'schema_not_ready',
          message: 'strategy backtest tables missing; run db migration',
        });
      }
    });
  });

  describe('BacktestController agent replay error mapping', () => {
    it('maps Prisma P2021 to schema_not_ready response', async () => {
      const controller = new BacktestController(
        {} as any,
        {} as any,
        {
          runAgentRange: jest.fn(async () => {
            throw {
              code: 'P2021',
              message: 'The table `public.agent_backtest_run_groups` does not exist in the current database.',
              meta: { table: 'public.agent_backtest_run_groups' },
            };
          }),
        } as any,
      );

      const req = {
        authUser: {
          id: 1,
          roleCodes: ['admin'],
        },
      } as any;

      try {
        await controller.runAgentBacktest(req, {
          code: '600519',
          start_date: '2024-01-01',
          end_date: '2024-12-31',
        } as AgentBacktestRunRequestDto);
        throw new Error('should throw');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(HttpException);
        const httpError = error as HttpException;
        expect(httpError.getStatus()).toBe(503);
        expect(httpError.getResponse()).toEqual({
          error: 'schema_not_ready',
          message: 'agent backtest tables missing; run db migration',
        });
      }
    });
  });

  describe('BacktestController agent history forwarding', () => {
    it('forwards start_date and end_date to agent list service', async () => {
      const listAgentRuns = jest.fn(async () => ({
        total: 0,
        page: 1,
        limit: 20,
        items: [],
        legacy_event_backtest: false,
      }));
      const controller = new BacktestController(
        {} as any,
        {} as any,
        { listAgentRuns } as any,
      );

      const req = {
        authUser: {
          id: 1,
          roleCodes: ['admin'],
        },
      } as any;

      await controller.listAgentRuns(req, {
        code: '600519',
        status: 'refining',
        start_date: '2024-01-01',
        end_date: '2024-12-31',
        page: 1,
        limit: 20,
      } as AgentBacktestRunsQueryDto);

      expect(listAgentRuns).toHaveBeenCalledWith(expect.objectContaining({
        code: '600519',
        status: 'refining',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        page: 1,
        limit: 20,
      }));
    });
  });

  describe('AgentBacktestService storage readiness guard', () => {
    it('throws schema_not_ready before raw agent queries when tables are missing', async () => {
      const $queryRawUnsafe = jest
        .fn()
        .mockResolvedValueOnce([{ schema_name: 'public' }])
        .mockResolvedValueOnce([{ tablename: 'agent_backtest_daily_steps' }]);

      const service = new AgentBacktestService(
        { $queryRawUnsafe } as any,
        {} as any,
        {} as any,
      );

      await expect(
        service.runAgentRange({
          code: '600519',
          startDate: '2024-01-01',
          endDate: '2024-12-31',
          requester: { userId: 9, includeAll: false },
        }),
      ).rejects.toMatchObject({
        code: 'P2021',
        meta: { table: 'public.agent_backtest_run_groups' },
        message: 'agent backtest tables missing; run db migration',
      });

      expect($queryRawUnsafe).toHaveBeenCalledTimes(2);
    });
  });

  describe('HealthController readiness', () => {
    it('reports strategy and agent backtest readiness separately', async () => {
      const $queryRawUnsafe = jest.fn(async (query: string) => {
        if (query.includes('SELECT current_schema()')) {
          return [{ schema_name: 'public' }];
        }
        if (query.includes('strategy_backtest_run_groups')) {
          return [
            { tablename: 'strategy_backtest_equity_points' },
            { tablename: 'strategy_backtest_run_groups' },
            { tablename: 'strategy_backtest_runs' },
            { tablename: 'strategy_backtest_trades' },
          ];
        }
        if (query.includes('agent_backtest_run_groups')) {
          return [
            { tablename: 'agent_backtest_daily_steps' },
            { tablename: 'agent_backtest_equity_points' },
          ];
        }
        return [];
      });

      const controller = new HealthController({ $queryRawUnsafe } as any);
      const response = await controller.ready();

      expect(response.status).toBe('degraded');
      expect(response.backtest_storage_ready).toBe(false);
      expect(response.agent_backtest_storage_ready).toBe(false);
      expect(response.missing_backtest_tables).toEqual([
        'user_backtest_strategies',
      ]);
      expect(response.missing_agent_backtest_tables).toEqual([
        'agent_backtest_run_groups',
        'agent_backtest_trades',
        'agent_backtest_signal_snapshots',
      ]);
    });
  });
});
