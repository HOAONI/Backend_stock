/** 显式修复已对齐 schema 但残留失败记录的 Prisma migration 历史。 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

import {
  RUNTIME_DB_HISTORY_REPAIR_MIGRATIONS,
  inspectRuntimeDbRepairTargets,
  inspectRuntimeDbState,
} from '@/common/database/runtime-db-prepare';

function setupEnv(): void {
  const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile, override: true });
  }
}

function renderList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}

function markMigrationApplied(migrationName: string): void {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'resolve', '--applied', migrationName], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
}

async function main(): Promise<void> {
  setupEnv();

  const prisma = new PrismaClient();
  try {
    const [state, repairTargetReports] = await Promise.all([
      inspectRuntimeDbState(prisma),
      inspectRuntimeDbRepairTargets(prisma),
    ]);

    console.log(
      `[db:repair:migration-history] schema=${state.schema} migrations_table=${state.hasPrismaMigrationsTable ? 'present' : 'missing'} incomplete_migration_names=${renderList(state.incompleteMigrationNames)}`,
    );

    if (!state.hasPrismaMigrationsTable) {
      throw new Error('当前数据库缺少 _prisma_migrations，无法执行 migration history repair；请先运行显式 schema prepare。');
    }

    const missingArtifacts = repairTargetReports.flatMap(report => {
      const details: string[] = [];
      if (report.missingTables.length > 0) {
        details.push(`${report.migrationName}: missing_tables=${report.missingTables.join(', ')}`);
      }
      if (report.missingColumns.length > 0) {
        details.push(
          `${report.migrationName}: missing_columns=${report.missingColumns
            .map(column => `${column.tableName}.${column.columnName}`)
            .join(', ')}`,
        );
      }
      return details;
    });

    if (missingArtifacts.length > 0) {
      throw new Error(
        `当前数据库缺少 repair 所需结构，已中止：${missingArtifacts.join(' | ')}；请先运行 bash scripts/system/start.sh --prepare-db`,
      );
    }

    const unsupportedIncomplete = state.incompleteMigrationNames.filter(
      name => !RUNTIME_DB_HISTORY_REPAIR_MIGRATIONS.includes(name as never),
    );
    if (unsupportedIncomplete.length > 0) {
      throw new Error(
        `存在未覆盖的失败 migration：${unsupportedIncomplete.join(', ')}；请手动处理后再继续。`,
      );
    }

    const migrationRecordByName = new Map(state.migrationRecords.map(record => [record.migrationName, record]));
    const alreadyApplied = RUNTIME_DB_HISTORY_REPAIR_MIGRATIONS.filter(name => migrationRecordByName.get(name)?.finishedAt != null);
    const pendingMigrations = RUNTIME_DB_HISTORY_REPAIR_MIGRATIONS.filter(name => migrationRecordByName.get(name)?.finishedAt == null);

    console.log(`[db:repair:migration-history] already_applied=${renderList(alreadyApplied)}`);
    console.log(`[db:repair:migration-history] pending=${renderList(pendingMigrations)}`);

    if (pendingMigrations.length === 0 && !state.hasIncompletePrismaMigration) {
      console.log('[db:repair:migration-history] migration history is already clean');
      return;
    }

    for (const migrationName of pendingMigrations) {
      console.log(`[db:repair:migration-history] marking_applied=${migrationName}`);
      markMigrationApplied(migrationName);
    }

    const verifiedState = await inspectRuntimeDbState(prisma);
    const verifiedRecordByName = new Map(verifiedState.migrationRecords.map(record => [record.migrationName, record]));
    const unresolved = RUNTIME_DB_HISTORY_REPAIR_MIGRATIONS.filter(name => verifiedRecordByName.get(name)?.finishedAt == null);

    if (verifiedState.hasIncompletePrismaMigration || unresolved.length > 0) {
      throw new Error(
        `migration history repair 后仍未收敛；unfinished=${renderList(verifiedState.incompleteMigrationNames)} unresolved_targets=${renderList(unresolved)}`,
      );
    }

    console.log('[db:repair:migration-history] migration history repaired');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
