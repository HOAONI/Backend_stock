/** 策略回测 AI 解读 Worker，负责异步消费持久化队列并生成中文解读。 */

import { Injectable, Logger } from '@nestjs/common';

import { BacktestAiInterpretationService } from '@/modules/backtest/backtest-ai-interpretation.service';

@Injectable()
export class StrategyBacktestAiWorkerService {
  private readonly logger = new Logger(StrategyBacktestAiWorkerService.name);
  private running = false;

  constructor(
    private readonly backtestAiInterpretationService: BacktestAiInterpretationService,
  ) {}

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.logger.log('Strategy backtest AI worker started');

    while (this.running) {
      try {
        const processed = await this.backtestAiInterpretationService.processNextStrategyRunGroupJob();
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
