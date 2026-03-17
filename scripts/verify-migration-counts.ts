/** 核对迁移前后核心表的数据量，避免大规模迁移时静默丢数。 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { PrismaClient } from '@prisma/client';

interface TableResult {
  table: string;
  sqliteCount: number | null;
  postgresCount: number;
  countMatch: boolean;
  sampleMatch: boolean | null;
  note: string;
}

const CORE_TABLES = ['analysis_history', 'news_intel', 'backtest_results', 'backtest_summaries'];

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

  query(sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
    const output = execFileSync('python3', ['-c', PY_SQL_RUNNER, this.dbPath, sql, JSON.stringify(params)], {
      encoding: 'utf8',
    });
    const text = String(output || '').trim();
    if (!text) return [];
    return JSON.parse(text) as Array<Record<string, unknown>>;
  }
}

function sqliteTableExists(db: PySqliteDatabase, table: string): boolean {
  const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1", [table])[0] as
    | { name?: string }
    | undefined;
  return Boolean(row?.name);
}

function sqliteCount(db: PySqliteDatabase, table: string): number {
  const row = db.query(`SELECT COUNT(1) AS c FROM ${table}`)[0] as { c: number };
  return Number(row.c ?? 0);
}

async function postgresCount(prisma: PrismaClient, table: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ c: number }>>(`SELECT COUNT(1)::int AS c FROM "${table}"`);
  return Number(rows[0]?.c ?? 0);
}

async function compareSample(prisma: PrismaClient, sqlite: PySqliteDatabase, table: string): Promise<{ ok: boolean; note: string }> {
  if (table === 'analysis_history') {
    const sqliteRow = sqlite.query('SELECT id, query_id, code, report_type FROM analysis_history ORDER BY id ASC LIMIT 1')[0] as
      | { id: number; query_id: string | null; code: string; report_type: string | null }
      | undefined;
    if (!sqliteRow) return { ok: true, note: 'sqlite empty' };
    const pgRows = await prisma.$queryRawUnsafe<Array<{ id: number; query_id: string | null; code: string; report_type: string | null }>>(
      'SELECT id, query_id, code, report_type FROM "analysis_history" WHERE id = $1 LIMIT 1',
      sqliteRow.id,
    );
    const pgRow = pgRows[0];
    if (!pgRow) return { ok: false, note: `missing row id=${sqliteRow.id}` };
    const ok = pgRow.query_id === sqliteRow.query_id && pgRow.code === sqliteRow.code && pgRow.report_type === sqliteRow.report_type;
    return { ok, note: ok ? `id=${sqliteRow.id} matched` : `id=${sqliteRow.id} field mismatch` };
  }

  if (table === 'backtest_results') {
    const sqliteRow = sqlite.query(
      'SELECT id, analysis_history_id, code, eval_status FROM backtest_results ORDER BY id ASC LIMIT 1',
    )[0] as { id: number; analysis_history_id: number; code: string; eval_status: string } | undefined;
    if (!sqliteRow) return { ok: true, note: 'sqlite empty' };
    const pgRows = await prisma.$queryRawUnsafe<Array<{ id: number; analysis_history_id: number; code: string; eval_status: string }>>(
      'SELECT id, analysis_history_id, code, eval_status FROM "backtest_results" WHERE id = $1 LIMIT 1',
      sqliteRow.id,
    );
    const pgRow = pgRows[0];
    if (!pgRow) return { ok: false, note: `missing row id=${sqliteRow.id}` };
    const ok =
      Number(pgRow.analysis_history_id) === Number(sqliteRow.analysis_history_id) &&
      pgRow.code === sqliteRow.code &&
      pgRow.eval_status === sqliteRow.eval_status;
    return { ok, note: ok ? `id=${sqliteRow.id} matched` : `id=${sqliteRow.id} field mismatch` };
  }

  return { ok: true, note: 'sample check not required' };
}

async function main(): Promise<void> {
  const sqlitePath = path.resolve(process.argv[2] || process.env.LEGACY_SQLITE_PATH || '');
  const reportFile = path.resolve(process.argv[3] || path.resolve(process.cwd(), 'docs/MIGRATION_VERIFICATION_REPORT.md'));
  if (!sqlitePath || !fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite file not found: ${sqlitePath}`);
  }

  const sqlite = new PySqliteDatabase(sqlitePath);
  const prisma = new PrismaClient();
  const results: TableResult[] = [];

  try {
    for (const table of CORE_TABLES) {
      if (!sqliteTableExists(sqlite, table)) {
        const pgCount = await postgresCount(prisma, table);
        results.push({
          table,
          sqliteCount: null,
          postgresCount: pgCount,
          countMatch: true,
          sampleMatch: null,
          note: 'sqlite table missing, skipped',
        });
        continue;
      }

      const sCount = sqliteCount(sqlite, table);
      const pCount = await postgresCount(prisma, table);
      const countMatch = sCount === pCount;
      const sample = await compareSample(prisma, sqlite, table);

      results.push({
        table,
        sqliteCount: sCount,
        postgresCount: pCount,
        countMatch,
        sampleMatch: sample.ok,
        note: sample.note,
      });
    }
  } finally {
    await prisma.$disconnect();
  }

  const countFailures = results.filter((item) => !item.countMatch).length;
  const sampleFailures = results.filter((item) => item.sampleMatch === false).length;

  const lines: string[] = [];
  lines.push('# Migration Verification Report');
  lines.push('');
  lines.push(`- Generated at: ${new Date().toISOString()}`);
  lines.push(`- SQLite source: \`${sqlitePath}\``);
  lines.push(`- Summary: count_failures=${countFailures}, sample_failures=${sampleFailures}`);
  lines.push('');
  lines.push('| Table | SQLite Count | PostgreSQL Count | Count Match | Sample Match | Note |');
  lines.push('| --- | ---: | ---: | --- | --- | --- |');
  for (const item of results) {
    lines.push(
      `| ${item.table} | ${item.sqliteCount == null ? 'N/A' : item.sqliteCount} | ${item.postgresCount} | ${item.countMatch ? 'yes' : 'no'} | ${item.sampleMatch == null ? 'N/A' : item.sampleMatch ? 'yes' : 'no'} | ${item.note} |`,
    );
  }
  lines.push('');

  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, lines.join('\n'), 'utf8');

  console.log(`Migration report written: ${reportFile}`);
  console.log(`count_failures=${countFailures}, sample_failures=${sampleFailures}`);

  if (countFailures > 0 || sampleFailures > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
