/** 批量重算历史回测结果，适合在规则或指标版本变更后统一回刷。 */

import { NestFactory } from '@nestjs/core';

import { AppModule } from '@/app.module';
import { BacktestService } from '@/modules/backtest/backtest.service';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(parsed));
}

async function main(): Promise<void> {
  const evalWindowDays = parsePositiveInt(process.env.BACKTEST_RECOMPUTE_EVAL_WINDOW_DAYS, Number(process.env.BACKTEST_EVAL_WINDOW_DAYS ?? 10));
  const minAgeDays = parsePositiveInt(process.env.BACKTEST_RECOMPUTE_MIN_AGE_DAYS, Number(process.env.BACKTEST_MIN_AGE_DAYS ?? 14));
  const batchSize = Math.min(
    parsePositiveInt(process.env.BACKTEST_RECOMPUTE_BATCH_SIZE, 500),
    5000,
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const backtestService = app.get(BacktestService);
    console.log(
      `[backtest-recompute-all] start eval_window_days=${evalWindowDays} min_age_days=${minAgeDays} batch_size=${batchSize}`,
    );

    const result = await backtestService.recomputeAll({
      evalWindowDays,
      minAgeDays,
      batchSize,
      scope: { userId: 0, includeAll: true },
    });

    console.log('[backtest-recompute-all] finished', result);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('[backtest-recompute-all] failed', error);
  process.exitCode = 1;
});
