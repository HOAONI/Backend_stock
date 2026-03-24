/** StocksService 单测，验证行情页统一透传当前全局行情源。 */

import { StocksValidationError } from '../src/modules/stocks/stocks.errors';
import { StocksService } from '../src/modules/stocks/stocks.service';

describe('StocksService', () => {
  const createService = (overrides?: {
    marketSource?: string;
    getInternalStockQuote?: jest.Mock;
    getInternalStockHistory?: jest.Mock;
    getInternalStockIndicators?: jest.Mock;
    getInternalStockFactors?: jest.Mock;
  }) => {
    const agentClient = {
      getInternalStockQuote: overrides?.getInternalStockQuote ?? jest.fn(),
      getInternalStockHistory: overrides?.getInternalStockHistory ?? jest.fn(),
      getInternalStockIndicators: overrides?.getInternalStockIndicators ?? jest.fn(),
      getInternalStockFactors: overrides?.getInternalStockFactors ?? jest.fn(),
    };
    const configService = {
      getCurrentMarketSource: jest.fn(async () => overrides?.marketSource ?? 'sina'),
    };
    return {
      service: new StocksService(agentClient as any, configService as any),
      agentClient,
      configService,
    };
  };

  it('forwards realtime quote requests with current market source', async () => {
    const payload = {
      stock_code: '600519',
      stock_name: '贵州茅台',
      current_price: 1452.87,
      source: 'tencent',
      requested_source: 'eastmoney',
      warning: '实时行情源 东方财富 暂不可用，已自动降级到 腾讯行情',
    };
    const { service, agentClient, configService } = createService({
      marketSource: 'eastmoney',
      getInternalStockQuote: jest.fn(async () => payload),
    });

    await expect(service.getRealtimeQuote('SH600519')).resolves.toBe(payload);
    expect(configService.getCurrentMarketSource).toHaveBeenCalledTimes(1);
    expect(agentClient.getInternalStockQuote).toHaveBeenCalledWith('600519', 'eastmoney');
  });

  it('forwards history, indicators and factors through Agent internal market API', async () => {
    const { service, agentClient } = createService({
      marketSource: 'eastmoney',
      getInternalStockHistory: jest.fn(async () => ({ stock_code: '600519', data: [], source: 'eastmoney' })),
      getInternalStockIndicators: jest.fn(async () => ({ stock_code: '600519', items: [], source: 'eastmoney' })),
      getInternalStockFactors: jest.fn(async () => ({ stock_code: '600519', factors: {}, source: 'eastmoney' })),
    });

    await expect(service.getHistory('600519', 30)).resolves.toMatchObject({ source: 'eastmoney' });
    await expect(service.getIndicators('600519', 120, [5, 10, 20, 60])).resolves.toMatchObject({ source: 'eastmoney' });
    await expect(service.getFactors('600519', '2026-03-20')).resolves.toMatchObject({ source: 'eastmoney' });

    expect(agentClient.getInternalStockHistory).toHaveBeenCalledWith('600519', 'eastmoney', 30);
    expect(agentClient.getInternalStockIndicators).toHaveBeenCalledWith('600519', 'eastmoney', 120, [5, 10, 20, 60]);
    expect(agentClient.getInternalStockFactors).toHaveBeenCalledWith('600519', 'eastmoney', '2026-03-20');
  });

  it('rejects non A-share inputs before requesting upstream', async () => {
    const { service, agentClient } = createService();

    await expect(service.getRealtimeQuote('00700')).rejects.toBeInstanceOf(StocksValidationError);
    await expect(service.getHistory('AAPL', 30)).rejects.toBeInstanceOf(StocksValidationError);
    expect(agentClient.getInternalStockQuote).not.toHaveBeenCalled();
    expect(agentClient.getInternalStockHistory).not.toHaveBeenCalled();
  });
});
