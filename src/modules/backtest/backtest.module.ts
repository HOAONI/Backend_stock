/** 回测模块的模块装配文件，用于声明控制器、服务与依赖关系。 */

import { Module } from '@nestjs/common';

import { AiRuntimeModule } from '@/common/ai/ai-runtime.module';
import { AnalysisModule } from '@/modules/analysis/analysis.module';

import { AgentBacktestService } from './agent-backtest.service';
import { BacktestAiInterpretationService } from './backtest-ai-interpretation.service';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { UserBacktestStrategyService } from './user-backtest-strategy.service';

@Module({
  imports: [AnalysisModule, AiRuntimeModule],
  controllers: [BacktestController],
  providers: [BacktestService, AgentBacktestService, BacktestAiInterpretationService, UserBacktestStrategyService],
  exports: [BacktestService, AgentBacktestService, BacktestAiInterpretationService, UserBacktestStrategyService],
})
/** 负责把该领域需要的控制器、服务与依赖声明组装到同一个 Nest 模块里。 */
export class BacktestModule {}
