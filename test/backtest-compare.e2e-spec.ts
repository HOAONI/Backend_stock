import { HttpException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { BacktestCompareRequestDto, BacktestController, BacktestStrategyRunRequestDto } from '../src/modules/backtest/backtest.controller';
import { BacktestService } from '../src/modules/backtest/backtest.service';

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
        strategy_codes: ['ma20_trend', 'rsi14_mean_reversion'],
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
      const service = new BacktestService(prisma as any, { compare } as any);

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
      const service = new BacktestService(prisma as any, { compare } as any);

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
            strategyCode: 'ma20_trend',
            strategyVersion: 'v1',
            paramsJson: {},
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
            strategy_code: 'ma20_trend',
            strategy_version: 'v1',
            params: {},
            metrics: { total_return_pct: 12.3 },
            benchmark: { total_return_pct: 8.1 },
            trades: [],
            equity: [],
          },
        ],
      }));

      const service = new BacktestService(
        {
          $transaction: jest.fn(async (callback: (trx: any) => Promise<number>) => callback(tx)),
          strategyBacktestRunGroup: { findFirst },
        } as any,
        { strategyRun } as any,
      );

      const response = await service.runStrategyRange({
        code: '600519',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        strategyCodes: ['ma20_trend'],
        requester: { userId: 9, includeAll: false },
      });

      expect(strategyRun).toHaveBeenCalledTimes(1);
      const payload = strategyRun.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(payload.code).toBe('600519');
      expect(payload.strategy_codes).toEqual(['ma20_trend']);

      expect(createGroup).toHaveBeenCalledTimes(1);
      expect(createRun).toHaveBeenCalledTimes(1);
      expect(response).toMatchObject({
        run_group_id: 1001,
        code: '600519',
        legacy_event_backtest: false,
      });
    });
  });

  describe('BacktestController strategy error mapping', () => {
    it('maps Prisma P2021 to schema_not_ready response', async () => {
      const controller = new BacktestController({
        runStrategyRange: jest.fn(async () => {
          throw {
            code: 'P2021',
            message: 'The table `public.strategy_backtest_run_groups` does not exist in the current database.',
            meta: { table: 'public.strategy_backtest_run_groups' },
          };
        }),
      } as any);

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
});
