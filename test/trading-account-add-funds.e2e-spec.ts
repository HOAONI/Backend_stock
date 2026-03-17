/** 模拟盘增资单测，覆盖 adapter 能力探测、快照回刷和 DTO 金额校验。 */

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { TradingAccountService } from '../src/modules/trading-account/trading-account.service';
import { AddFundsDto } from '../src/modules/trading-account/trading-account.dto';

describe('TradingAccount add funds', () => {
  it('adds funds and refreshes upstream snapshot', async () => {
    // access 表示当前用户已绑定好的模拟盘上下文，增资和快照刷新都基于它完成。
    const access = {
      userId: 1,
      brokerAccountId: 3,
      brokerCode: 'backtrader_local',
      environment: 'simulation',
      accountUid: 'bt-3',
      accountDisplayName: '测试账户',
      providerCode: 'backtrader_local',
      providerName: 'Backtrader Local Sim',
      credentials: {},
    };

    const adapter = {
      addFunds: jest.fn(async () => ({
        amount: 5000,
        cash_before: 1000,
        cash_after: 6000,
        initial_capital_before: 100000,
        initial_capital_after: 105000,
      })),
      getAccountSummary: jest.fn(async () => ({
        cash: 6000,
        total_asset: 106000,
        total_market_value: 100000,
        return_pct: 0.95,
      })),
      getPositions: jest.fn(async () => []),
      getOrders: jest.fn(async () => []),
      getTrades: jest.fn(async () => []),
    };

    const prisma = {
      userBrokerSnapshotCache: {
        upsert: jest.fn(async () => ({})),
      },
    } as any;
    const brokerAccountsService = {
      resolveSimulationAccess: jest.fn(async () => access),
    } as any;
    const brokerRegistry = {
      getAdapter: jest.fn(() => adapter),
    } as any;

    const service = new TradingAccountService(prisma, brokerAccountsService, brokerRegistry);
    const payload = await service.addFunds(1, {
      amount: 5000,
      note: '追加资金',
    });

    expect(adapter.addFunds).toHaveBeenCalledWith(access, {
      amount: 5000,
      note: '追加资金',
    });
    expect(adapter.getAccountSummary).toHaveBeenCalledTimes(1);
    expect(adapter.getPositions).toHaveBeenCalledTimes(1);
    expect(adapter.getOrders).toHaveBeenCalledTimes(1);
    expect(adapter.getTrades).toHaveBeenCalledTimes(1);
    expect(prisma.userBrokerSnapshotCache.upsert).toHaveBeenCalledTimes(1);
    expect(payload.fund_change).toMatchObject({
      amount: 5000,
      cash_before: 1000,
      cash_after: 6000,
      initial_capital_before: 100000,
      initial_capital_after: 105000,
    });
  });

  it('throws NOT_SUPPORTED when adapter has no addFunds capability', async () => {
    const prisma = {
      userBrokerSnapshotCache: {
        upsert: jest.fn(async () => ({})),
      },
    } as any;
    const brokerAccountsService = {
      resolveSimulationAccess: jest.fn(async () => ({
        userId: 1,
        brokerAccountId: 3,
        brokerCode: 'backtrader_local',
        environment: 'simulation',
        accountUid: 'bt-3',
        accountDisplayName: '测试账户',
        providerCode: 'backtrader_local',
        providerName: 'Backtrader Local Sim',
        credentials: {},
      })),
    } as any;
    const brokerRegistry = {
      getAdapter: jest.fn(() => ({
        getAccountSummary: jest.fn(async () => ({})),
        getPositions: jest.fn(async () => []),
        getOrders: jest.fn(async () => []),
        getTrades: jest.fn(async () => []),
      })),
    } as any;

    const service = new TradingAccountService(prisma, brokerAccountsService, brokerRegistry);
    await expect(service.addFunds(1, { amount: 1000 })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
  });

  it('rejects non-positive amount via DTO validation', () => {
    const dto = plainToInstance(AddFundsDto, { amount: 0 });
    const errors = validateSync(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
