/** Nest 应用启动入口，负责环境加载、全局中间件和 OpenAPI 初始化。 */

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
import { getPersonalSecretStatus } from './common/security/personal-crypto.service';
import { AgentBacktestWorkerService } from './common/worker/agent-backtest-worker.service';
import { TaskWorkerService } from './common/worker/task-worker.service';

// 允许脚本或不同启动器通过 ENV_FILE 覆盖默认 .env，避免在入口之外复制环境加载逻辑。
function setupEnv(): void {
  const envFile = process.env.ENV_FILE;
  const resolved = envFile ? path.resolve(envFile) : path.resolve(process.cwd(), '.env');
  if (fs.existsSync(resolved)) {
    dotenv.config({ path: resolved, override: true });
  }
}

// 本地常用前端端口默认放行，能降低开发环境接入成本；生产环境再通过 CORS_ORIGINS 精确收敛。
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

// 启动阶段强制校验回测表是否齐全，避免服务已经监听端口后才在首次请求时暴露 schema 缺失。
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

// 启动顺序刻意保持为“环境 -> 启动前自检 -> Nest App 初始化”，这样失败能尽量早暴露。
async function bootstrap(): Promise<void> {
  setupEnv();
  const personalSecretStatus = getPersonalSecretStatus();
  if (!personalSecretStatus.available) {
    Logger.warn(`个人 AI 绑定不可用：${personalSecretStatus.issue}`, 'Bootstrap');
  }
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
    // 嵌入式 worker 只用于本地开发或单进程部署，避免默认情况下 API/Worker 相互重复消费任务。
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

  // SIGINT/SIGTERM 共用同一套收尾逻辑，避免只关 API 不关内嵌 worker。
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
