/** 独立 Worker 进程入口，负责启动异步任务与回测工作线程。 */

import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AgentBacktestWorkerService } from './common/worker/agent-backtest-worker.service';
import { StrategyBacktestAiWorkerService } from './common/worker/strategy-backtest-ai-worker.service';
import { TaskWorkerService } from './common/worker/task-worker.service';
import { WorkerModule } from './common/worker/worker.module';

// Worker 进程和 API 进程共用同一套环境装载方式，避免行为只在某一个入口下成立。
function setupEnv(): void {
  const envFile = process.env.ENV_FILE;
  const resolved = envFile ? path.resolve(envFile) : path.resolve(process.cwd(), '.env');
  if (fs.existsSync(resolved)) {
    dotenv.config({ path: resolved, override: true });
  }
}

// 独立 worker 只创建应用上下文，不监听 HTTP 端口，避免和 API 进程职责混杂。
async function bootstrapWorker(): Promise<void> {
  setupEnv();

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });

  const services = [
    app.get(TaskWorkerService),
    app.get(AgentBacktestWorkerService),
    app.get(StrategyBacktestAiWorkerService),
  ];

  // 统一在信号处理里先停轮询，再关闭 Nest 上下文，避免中途退出留下半处理任务。
  process.on('SIGINT', async () => {
    services.forEach(service => service.stop());
    await app.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    services.forEach(service => service.stop());
    await app.close();
    process.exit(0);
  });

  // 两类 worker 并行运行，但它们内部各自做串行消费与自我节流。
  await Promise.all(services.map(service => service.start()));
}

bootstrapWorker().catch((error: unknown) => {
  const logger = new Logger('WorkerBootstrap');
  logger.error((error as Error).stack || String(error));
  process.exit(1);
});
