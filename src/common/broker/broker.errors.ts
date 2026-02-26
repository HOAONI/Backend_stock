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
