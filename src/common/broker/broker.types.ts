/** 券商适配基础设施使用的共享类型约定。 */

export interface BrokerAccessContext {
  userId: number;
  brokerAccountId: number;
  brokerCode: string;
  environment: 'paper' | 'simulation';
  accountUid: string;
  accountDisplayName: string | null;
  providerCode?: string | null;
  providerName?: string | null;
  credentials: Record<string, unknown>;
}

export interface BrokerAdapter {
  readonly brokerCode: string;
  verify(context: BrokerAccessContext): Promise<Record<string, unknown>>;
  getAccountSummary(context: BrokerAccessContext): Promise<Record<string, unknown>>;
  getPositions(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>>;
  getOrders(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>>;
  getTrades(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>>;
  placeOrder?(
    context: BrokerAccessContext,
    order: OrderRequest,
    options?: { idempotencyKey?: string | null; payload?: Record<string, unknown> | null },
  ): Promise<Record<string, unknown>>;
  cancelOrder?(
    context: BrokerAccessContext,
    orderId: string,
    options?: { idempotencyKey?: string | null; payload?: Record<string, unknown> | null },
  ): Promise<Record<string, unknown>>;
  addFunds?(
    context: BrokerAccessContext,
    input: AddFundsRequest,
    options?: { idempotencyKey?: string | null; payload?: Record<string, unknown> | null },
  ): Promise<Record<string, unknown>>;
}

export interface OrderRequest {
  orderId: string;
  stockCode: string;
  stockName?: string;
  direction: 'buy' | 'sell';
  type: 'limit' | 'market';
  price: number;
  quantity: number;
}

export interface OrderResponse {
  orderId: string;
  status: 'pending' | 'filled' | 'partial_filled' | 'cancelled' | 'rejected';
  filledQuantity: number;
  filledPrice: number | null;
  message?: string;
}

export interface AddFundsRequest {
  amount: number;
  note?: string;
}

export interface GatewayRequestPayload {
  user_id: number;
  broker_account_id: number;
  environment: string;
  account_uid: string;
  account_display_name: string | null;
  provider_code?: string | null;
  provider_name?: string | null;
  payload?: Record<string, unknown>;
  idempotency_key?: string | null;
  credentials: Record<string, unknown>;
}
