/** 券商适配基础设施的注册中心，用于维护适配器发现与分发。 */

import { Injectable } from '@nestjs/common';

import { BacktraderAgentAdapter } from './backtrader-agent.adapter';
import { BrokerAdapter } from './broker.types';

/** 负责维护适配器与实现的查找关系，避免业务层直接感知具体实现。 */
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
