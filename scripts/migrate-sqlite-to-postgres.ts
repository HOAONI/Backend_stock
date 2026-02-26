import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import * as dotenv from 'dotenv';
import { AnalysisTaskStatus, Prisma, PrismaClient } from '@prisma/client';

type SQLiteRow = Record<string, unknown>;

const PY_SQL_RUNNER = `
import sqlite3
import json
import sys

db_path = sys.argv[1]
sql = sys.argv[2]
params = json.loads(sys.argv[3])

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
try:
    cur = conn.execute(sql, params)
    rows = [dict(r) for r in cur.fetchall()]
    print(json.dumps(rows, ensure_ascii=False))
finally:
    conn.close()
`;

class PySqliteDatabase {
  constructor(private readonly dbPath: string) {}

  prepare(sql: string): { all: (...params: unknown[]) => SQLiteRow[]; get: (...params: unknown[]) => SQLiteRow | undefined } {
    const execute = (...params: unknown[]): SQLiteRow[] => {
      const output = execFileSync('python3', ['-c', PY_SQL_RUNNER, this.dbPath, sql, JSON.stringify(params)], {
        encoding: 'utf8',
      });
      const text = String(output || '').trim();
      if (!text) return [];
      return JSON.parse(text) as SQLiteRow[];
    };

    return {
      all: (...params: unknown[]) => execute(...params),
      get: (...params: unknown[]) => execute(...params)[0],
    };
  }

  close(): void {
    // No persistent handle to close in Python-backed adapter.
  }
}

function setupEnv(): void {
  const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
  }
}

async function getCheckpoint(prisma: PrismaClient, key: string): Promise<number> {
  const row = await prisma.migrationCheckpoint.findUnique({ where: { key } });
  if (!row) return 0;
  const value = Number(row.value);
  return Number.isFinite(value) ? value : 0;
}

async function setCheckpoint(prisma: PrismaClient, key: string, value: number): Promise<void> {
  await prisma.migrationCheckpoint.upsert({
    where: { key },
    update: { value: String(value) },
    create: { key, value: String(value) },
  });
}

function readBatch(db: any, table: string, lastId: number, batchSize: number): SQLiteRow[] {
  const stmt = db.prepare(`SELECT * FROM ${table} WHERE id > ? ORDER BY id ASC LIMIT ?`);
  return stmt.all(lastId, batchSize) as SQLiteRow[];
}

