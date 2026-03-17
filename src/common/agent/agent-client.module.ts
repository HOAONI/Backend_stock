/** Agent 通信基础设施的模块装配文件，用于声明控制器、服务与依赖关系。 */

import { Global, Module } from '@nestjs/common';

import { AgentClientService } from './agent-client.service';
import { AgentRunBridgeService } from './agent-run-bridge.service';
import { BacktestAgentClientService } from './backtest-agent-client.service';

@Global()
@Module({
  providers: [AgentClientService, AgentRunBridgeService, BacktestAgentClientService],
  exports: [AgentClientService, AgentRunBridgeService, BacktestAgentClientService],
})
/** 负责把该领域需要的控制器、服务与依赖声明组装到同一个 Nest 模块里。 */
export class AgentClientModule {}
