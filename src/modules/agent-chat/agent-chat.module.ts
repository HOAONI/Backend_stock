/** Agent 问股模块装配。 */

import { Module } from '@nestjs/common';

import { AnalysisModule } from '@/modules/analysis/analysis.module';
import { BrokerAccountsModule } from '@/modules/broker-accounts/broker-accounts.module';
import { TradingAccountModule } from '@/modules/trading-account/trading-account.module';

import { AgentChatController } from './agent-chat.controller';
import { AgentChatInternalController } from './agent-chat.internal.controller';
import { AgentChatService } from './agent-chat.service';

@Module({
  imports: [AnalysisModule, BrokerAccountsModule, TradingAccountModule],
  controllers: [AgentChatController, AgentChatInternalController],
  providers: [AgentChatService],
  exports: [AgentChatService],
})
/** 负责把 Agent 问股的控制器、服务与依赖组装到一个模块里。 */
export class AgentChatModule {}
