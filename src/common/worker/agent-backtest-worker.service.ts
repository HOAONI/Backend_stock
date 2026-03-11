import { Injectable, Logger } from '@nestjs/common';

import { AgentBacktestService } from '@/modules/backtest/agent-backtest.service';

@Injectable()
export class AgentBacktestWorkerService {
  private readonly logger = new Logger(AgentBacktestWorkerService.name);
  private running = false;

  constructor(private readonly agentBacktestService: AgentBacktestService) {}

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
