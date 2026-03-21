/** 分析请求归一化单测，确保 v1 单股票接口不会把多股票输入悄悄截断。 */

import { AnalysisService } from '../src/modules/analysis/analysis.service';

describe('Analysis request validation', () => {
  // 这里只验证参数归一化，不需要真实依赖注入，直接构造最小 service 即可。
  const createService = (): AnalysisService =>
    new AnalysisService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

  it('rejects multi-stock payloads to avoid silent truncation', () => {
    const service = createService();

    expect(() =>
      service.normalizeRequest({
        stock_codes: ['600519', '000001'],
      } as any),
    ).toThrow('当前接口仅支持单股票分析，请仅传入一个 stock_code');
  });

  it('accepts single stock input', () => {
    const service = createService();
    const normalized = service.normalizeRequest({
      stock_codes: ['600519'],
    } as any);

    expect(normalized.stockCode).toBe('600519');
  });
});
