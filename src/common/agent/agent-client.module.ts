import { Global, Module } from '@nestjs/common';

import { AgentClientService } from './agent-client.service';
import { AgentRunBridgeService } from './agent-run-bridge.service';

@Global()
@Module({
  providers: [AgentClientService, AgentRunBridgeService],
  exports: [AgentClientService, AgentRunBridgeService],
})
export class AgentClientModule {}