function tableExists(db: any, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function toBoolean(input: unknown): boolean | null {
  if (input == null) return null;
  if (typeof input === 'boolean') return input;
  if (typeof input === 'number') return input !== 0;
  const value = String(input).trim().toLowerCase();
  if (['1', 'true', 't', 'yes', 'y'].includes(value)) return true;
  if (['0', 'false', 'f', 'no', 'n'].includes(value)) return false;
  return null;
}

function toJson(input: unknown): Prisma.InputJsonValue | undefined {
  if (input == null) return undefined;
  if (typeof input === 'object') return input as Prisma.InputJsonValue;
  const value = String(input).trim();
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}

function toTaskStatus(input: unknown): AnalysisTaskStatus {
  const value = String(input ?? '').trim().toLowerCase();
  if (value === 'processing') return AnalysisTaskStatus.processing;
  if (value === 'completed') return AnalysisTaskStatus.completed;
  if (value === 'failed') return AnalysisTaskStatus.failed;
  return AnalysisTaskStatus.pending;
}

function toDate(input: unknown): Date | null {
  if (input == null) return null;
  const value = String(input).trim();
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function migrateAnalysisHistory(prisma: PrismaClient, sqlite: any, batchSize: number): Promise<void> {
  let checkpoint = await getCheckpoint(prisma, 'analysis_history');
  while (true) {
    const rows = readBatch(sqlite, 'analysis_history', checkpoint, batchSize);
    if (rows.length === 0) break;

    await prisma.analysisHistory.createMany({
      data: rows.map((row) => ({
        id: Number(row.id),
        queryId: (row.query_id as string | null) ?? null,
        code: String(row.code ?? ''),
        name: (row.name as string | null) ?? null,
        reportType: (row.report_type as string | null) ?? null,
        sentimentScore: row.sentiment_score != null ? Number(row.sentiment_score) : null,
        operationAdvice: (row.operation_advice as string | null) ?? null,
        trendPrediction: (row.trend_prediction as string | null) ?? null,
        analysisSummary: (row.analysis_summary as string | null) ?? null,
        rawResult: (row.raw_result as string | null) ?? null,
        newsContent: (row.news_content as string | null) ?? null,
        contextSnapshot: (row.context_snapshot as string | null) ?? null,
        idealBuy: row.ideal_buy != null ? Number(row.ideal_buy) : null,
        secondaryBuy: row.secondary_buy != null ? Number(row.secondary_buy) : null,
        stopLoss: row.stop_loss != null ? Number(row.stop_loss) : null,
        takeProfit: row.take_profit != null ? Number(row.take_profit) : null,
        createdAt: toDate(row.created_at) ?? new Date(),
      })),
      skipDuplicates: true,
    });

    checkpoint = Number(rows[rows.length - 1].id);
    await setCheckpoint(prisma, 'analysis_history', checkpoint);
    console.log(`[analysis_history] migrated up to id=${checkpoint}`);
  }
}

async function migrateNewsIntel(prisma: PrismaClient, sqlite: any, batchSize: number): Promise<void> {
  let checkpoint = await getCheckpoint(prisma, 'news_intel');
  while (true) {
    const rows = readBatch(sqlite, 'news_intel', checkpoint, batchSize);
    if (rows.length === 0) break;

    await prisma.newsIntel.createMany({
      data: rows.map((row) => ({
        id: Number(row.id),
        queryId: (row.query_id as string | null) ?? null,
        code: String(row.code ?? ''),
        name: (row.name as string | null) ?? null,
        dimension: (row.dimension as string | null) ?? null,
        query: (row.query as string | null) ?? null,
        provider: (row.provider as string | null) ?? null,
        title: String(row.title ?? ''),
        snippet: (row.snippet as string | null) ?? null,
        url: String(row.url ?? ''),
        source: (row.source as string | null) ?? null,
        publishedDate: toDate(row.published_date),
        fetchedAt: toDate(row.fetched_at) ?? new Date(),
        querySource: (row.query_source as string | null) ?? null,
        requesterPlatform: (row.requester_platform as string | null) ?? null,
        requesterUserId: (row.requester_user_id as string | null) ?? null,
        requesterUserName: (row.requester_user_name as string | null) ?? null,
        requesterChatId: (row.requester_chat_id as string | null) ?? null,
        requesterMessageId: (row.requester_message_id as string | null) ?? null,
        requesterQuery: (row.requester_query as string | null) ?? null,
      })),
      skipDuplicates: true,
    });

    checkpoint = Number(rows[rows.length - 1].id);
    await setCheckpoint(prisma, 'news_intel', checkpoint);
    console.log(`[news_intel] migrated up to id=${checkpoint}`);
  }
}

async function migrateBacktestResults(prisma: PrismaClient, sqlite: any, batchSize: number): Promise<void> {
  let checkpoint = await getCheckpoint(prisma, 'backtest_results');
  while (true) {
    const rows = readBatch(sqlite, 'backtest_results', checkpoint, batchSize);
    if (rows.length === 0) break;

    await prisma.backtestResult.createMany({
      data: rows.map((row) => ({
        id: Number(row.id),
        analysisHistoryId: Number(row.analysis_history_id),
        code: String(row.code ?? ''),
        analysisDate: toDate(row.analysis_date),
        evalWindowDays: Number(row.eval_window_days ?? 10),
        engineVersion: String(row.engine_version ?? 'v1'),
        evalStatus: String(row.eval_status ?? 'pending'),
        evaluatedAt: toDate(row.evaluated_at) ?? new Date(),
        operationAdvice: (row.operation_advice as string | null) ?? null,
        positionRecommendation: (row.position_recommendation as string | null) ?? null,
        startPrice: row.start_price != null ? Number(row.start_price) : null,
        endClose: row.end_close != null ? Number(row.end_close) : null,
        maxHigh: row.max_high != null ? Number(row.max_high) : null,
        minLow: row.min_low != null ? Number(row.min_low) : null,
        stockReturnPct: row.stock_return_pct != null ? Number(row.stock_return_pct) : null,
        directionExpected: (row.direction_expected as string | null) ?? null,
        directionCorrect: row.direction_correct != null ? Boolean(row.direction_correct) : null,
        outcome: (row.outcome as string | null) ?? null,
        stopLoss: row.stop_loss != null ? Number(row.stop_loss) : null,
        takeProfit: row.take_profit != null ? Number(row.take_profit) : null,
        hitStopLoss: row.hit_stop_loss != null ? Boolean(row.hit_stop_loss) : null,
        hitTakeProfit: row.hit_take_profit != null ? Boolean(row.hit_take_profit) : null,
        firstHit: (row.first_hit as string | null) ?? null,
        firstHitDate: toDate(row.first_hit_date),
        firstHitTradingDays: row.first_hit_trading_days != null ? Number(row.first_hit_trading_days) : null,
        simulatedEntryPrice: row.simulated_entry_price != null ? Number(row.simulated_entry_price) : null,
        simulatedExitPrice: row.simulated_exit_price != null ? Number(row.simulated_exit_price) : null,
        simulatedExitReason: (row.simulated_exit_reason as string | null) ?? null,
        simulatedReturnPct: row.simulated_return_pct != null ? Number(row.simulated_return_pct) : null,
      })),
      skipDuplicates: true,
    });

    checkpoint = Number(rows[rows.length - 1].id);
    await setCheckpoint(prisma, 'backtest_results', checkpoint);
    console.log(`[backtest_results] migrated up to id=${checkpoint}`);
  }
}

async function migrateBacktestSummaries(prisma: PrismaClient, sqlite: any, batchSize: number): Promise<void> {
  let checkpoint = await getCheckpoint(prisma, 'backtest_summaries');
  while (true) {
    const rows = readBatch(sqlite, 'backtest_summaries', checkpoint, batchSize);
    if (rows.length === 0) break;

    await prisma.backtestSummary.createMany({
      data: rows.map((row) => ({
        id: Number(row.id),
        scope: String(row.scope ?? ''),
        code: row.code != null ? String(row.code) : null,
        evalWindowDays: Number(row.eval_window_days ?? 10),
        engineVersion: String(row.engine_version ?? 'v1'),
        computedAt: toDate(row.computed_at) ?? new Date(),
        totalEvaluations: Number(row.total_evaluations ?? 0),
        completedCount: Number(row.completed_count ?? 0),
        insufficientCount: Number(row.insufficient_count ?? 0),
        longCount: Number(row.long_count ?? 0),
        cashCount: Number(row.cash_count ?? 0),
        winCount: Number(row.win_count ?? 0),
        lossCount: Number(row.loss_count ?? 0),
        neutralCount: Number(row.neutral_count ?? 0),
        directionAccuracyPct: row.direction_accuracy_pct != null ? Number(row.direction_accuracy_pct) : null,
        winRatePct: row.win_rate_pct != null ? Number(row.win_rate_pct) : null,
        neutralRatePct: row.neutral_rate_pct != null ? Number(row.neutral_rate_pct) : null,
        avgStockReturnPct: row.avg_stock_return_pct != null ? Number(row.avg_stock_return_pct) : null,
        avgSimulatedReturnPct: row.avg_simulated_return_pct != null ? Number(row.avg_simulated_return_pct) : null,
        stopLossTriggerRate: row.stop_loss_trigger_rate != null ? Number(row.stop_loss_trigger_rate) : null,
        takeProfitTriggerRate: row.take_profit_trigger_rate != null ? Number(row.take_profit_trigger_rate) : null,
        ambiguousRate: row.ambiguous_rate != null ? Number(row.ambiguous_rate) : null,
        avgDaysToFirstHit: row.avg_days_to_first_hit != null ? Number(row.avg_days_to_first_hit) : null,
        adviceBreakdownJson: (row.advice_breakdown_json as string | null) ?? null,
        diagnosticsJson: (row.diagnostics_json as string | null) ?? null,
      })),
      skipDuplicates: true,
    });

    checkpoint = Number(rows[rows.length - 1].id);
    await setCheckpoint(prisma, 'backtest_summaries', checkpoint);
    console.log(`[backtest_summaries] migrated up to id=${checkpoint}`);
  }
}

async function migrateAnalysisTasks(prisma: PrismaClient, sqlite: any, batchSize: number): Promise<void> {
  let checkpoint = await getCheckpoint(prisma, 'analysis_tasks');
  while (true) {
    const rows = readBatch(sqlite, 'analysis_tasks', checkpoint, batchSize);
    if (rows.length === 0) break;

    await prisma.analysisTask.createMany({
      data: rows
        .map((row) => {
          const taskId = String(row.task_id ?? row.taskId ?? '').trim();
          const stockCode = String(row.stock_code ?? row.stockCode ?? '').trim();
          if (!taskId || !stockCode) {
            return null;
          }

          return {
            id: Number(row.id),
            taskId,
            stockCode,
            reportType: String(row.report_type ?? row.reportType ?? 'detailed'),
            status: toTaskStatus(row.status),
            progress: Number(row.progress ?? 0),
            message: (row.message as string | null) ?? null,
            resultQueryId: (row.result_query_id as string | null) ?? (row.resultQueryId as string | null) ?? null,
            error: (row.error as string | null) ?? null,
            requestPayload: toJson(row.request_payload ?? row.requestPayload),
            resultPayload: toJson(row.result_payload ?? row.resultPayload),
            createdAt: toDate(row.created_at ?? row.createdAt) ?? new Date(),
            startedAt: toDate(row.started_at ?? row.startedAt),
            completedAt: toDate(row.completed_at ?? row.completedAt),
            updatedAt: toDate(row.updated_at ?? row.updatedAt) ?? new Date(),
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null),
      skipDuplicates: true,
    });

    checkpoint = Number(rows[rows.length - 1].id);
    await setCheckpoint(prisma, 'analysis_tasks', checkpoint);
    console.log(`[analysis_tasks] migrated up to id=${checkpoint}`);
  }
}

async function migrateSystemConfigItems(prisma: PrismaClient, sqlite: any, batchSize: number): Promise<void> {
  let checkpoint = await getCheckpoint(prisma, 'system_config_items');
  while (true) {
    const rows = readBatch(sqlite, 'system_config_items', checkpoint, batchSize);
    if (rows.length === 0) break;

    await prisma.systemConfigItem.createMany({
      data: rows
        .map((row) => {
          const key = String(row.key ?? '').trim();
          if (!key) return null;

          return {
            id: Number(row.id),
            key,
            value: String(row.value ?? ''),
            isSensitive: toBoolean(row.is_sensitive ?? row.isSensitive) ?? false,
            category: String(row.category ?? 'uncategorized'),
            dataType: String(row.data_type ?? row.dataType ?? 'string'),
            uiControl: String(row.ui_control ?? row.uiControl ?? 'text'),
            displayOrder: Number(row.display_order ?? row.displayOrder ?? 9999),
            updatedAt: toDate(row.updated_at ?? row.updatedAt) ?? new Date(),
            createdAt: toDate(row.created_at ?? row.createdAt) ?? new Date(),
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null),
      skipDuplicates: true,
    });

    checkpoint = Number(rows[rows.length - 1].id);
    await setCheckpoint(prisma, 'system_config_items', checkpoint);
    console.log(`[system_config_items] migrated up to id=${checkpoint}`);
  }
}

async function migrateSystemConfigRevisions(prisma: PrismaClient, sqlite: any, batchSize: number): Promise<void> {
  let checkpoint = await getCheckpoint(prisma, 'system_config_revisions');
  while (true) {
    const rows = readBatch(sqlite, 'system_config_revisions', checkpoint, batchSize);
    if (rows.length === 0) break;

    await prisma.systemConfigRevision.createMany({
      data: rows
        .map((row) => {
          const version = String(row.version ?? '').trim();
          if (!version) return null;
          return {
            id: Number(row.id),
            version,
            createdAt: toDate(row.created_at ?? row.createdAt) ?? new Date(),
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null),
      skipDuplicates: true,
    });

    checkpoint = Number(rows[rows.length - 1].id);
    await setCheckpoint(prisma, 'system_config_revisions', checkpoint);
    console.log(`[system_config_revisions] migrated up to id=${checkpoint}`);
  }
}

async function migrateAuthCredentials(prisma: PrismaClient, sqlite: any): Promise<void> {
  const rows = sqlite.prepare('SELECT * FROM auth_credentials ORDER BY id ASC LIMIT 1').all() as SQLiteRow[];
  if (rows.length === 0) return;

  const row = rows[0];
  const passwordHash = String(row.password_hash ?? row.passwordHash ?? '').trim();
  if (!passwordHash) return;

  await prisma.authCredential.upsert({
    where: { id: Number(row.id ?? 1) || 1 },
    update: {
      passwordHash,
      createdAt: toDate(row.created_at ?? row.createdAt) ?? new Date(),
      updatedAt: toDate(row.updated_at ?? row.updatedAt) ?? new Date(),
    },
    create: {
      id: Number(row.id ?? 1) || 1,
      passwordHash,
      createdAt: toDate(row.created_at ?? row.createdAt) ?? new Date(),
      updatedAt: toDate(row.updated_at ?? row.updatedAt) ?? new Date(),
    },
  });

  await setCheckpoint(prisma, 'auth_credentials', 1);
  console.log('[auth_credentials] migrated');
}

async function migrateAuthSessions(prisma: PrismaClient, sqlite: any, batchSize: number): Promise<void> {
  let checkpoint = await getCheckpoint(prisma, 'auth_sessions');
  while (true) {
    const rows = readBatch(sqlite, 'auth_sessions', checkpoint, batchSize);
    if (rows.length === 0) break;

    await prisma.authSession.createMany({
      data: rows
        .map((row) => {
          const sessionId = String(row.session_id ?? row.sessionId ?? '').trim();
          const expiresAt = toDate(row.expires_at ?? row.expiresAt);
          if (!sessionId || !expiresAt) return null;
          return {
            id: Number(row.id),
            sessionId,
            expiresAt,
            createdAt: toDate(row.created_at ?? row.createdAt) ?? new Date(),
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null),
      skipDuplicates: true,
    });

    checkpoint = Number(rows[rows.length - 1].id);
    await setCheckpoint(prisma, 'auth_sessions', checkpoint);
    console.log(`[auth_sessions] migrated up to id=${checkpoint}`);
  }
}

async function migrateAuthRateLimits(prisma: PrismaClient, sqlite: any, batchSize: number): Promise<void> {
  let checkpoint = await getCheckpoint(prisma, 'auth_rate_limits');
  while (true) {
    const rows = readBatch(sqlite, 'auth_rate_limits', checkpoint, batchSize);
    if (rows.length === 0) break;

    await prisma.authRateLimit.createMany({
      data: rows
        .map((row) => {
          const ip = String(row.ip ?? '').trim();
          if (!ip) return null;
          return {
            id: Number(row.id),
            ip,
            failureCount: Number(row.failure_count ?? row.failureCount ?? 0),
            firstFailedAt: toDate(row.first_failed_at ?? row.firstFailedAt) ?? new Date(),
            updatedAt: toDate(row.updated_at ?? row.updatedAt) ?? new Date(),
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null),
      skipDuplicates: true,
    });

    checkpoint = Number(rows[rows.length - 1].id);
    await setCheckpoint(prisma, 'auth_rate_limits', checkpoint);
    console.log(`[auth_rate_limits] migrated up to id=${checkpoint}`);
  }
}

async function syncSequence(prisma: PrismaClient, table: string): Promise<void> {
  const seqRows = await prisma.$queryRawUnsafe<Array<{ seq: string | null }>>(
    `SELECT pg_get_serial_sequence('"${table}"', 'id') AS seq`,
  );
  const seq = seqRows[0]?.seq;
  if (!seq) {
    return;
  }

  await prisma.$executeRawUnsafe(
    `
      SELECT setval(
        $1,
        COALESCE((SELECT MAX(id) FROM "${table}"), 1),
        true
      )
    `,
    seq,
  );
}

async function main(): Promise<void> {
  setupEnv();

  const sqlitePath = process.env.LEGACY_SQLITE_PATH || '/Users/hoaon/Desktop/毕设相关/project/v4/daily_stock_analysis/data/stock_analysis.db';
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`Legacy sqlite not found: ${sqlitePath}`);
  }

  const prisma = new PrismaClient();
  const sqlite = new PySqliteDatabase(sqlitePath);

  const batchSize = 500;

  try {
    if (tableExists(sqlite, 'analysis_history')) {
      await migrateAnalysisHistory(prisma, sqlite, batchSize);
      await syncSequence(prisma, 'analysis_history');
    } else {
      console.log('[analysis_history] skipped (table not found in sqlite)');
    }

    if (tableExists(sqlite, 'news_intel')) {
      await migrateNewsIntel(prisma, sqlite, batchSize);
      await syncSequence(prisma, 'news_intel');
    } else {
      console.log('[news_intel] skipped (table not found in sqlite)');
    }

    if (tableExists(sqlite, 'backtest_results')) {
      await migrateBacktestResults(prisma, sqlite, batchSize);
      await syncSequence(prisma, 'backtest_results');
    } else {
      console.log('[backtest_results] skipped (table not found in sqlite)');
    }

    if (tableExists(sqlite, 'backtest_summaries')) {
      await migrateBacktestSummaries(prisma, sqlite, batchSize);
      await syncSequence(prisma, 'backtest_summaries');
    } else {
      console.log('[backtest_summaries] skipped (table not found in sqlite)');
    }

    if (tableExists(sqlite, 'analysis_tasks')) {
      await migrateAnalysisTasks(prisma, sqlite, batchSize);
      await syncSequence(prisma, 'analysis_tasks');
    } else {
      console.log('[analysis_tasks] skipped (table not found in sqlite)');
    }

    if (tableExists(sqlite, 'system_config_items')) {
      await migrateSystemConfigItems(prisma, sqlite, batchSize);
      await syncSequence(prisma, 'system_config_items');
    } else {
      console.log('[system_config_items] skipped (table not found in sqlite)');
    }

    if (tableExists(sqlite, 'system_config_revisions')) {
      await migrateSystemConfigRevisions(prisma, sqlite, batchSize);
      await syncSequence(prisma, 'system_config_revisions');
    } else {
      console.log('[system_config_revisions] skipped (table not found in sqlite)');
    }

    if (tableExists(sqlite, 'auth_credentials')) {
      await migrateAuthCredentials(prisma, sqlite);
    } else {
      console.log('[auth_credentials] skipped (table not found in sqlite)');
    }

    if (tableExists(sqlite, 'auth_sessions')) {
      await migrateAuthSessions(prisma, sqlite, batchSize);
      await syncSequence(prisma, 'auth_sessions');
    } else {
      console.log('[auth_sessions] skipped (table not found in sqlite)');
    }

    if (tableExists(sqlite, 'auth_rate_limits')) {
      await migrateAuthRateLimits(prisma, sqlite, batchSize);
      await syncSequence(prisma, 'auth_rate_limits');
    } else {
      console.log('[auth_rate_limits] skipped (table not found in sqlite)');
    }

    console.log('Migration completed.');
  } finally {
    sqlite.close();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
