import { Injectable } from '@nestjs/common';

import { BrokerAdapter } from './broker.types';
import { FutuGatewayAdapter } from './futu-gateway.adapter';
import { SimulationAdapter } from './simulation.adapter';

@Injectable()
export class BrokerAdapterRegistry {
  private readonly adapters: Map<string, BrokerAdapter>;

  constructor(
    futuAdapter: FutuGatewayAdapter,
    simulationAdapter: SimulationAdapter,
  ) {
    this.adapters = new Map<string, BrokerAdapter>([
      [futuAdapter.brokerCode, futuAdapter],
      [simulationAdapter.brokerCode, simulationAdapter],
    ]);
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
