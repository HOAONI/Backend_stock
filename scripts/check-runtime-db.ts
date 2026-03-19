/** 只读检查运行时数据库状态，快速判断是否需要 prepare 或 repair。 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

import {
  getAgentBacktestStorageReadiness,
  getBacktestStorageReadiness,
} from '@/common/backtest/backtest-storage-readiness';
import {
  evaluateRuntimeDbCheck,
  inspectRuntimeDbRepairTargets,
  inspectRuntimeDbState,
  type RuntimeDbRepairTargetReport,
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

function renderMissingColumns(report: RuntimeDbRepairTargetReport): string {
  if (report.missingColumns.length === 0) {
    return '(none)';
  }

  return report.missingColumns.map(column => `${column.tableName}.${column.columnName}`).join(', ');
}

async function main(): Promise<void> {
  setupEnv();

  const prisma = new PrismaClient();
  try {
    const [state, backtestReadiness, agentReadiness, repairTargetReports] = await Promise.all([
      inspectRuntimeDbState(prisma),
      getBacktestStorageReadiness(prisma),
      getAgentBacktestStorageReadiness(prisma),
      inspectRuntimeDbRepairTargets(prisma),
    ]);

    console.log(
      `[db:check:runtime] schema=${state.schema} migrations_table=${state.hasPrismaMigrationsTable ? 'present' : 'missing'} incomplete_migrations=${state.unfinishedMigrationCount} incomplete_migration_names=${renderList(state.incompleteMigrationNames)} legacy_marker_tables=${renderList(state.existingLegacyMarkerTables)}`,
    );
    console.log(
      `[db:check:runtime] backtest_ready=${backtestReadiness.ready} missing_backtest_tables=${renderList(backtestReadiness.missingTables)}`,
    );
    console.log(
      `[db:check:runtime] agent_backtest_ready=${agentReadiness.ready} missing_agent_backtest_tables=${renderList(agentReadiness.missingTables)}`,
    );
    for (const report of repairTargetReports) {
      console.log(
        `[db:check:runtime] migration=${report.migrationName} ready=${report.ready} missing_tables=${renderList(report.missingTables)} missing_columns=${renderMissingColumns(report)}`,
      );
    }

    const result = evaluateRuntimeDbCheck({
      inspection: {
        hasPrismaMigrationsTable: state.hasPrismaMigrationsTable,
        hasIncompletePrismaMigration: state.hasIncompletePrismaMigration,
        existingLegacyMarkerTables: state.existingLegacyMarkerTables,
        incompleteMigrationNames: state.incompleteMigrationNames,
      },
      missingBacktestTables: backtestReadiness.missingTables,
      missingAgentBacktestTables: agentReadiness.missingTables,
      repairTargetReports,
    });

    if (!result.ready) {
      console.error(`[db:check:runtime] status=${result.status} summary=${result.summary}`);
      for (const detail of result.details) {
        console.error(`[db:check:runtime] detail=${detail}`);
      }
      for (const nextStep of result.nextSteps) {
        console.error(`[db:check:runtime] next_step=${nextStep}`);
      }
      process.exit(1);
    }

    console.log(`[db:check:runtime] status=${result.status} summary=${result.summary}`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
