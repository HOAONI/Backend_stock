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
export class WorkerModule {}
