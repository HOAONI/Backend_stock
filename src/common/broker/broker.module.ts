import { Global, Module } from '@nestjs/common';

import { BrokerCryptoService } from '@/common/security/broker-crypto.service';

import { BrokerAdapterRegistry } from './broker-adapter.registry';
import { BrokerGatewayClient } from './broker-gateway.client';
import { FutuGatewayAdapter } from './futu-gateway.adapter';

@Global()
@Module({
  providers: [BrokerCryptoService, BrokerGatewayClient, FutuGatewayAdapter, BrokerAdapterRegistry],
  exports: [BrokerCryptoService, BrokerGatewayClient, FutuGatewayAdapter, BrokerAdapterRegistry],
})
export class BrokerModule {}
