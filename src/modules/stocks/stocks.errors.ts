/** 股票行情模块的错误定义，统一约束校验失败与上游失败语义。 */

export class StocksValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StocksValidationError';
  }
}

export class StocksUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StocksUpstreamError';
  }
}

export function isStocksValidationError(error: unknown): error is StocksValidationError {
  return error instanceof StocksValidationError;
}

export function isStocksUpstreamError(error: unknown): error is StocksUpstreamError {
  return error instanceof StocksUpstreamError;
}
