/** 后台 Worker 基础设施的模块装配文件，用于声明控制器、服务与依赖关系。 */

import { Module } from '@nestjs/common';

import { AgentClientModule } from '@/common/agent/agent-client.module';
import { PrismaModule } from '@/common/database/prisma.module';
import { AnalysisModule } from '@/modules/analysis/analysis.module';
import { BacktestModule } from '@/modules/backtest/backtest.module';
import { TradingAccountModule } from '@/modules/trading-account/trading-account.module';

import { AgentBacktestWorkerService } from './agent-backtest-worker.service';
import { TaskWorkerService } from './task-worker.service';

@Module({
  imports: [PrismaModule, AgentClientModule, AnalysisModule, TradingAccountModule, BacktestModule],
  providers: [TaskWorkerService, AgentBacktestWorkerService],
  exports: [TaskWorkerService, AgentBacktestWorkerService],
})
/** 负责把该领域需要的控制器、服务与依赖声明组装到同一个 Nest 模块里。 */
export class WorkerModule {}
