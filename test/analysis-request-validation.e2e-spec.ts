import { AnalysisService } from '../src/modules/analysis/analysis.service';

describe('Analysis request validation', () => {
  const createService = (): AnalysisService =>
    new AnalysisService({} as any, {} as any, {} as any, {} as any, {} as any);

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
