import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { PrismaClient } from '@prisma/client';
import cookieParser from 'cookie-parser';
import * as dotenv from 'dotenv';

import { AppModule } from './app.module';
import { STRATEGY_BACKTEST_SCHEMA_NOT_READY_MESSAGE, getBacktestStorageReadiness } from './common/backtest/backtest-storage-readiness';
import { GlobalHttpExceptionFilter } from './common/errors/http-exception.filter';
import { AgentBacktestWorkerService } from './common/worker/agent-backtest-worker.service';
import { TaskWorkerService } from './common/worker/task-worker.service';

function setupEnv(): void {
  const envFile = process.env.ENV_FILE;
  const resolved = envFile ? path.resolve(envFile) : path.resolve(process.cwd(), '.env');
  if (fs.existsSync(resolved)) {
    dotenv.config({ path: resolved, override: true });
  }
}

function parseOrigins(): string[] {
  const allowAll = (process.env.CORS_ALLOW_ALL ?? 'false').toLowerCase() === 'true';
  if (allowAll) {
    return ['*'];
  }

  const raw = process.env.CORS_ORIGINS ?? '';
  const defaults = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'http://127.0.0.1:3000'];
  const extras = raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return Array.from(new Set([...defaults, ...extras]));
}

function runWorkerInApiProcess(): boolean {
  return (process.env.RUN_WORKER_IN_API ?? 'false').toLowerCase() === 'true';
}

async function assertBacktestStorageReady(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const readiness = await getBacktestStorageReadiness(prisma);
    if (readiness.ready) {
      return;
    }

    const missing = readiness.missingTables.join(', ');
    throw new Error(
      `${STRATEGY_BACKTEST_SCHEMA_NOT_READY_MESSAGE}; schema=${readiness.schema}; missing_tables=${missing}; run pnpm db:push or pnpm prisma:deploy`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function bootstrap(): Promise<void> {
  setupEnv();
  await assertBacktestStorageReady();

  const app = await NestFactory.create(AppModule, {
    cors: false,
  });

  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      forbidUnknownValues: false,
    }),
  );
  app.useGlobalFilters(new GlobalHttpExceptionFilter());

  const openapiConfig = new DocumentBuilder()
    .setTitle('Backend_stock API')
    .setDescription('Daily Stock Analysis backend (Node.js + NestJS)')
    .setVersion('1.0.0')
    .build();
  const openapiDocument = SwaggerModule.createDocument(app, openapiConfig);
  SwaggerModule.setup('docs', app, openapiDocument, {
    jsonDocumentUrl: 'openapi.json',
  });

  const origins = parseOrigins();
  app.enableCors({
    origin: origins.includes('*') ? true : origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  });

  const host = process.env.HOST ?? '0.0.0.0';
  const port = Number(process.env.PORT ?? '8002');

  await app.listen(port, host);
  Logger.log(`Backend_stock listening on http://${host}:${port}`, 'Bootstrap');

  const workerServices: Array<{ start: () => Promise<void>; stop: () => void }> = [];
  if (runWorkerInApiProcess()) {
    workerServices.push(app.get(TaskWorkerService));
    workerServices.push(app.get(AgentBacktestWorkerService));
    workerServices.forEach((embeddedWorker) => {
      void embeddedWorker.start().catch((error: unknown) => {
        const logger = new Logger('EmbeddedWorker');
        logger.error(error instanceof Error ? error.stack : String(error));
      });
    });
    Logger.log('Embedded worker enabled in API process', 'Bootstrap');
  }

  const shutdown = async (): Promise<void> => {
    workerServices.forEach(service => service.stop());
    await app.close();
  };

  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
}

bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
