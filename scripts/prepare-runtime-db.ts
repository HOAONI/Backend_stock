/** 在服务启动前补齐运行时数据库前置条件，减少因环境差异导致的启动失败。 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

import {
  buildRuntimeDbPrepareSteps,
  inspectRuntimeDbState,
  resolveRuntimeDbSyncMode,
  type RuntimeDbState,
} from '@/common/database/runtime-db-prepare';

function setupEnv(): void {
  const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile, override: true });
  }
}

function runPnpmScript(scriptName: string): void {
  execFileSync('pnpm', [scriptName], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
}

function logRuntimeDbPlan(state: RuntimeDbState, mode: ReturnType<typeof resolveRuntimeDbSyncMode>, steps: string[]): void {
  const markers = state.existingLegacyMarkerTables.length > 0 ? state.existingLegacyMarkerTables.join(', ') : '(none)';
  const incompleteNames = state.incompleteMigrationNames.length > 0 ? state.incompleteMigrationNames.join(', ') : '(none)';
  console.log(
    `[db:prepare:runtime] schema=${state.schema} migrations_table=${state.hasPrismaMigrationsTable ? 'present' : 'missing'} incomplete_migrations=${state.unfinishedMigrationCount} incomplete_migration_names=${incompleteNames} legacy_marker_tables=${markers}`,
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
