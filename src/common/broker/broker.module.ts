import { Global, Module } from '@nestjs/common';

import { BrokerCryptoService } from '@/common/security/broker-crypto.service';

import { BacktraderAgentAdapter } from './backtrader-agent.adapter';
import { BrokerAdapterRegistry } from './broker-adapter.registry';

@Global()
@Module({
  providers: [
    BrokerCryptoService,
    BacktraderAgentAdapter,
    BrokerAdapterRegistry,
  ],
  exports: [
    BrokerCryptoService,
    BacktraderAgentAdapter,
    BrokerAdapterRegistry,
  ],
})
export class BrokerModule {}
