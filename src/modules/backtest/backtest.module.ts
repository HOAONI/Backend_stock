import { Module } from '@nestjs/common';

import { AnalysisModule } from '@/modules/analysis/analysis.module';

import { AgentBacktestService } from './agent-backtest.service';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { UserBacktestStrategyService } from './user-backtest-strategy.service';

@Module({
  imports: [AnalysisModule],
  controllers: [BacktestController],
  providers: [BacktestService, AgentBacktestService, UserBacktestStrategyService],
  exports: [BacktestService, AgentBacktestService, UserBacktestStrategyService],
})
export class BacktestModule {}
