import { Module } from '@nestjs/common';

import { AiRuntimeModule } from '@/common/ai/ai-runtime.module';
import { BrokerAccountsModule } from '@/modules/broker-accounts/broker-accounts.module';
import { TradingAccountModule } from '@/modules/trading-account/trading-account.module';

import { AnalysisController } from './analysis.controller';
import { AnalysisSchedulerService } from './analysis-scheduler.service';
import { AnalysisService } from './analysis.service';

@Module({
  imports: [AiRuntimeModule, BrokerAccountsModule, TradingAccountModule],
  controllers: [AnalysisController],
  providers: [AnalysisService, AnalysisSchedulerService],
  exports: [AnalysisService, AnalysisSchedulerService],
})
export class AnalysisModule {}
