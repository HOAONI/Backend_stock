import { TradingAccountService } from '../src/modules/trading-account/trading-account.service';

describe('TradingAccountService.getPortfolioHealth', () => {
  it('builds concentration, industry exposure and risk diagnostics from snapshot data', async () => {
    const prisma = {
      userBrokerSnapshotCache: {
        findUnique: jest.fn(async () => null),
        upsert: jest.fn(async () => ({})),
      },
    };
    const brokerAccountsService = {
      resolveSimulationAccess: jest.fn(async () => ({
        userId: 7,
        brokerAccountId: 17,
        brokerCode: 'backtrader_local',
        environment: 'simulation',
        accountUid: 'bt-17',
        accountDisplayName: 'tester-paper',
        providerCode: 'backtrader_local',
        providerName: 'Backtrader Local Sim',
        credentials: {},
      })),
    };
    const adapter = {
      getAccountSummary: jest.fn(async () => ({
        cash: 150000,
        initial_capital: 500000,
        total_market_value: 620000,
        total_asset: 770000,
        total_return_pct: 54,
      })),
      getPositions: jest.fn(async () => ([
        {
          code: '600519',
          stock_name: '贵州茅台',
          quantity: 200,
          available_qty: 200,
          avg_cost: 1500,
          last_price: 1800,
          market_value: 360000,
          industry_name: '白酒',
        },
        {
          code: '000858',
          stock_name: '五粮液',
          quantity: 200,
          available_qty: 200,
          avg_cost: 1200,
          last_price: 1300,
          market_value: 260000,
          industry_name: '白酒',
        },
      ])),
      getOrders: jest.fn(async () => ([
        { created_at: '2026-04-05T09:31:00+08:00' },
        { created_at: '2026-04-05T10:12:00+08:00' },
      ])),
      getTrades: jest.fn(async () => ([
        {
          stock_code: '600519',
          created_at: '2026-03-20T10:00:00+08:00',
          realized_pnl: 10000,
          return_pct: 5,
        },
        {
          stock_code: '000858',
          created_at: '2026-03-28T10:00:00+08:00',
          realized_pnl: -25000,
          return_pct: -8,
        },
        {
          stock_code: '600519',
          created_at: '2026-04-05T10:30:00+08:00',
          realized_pnl: 6000,
          return_pct: 3,
        },
      ])),
    };
    const brokerRegistry = {
      getAdapter: jest.fn(() => adapter),
    };

    const service = new TradingAccountService(
      prisma as any,
      brokerAccountsService as any,
      brokerRegistry as any,
    );

    const payload = await service.getPortfolioHealth(7, true);

    expect(payload.available_cash).toBe(150000);
    expect(payload.total_asset).toBe(770000);
    expect(payload.today_order_count).toBe(2);
    expect(payload.today_trade_count).toBe(1);
    expect(payload.positions[0]).toEqual(expect.objectContaining({
      code: '600519',
      industry_name: '白酒',
      weight_pct: expect.any(Number),
      unrealized_return_pct: expect.any(Number),
    }));
    expect(payload.metrics).toEqual(expect.objectContaining({
      total_return_pct: 54,
      top1_position_pct: expect.any(Number),
      top3_position_pct: expect.any(Number),
      win_rate_pct: expect.any(Number),
      max_drawdown_pct: expect.any(Number),
      sharpe_ratio: expect.any(Number),
    }));
    expect(payload.exposures).toEqual(expect.objectContaining({
      by_industry: [
        expect.objectContaining({
          industry_name: '白酒',
          stock_count: 2,
          invested_weight_pct: 100,
        }),
      ],
    }));
    expect(payload.diagnostics).toEqual(expect.objectContaining({
      rebalancing_needed: true,
      alerts: expect.arrayContaining([
        expect.objectContaining({ code: 'single_stock_concentration' }),
        expect.objectContaining({ code: 'industry_overweight' }),
      ]),
    }));
  });
});
