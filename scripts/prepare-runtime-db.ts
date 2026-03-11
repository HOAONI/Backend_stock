import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

import {
  RUNTIME_DB_LEGACY_MARKER_TABLES,
  buildRuntimeDbPrepareSteps,
  resolveRuntimeDbSyncMode,
  type RuntimeDbInspection,
  type RuntimeDbSyncMode,
} from '@/common/database/runtime-db-prepare';

type TableRow = {
  tablename: string;
};

type SchemaRow = {
  schema_name: string | null;
};

type ExistsRow = {
  table_exists: boolean;
};

type CountRow = {
  unfinished_count: bigint | number;
};

type RuntimeDbState = RuntimeDbInspection & {
  schema: string;
  unfinishedMigrationCount: number;
};

function setupEnv(): void {
  const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile, override: true });
  }
}

function buildTableListSql(tableNames: readonly string[]): string {
  return tableNames.map(name => `'${name}'`).join(', ');
}

async function inspectRuntimeDbState(prisma: PrismaClient): Promise<RuntimeDbState> {
  const schemaRows = await prisma.$queryRawUnsafe<SchemaRow[]>('SELECT current_schema() AS schema_name');
  const schema = String(schemaRows[0]?.schema_name ?? 'public');
  const tableListSql = buildTableListSql(RUNTIME_DB_LEGACY_MARKER_TABLES);

  const migrationsRows = await prisma.$queryRawUnsafe<ExistsRow[]>(`
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = '_prisma_migrations'
    ) AS table_exists
  `);
  const hasPrismaMigrationsTable = Boolean(migrationsRows[0]?.table_exists);

  let unfinishedMigrationCount = 0;
  if (hasPrismaMigrationsTable) {
    const unfinishedRows = await prisma.$queryRawUnsafe<CountRow[]>(`
      SELECT COUNT(*) AS unfinished_count
        FROM "_prisma_migrations"
       WHERE "finished_at" IS NULL
         AND "rolled_back_at" IS NULL
    `);
    unfinishedMigrationCount = Number(unfinishedRows[0]?.unfinished_count ?? 0);
  }

  const markerRows = await prisma.$queryRawUnsafe<TableRow[]>(`
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = current_schema()
       AND tablename IN (${tableListSql})
     ORDER BY tablename
  `);

  return {
    schema,
    hasPrismaMigrationsTable,
    hasIncompletePrismaMigration: unfinishedMigrationCount > 0,
    existingLegacyMarkerTables: markerRows.map(row => String(row.tablename)),
    unfinishedMigrationCount,
  };
}

function runPnpmScript(scriptName: string): void {
  execFileSync('pnpm', [scriptName], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
}

function logRuntimeDbPlan(state: RuntimeDbState, mode: RuntimeDbSyncMode, steps: string[]): void {
  const markers = state.existingLegacyMarkerTables.length > 0 ? state.existingLegacyMarkerTables.join(', ') : '(none)';
  console.log(
    `[db:prepare:runtime] schema=${state.schema} migrations_table=${state.hasPrismaMigrationsTable ? 'present' : 'missing'} incomplete_migrations=${state.unfinishedMigrationCount} legacy_marker_tables=${markers}`,
  );
  console.log(`[db:prepare:runtime] selected_mode=${mode} steps=${steps.join(' -> ')}`);
}

async function main(): Promise<void> {
  setupEnv();

  const state = await (async (): Promise<RuntimeDbState> => {
    const prisma = new PrismaClient();
    try {
      return await inspectRuntimeDbState(prisma);
    } finally {
      await prisma.$disconnect();
    }
  })();

  const mode = resolveRuntimeDbSyncMode(state);
  const steps = buildRuntimeDbPrepareSteps(mode);

  logRuntimeDbPlan(state, mode, steps);

  for (const step of steps) {
    runPnpmScript(step);
  }

  console.log('[db:prepare:runtime] database schema is ready');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
