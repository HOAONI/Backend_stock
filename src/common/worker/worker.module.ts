import { Module } from '@nestjs/common';

import { AgentClientModule } from '@/common/agent/agent-client.module';
import { PrismaModule } from '@/common/database/prisma.module';
import { AnalysisModule } from '@/modules/analysis/analysis.module';
import { TradingAccountModule } from '@/modules/trading-account/trading-account.module';

import { TaskWorkerService } from './task-worker.service';

@Module({
  imports: [PrismaModule, AgentClientModule, AnalysisModule, TradingAccountModule],
  providers: [TaskWorkerService],
  exports: [TaskWorkerService],
})
export class WorkerModule {}
