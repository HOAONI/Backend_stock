import { Injectable } from '@nestjs/common';

import { BrokerAdapter, BrokerAccessContext, GatewayRequestPayload } from './broker.types';
import { BrokerGatewayClient } from './broker-gateway.client';

function toGatewayPayload(context: BrokerAccessContext): GatewayRequestPayload {
  return {
    user_id: context.userId,
    broker_account_id: context.brokerAccountId,
    environment: context.environment,
    account_uid: context.accountUid,
    account_display_name: context.accountDisplayName,
    credentials: context.credentials,
  };
}

function asArrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => item as Record<string, unknown>);
}

@Injectable()
export class FutuGatewayAdapter implements BrokerAdapter {
  readonly brokerCode = 'futu';

  constructor(private readonly gatewayClient: BrokerGatewayClient) {}

  async verify(context: BrokerAccessContext): Promise<Record<string, unknown>> {
    return await this.gatewayClient.post(this.brokerCode, 'verify', toGatewayPayload(context));
  }

  async getAccountSummary(context: BrokerAccessContext): Promise<Record<string, unknown>> {
    return await this.gatewayClient.post(this.brokerCode, 'account-summary', toGatewayPayload(context));
  }

  async getPositions(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>> {
    const payload = await this.gatewayClient.post(this.brokerCode, 'positions', toGatewayPayload(context));
    return asArrayOfRecords(payload.items ?? payload.positions ?? payload.data ?? []);
  }

  async getOrders(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>> {
    const payload = await this.gatewayClient.post(this.brokerCode, 'orders', toGatewayPayload(context));
    return asArrayOfRecords(payload.items ?? payload.orders ?? payload.data ?? []);
  }

  async getTrades(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>> {
    const payload = await this.gatewayClient.post(this.brokerCode, 'trades', toGatewayPayload(context));
    return asArrayOfRecords(payload.items ?? payload.trades ?? payload.data ?? []);
  }
}
