import { Global, Module } from '@nestjs/common';

import { AgentClientService } from './agent-client.service';
import { AgentRunBridgeService } from './agent-run-bridge.service';
import { BacktestAgentClientService } from './backtest-agent-client.service';

@Global()
@Module({
  providers: [AgentClientService, AgentRunBridgeService, BacktestAgentClientService],
  exports: [AgentClientService, AgentRunBridgeService, BacktestAgentClientService],
})
export class AgentClientModule {}
