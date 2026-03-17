/** 券商适配基础设施使用的错误定义，统一约束跨层错误语义。 */

export class BrokerGatewayError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(message: string, code: string, options?: { statusCode?: number; retryable?: boolean }) {
    super(message);
    this.name = 'BrokerGatewayError';
    this.code = code;
    this.statusCode = options?.statusCode;
    this.retryable = Boolean(options?.retryable);
  }
}

export function isBrokerGatewayError(error: unknown): error is BrokerGatewayError {
  return error instanceof BrokerGatewayError;
}
