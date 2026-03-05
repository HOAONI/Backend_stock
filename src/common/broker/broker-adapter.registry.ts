import { Injectable } from '@nestjs/common';

import { BacktraderAgentAdapter } from './backtrader-agent.adapter';
import { BrokerAdapter } from './broker.types';

@Injectable()
export class BrokerAdapterRegistry {
  private readonly adapters: Map<string, BrokerAdapter>;

  constructor(backtraderAgentAdapter: BacktraderAgentAdapter) {
    const adapters = new Map<string, BrokerAdapter>([
      [backtraderAgentAdapter.brokerCode, backtraderAgentAdapter],
    ]);

    this.adapters = adapters;
  }

  getSupportedBrokers(): string[] {
    return Array.from(this.adapters.keys()).sort();
  }

  getAdapter(brokerCode: string): BrokerAdapter {
    const normalized = String(brokerCode ?? '').trim().toLowerCase();
    const adapter = this.adapters.get(normalized);
    if (!adapter) {
      throw new Error(`Unsupported broker: ${normalized || '(empty)'}`);
    }
    return adapter;
  }
}
