/** 后台 Worker 基础设施的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable, Logger } from '@nestjs/common';

import { AgentBacktestService } from '@/modules/backtest/agent-backtest.service';

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class AgentBacktestWorkerService {
  private readonly logger = new Logger(AgentBacktestWorkerService.name);
  private running = false;

  constructor(private readonly agentBacktestService: AgentBacktestService) {}

  // 精修 worker 常驻轮询 refine 队列；没有任务时主动 sleep，避免空转打满 CPU。
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.logger.log('Agent backtest worker started');

    while (this.running) {
      try {
        const processed = await this.agentBacktestService.processNextRefineJob();
        if (!processed) {
          await this.sleep(2000);
        }
      } catch (error: unknown) {
        this.logger.error((error as Error).stack || (error as Error).message);
        await this.sleep(2500);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, ms));
  }
}
