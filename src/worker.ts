import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { TaskWorkerService } from './common/worker/task-worker.service';
import { WorkerModule } from './common/worker/worker.module';

function setupEnv(): void {
  const envFile = process.env.ENV_FILE;
  const resolved = envFile ? path.resolve(envFile) : path.resolve(process.cwd(), '.env');
  if (fs.existsSync(resolved)) {
    dotenv.config({ path: resolved, override: true });
  }
}

async function bootstrapWorker(): Promise<void> {
  setupEnv();

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });

  const service = app.get(TaskWorkerService);

  process.on('SIGINT', async () => {
    service.stop();
    await app.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    service.stop();
    await app.close();
    process.exit(0);
  });

  await service.start();
}

bootstrapWorker().catch((error: unknown) => {
  const logger = new Logger('WorkerBootstrap');
  logger.error((error as Error).stack || String(error));
  process.exit(1);
});
