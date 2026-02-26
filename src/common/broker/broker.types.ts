export interface BrokerAccessContext {
  userId: number;
  brokerAccountId: number;
  brokerCode: string;
  environment: 'paper' | 'simulation';
  accountUid: string;
  accountDisplayName: string | null;
  credentials: Record<string, unknown>;
}

export interface BrokerAdapter {
  readonly brokerCode: string;
  verify(context: BrokerAccessContext): Promise<Record<string, unknown>>;
  getAccountSummary(context: BrokerAccessContext): Promise<Record<string, unknown>>;
  getPositions(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>>;
  getOrders(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>>;
  getTrades(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>>;
  placeOrder?(context: BrokerAccessContext, order: OrderRequest): Promise<Record<string, unknown>>;
  cancelOrder?(context: BrokerAccessContext, orderId: string): Promise<Record<string, unknown>>;
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

export interface GatewayRequestPayload {
  user_id: number;
  broker_account_id: number;
  environment: string;
  account_uid: string;
  account_display_name: string | null;
  credentials: Record<string, unknown>;
}
