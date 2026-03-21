/** 股票分析模块的模块装配文件，用于声明控制器、服务与依赖关系。 */

import { Module } from '@nestjs/common';

import { AiRuntimeModule } from '@/common/ai/ai-runtime.module';
import { BrokerAccountsModule } from '@/modules/broker-accounts/broker-accounts.module';
import { SystemConfigModule } from '@/modules/system-config/system-config.module';
import { TradingAccountModule } from '@/modules/trading-account/trading-account.module';

import { AnalysisController } from './analysis.controller';
import { AnalysisSchedulerService } from './analysis-scheduler.service';
import { AnalysisService } from './analysis.service';
import { SchedulerHeartbeatService } from './scheduler-heartbeat.service';

@Module({
  imports: [AiRuntimeModule, BrokerAccountsModule, TradingAccountModule, SystemConfigModule],
  controllers: [AnalysisController],
  providers: [AnalysisService, AnalysisSchedulerService, SchedulerHeartbeatService],
  exports: [AnalysisService, AnalysisSchedulerService, SchedulerHeartbeatService],
})
/** 负责把该领域需要的控制器、服务与依赖声明组装到同一个 Nest 模块里。 */
export class AnalysisModule {}
