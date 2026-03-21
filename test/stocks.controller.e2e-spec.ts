/** StocksController 单测，验证 A 股输入限制与腾讯上游错误状态码映射。 */

import { HttpException } from '@nestjs/common';

import { StocksController } from '../src/modules/stocks/stocks.controller';
import { StocksUpstreamError, StocksValidationError } from '../src/modules/stocks/stocks.errors';

describe('StocksController', () => {
  const createController = (overrides?: {
    getRealtimeQuote?: jest.Mock;
    getHistory?: jest.Mock;
    getIndicators?: jest.Mock;
    getFactors?: jest.Mock;
  }) =>
    new StocksController({
      getRealtimeQuote: overrides?.getRealtimeQuote ?? jest.fn(),
      getHistory: overrides?.getHistory ?? jest.fn(),
      getIndicators: overrides?.getIndicators ?? jest.fn(),
      getFactors: overrides?.getFactors ?? jest.fn(),
    } as any, {} as any);

  async function expectHttpError(
    action: Promise<unknown>,
    status: number,
    errorCode: string,
    message: string,
  ) {
    try {
      await action;
      throw new Error('expected HttpException');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(HttpException);
      const exception = error as HttpException;
      expect(exception.getStatus()).toBe(status);
      expect(exception.getResponse()).toMatchObject({
        error: errorCode,
        message,
      });
    }
  }

  it('maps A-share validation failures to 422', async () => {
    const controller = createController({
      getRealtimeQuote: jest.fn(async () => {
        throw new StocksValidationError('A股行情页仅支持 SH/SZ/6 位代码');
      }),
    });

    await expectHttpError(
      controller.getQuote('00700'),
      422,
      'validation_error',
      'A股行情页仅支持 SH/SZ/6 位代码',
    );
  });

  it('maps Tencent upstream failures to 502', async () => {
    const controller = createController({
      getHistory: jest.fn(async () => {
        throw new StocksUpstreamError('eastmoney history returned no rows');
      }),
    });

    await expectHttpError(
      controller.getHistory('600519', 'daily', '30'),
      502,
      'upstream_error',
      '获取历史数据失败: eastmoney history returned no rows',
    );
  });

  it('returns successful quote payloads unchanged', async () => {
    const payload = {
      stock_code: '600519',
      stock_name: '贵州茅台',
      source: 'sina',
    };
    const controller = createController({
      getRealtimeQuote: jest.fn(async () => payload),
    });

    await expect(controller.getQuote('600519')).resolves.toBe(payload);
  });
});
