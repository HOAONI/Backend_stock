import { Module } from '@nestjs/common';

import { BrokerAccountsModule } from '@/modules/broker-accounts/broker-accounts.module';

import { AgentBridgeController } from './agent-bridge.controller';
import { AgentBridgeService } from './agent-bridge.service';

@Module({
  imports: [BrokerAccountsModule],
  controllers: [AgentBridgeController],
  providers: [AgentBridgeService],
  exports: [AgentBridgeService],
})
export class AgentBridgeModule {}
