/** 数据库基础设施中的实现文件，承载该领域的具体逻辑。 */

import {
  AGENT_BACKTEST_REQUIRED_TABLES,
  STRATEGY_BACKTEST_REQUIRED_TABLES,
} from '@/common/backtest/backtest-storage-readiness';

export const RUNTIME_DB_LEGACY_MARKER_TABLES = [
  'analysis_history',
  'news_intel',
  'backtest_results',
  'backtest_summaries',
  'strategy_backtest_run_groups',
  'analysis_tasks',
  'admin_users',
] as const;

export const RUNTIME_DB_HISTORY_REPAIR_MIGRATIONS = [
  '20260307193000_scheduler_center',
  '20260310050000_user_backtest_strategies',
  '20260317110000_strategy_backtest_ai_queue',
] as const;

export type RuntimeDbSyncMode = 'prisma-deploy' | 'db-push';

export type RuntimeDbInspection = {
  hasPrismaMigrationsTable: boolean;
  hasIncompletePrismaMigration: boolean;
  existingLegacyMarkerTables: string[];
};

export type RuntimeDbMigrationRecord = {
  migrationName: string;
  finishedAt: Date | string | null;
  rolledBackAt: Date | string | null;
};

export type RuntimeDbState = RuntimeDbInspection & {
  schema: string;
  unfinishedMigrationCount: number;
  incompleteMigrationNames: string[];
  migrationRecords: RuntimeDbMigrationRecord[];
};

export type RuntimeDbColumnExpectation = {
  tableName: string;
  columnName: string;
};

export type RuntimeDbRepairTarget = {
  migrationName: (typeof RUNTIME_DB_HISTORY_REPAIR_MIGRATIONS)[number];
  requiredTables: readonly string[];
  requiredColumns: readonly RuntimeDbColumnExpectation[];
};

export type RuntimeDbRepairTargetReport = RuntimeDbRepairTarget & {
  missingTables: string[];
  missingColumns: RuntimeDbColumnExpectation[];
  ready: boolean;
};

export type RuntimeDbCheckInput = {
  inspection: RuntimeDbInspection & {
    incompleteMigrationNames: string[];
  };
  missingBacktestTables: readonly string[];
  missingAgentBacktestTables: readonly string[];
  repairTargetReports: readonly RuntimeDbRepairTargetReport[];
};

export type RuntimeDbCheckResult = {
  ready: boolean;
  status: 'ok' | 'prepare_required' | 'repair_required';
  summary: string;
  details: string[];
  nextSteps: string[];
};

type QueryClient = {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
};

type SchemaRow = {
  schema_name: string | null;
};

type ExistsRow = {
  table_exists: boolean;
};

type TableRow = {
  tablename: string;
};

type ColumnRow = {
  table_name: string;
  column_name: string;
};

type MigrationRow = {
  migration_name: string;
  finished_at: Date | string | null;
  rolled_back_at: Date | string | null;
};

export const RUNTIME_DB_HISTORY_REPAIR_TARGETS: readonly RuntimeDbRepairTarget[] = [
  {
    migrationName: '20260307193000_scheduler_center',
    requiredTables: ['scheduler_worker_heartbeats'],
    requiredColumns: [
      { tableName: 'analysis_tasks', columnName: 'root_task_id' },
      { tableName: 'analysis_tasks', columnName: 'retry_of_task_id' },
      { tableName: 'analysis_tasks', columnName: 'attempt_no' },
      { tableName: 'analysis_tasks', columnName: 'priority' },
      { tableName: 'analysis_tasks', columnName: 'run_after' },
      { tableName: 'analysis_tasks', columnName: 'cancelled_at' },
    ],
  },
  {
    migrationName: '20260310050000_user_backtest_strategies',
    requiredTables: ['user_backtest_strategies'],
    requiredColumns: [
      { tableName: 'strategy_backtest_runs', columnName: 'saved_strategy_id' },
      { tableName: 'strategy_backtest_runs', columnName: 'saved_strategy_name' },
    ],
  },
  {
    migrationName: '20260317110000_strategy_backtest_ai_queue',
    requiredTables: [],
    requiredColumns: [
      { tableName: 'strategy_backtest_run_groups', columnName: 'ai_interpretation_status' },
      { tableName: 'strategy_backtest_run_groups', columnName: 'ai_interpretation_attempts' },
      { tableName: 'strategy_backtest_run_groups', columnName: 'ai_interpretation_requested_at' },
      { tableName: 'strategy_backtest_run_groups', columnName: 'ai_interpretation_started_at' },
      { tableName: 'strategy_backtest_run_groups', columnName: 'ai_interpretation_completed_at' },
      { tableName: 'strategy_backtest_run_groups', columnName: 'ai_interpretation_next_retry_at' },
      { tableName: 'strategy_backtest_run_groups', columnName: 'ai_interpretation_error_message' },
    ],
  },
] as const;

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildSqlList(values: readonly string[]): string {
  return values.map(quoteSqlLiteral).join(', ');
}

function buildColumnKey(tableName: string, columnName: string): string {
  return `${tableName}.${columnName}`;
}

function missingArtifactsFromRepairTargets(repairTargetReports: readonly RuntimeDbRepairTargetReport[]): string[] {
  const details: string[] = [];

  for (const report of repairTargetReports) {
    if (report.missingTables.length > 0) {
      details.push(`${report.migrationName}: missing_tables=${report.missingTables.join(', ')}`);
    }
    if (report.missingColumns.length > 0) {
      details.push(
        `${report.migrationName}: missing_columns=${report.missingColumns
          .map(column => buildColumnKey(column.tableName, column.columnName))
          .join(', ')}`,
      );
    }
  }

  return details;
}

function canRepairRuntimeDbHistory(
  incompleteMigrationNames: readonly string[],
  repairTargetReports: readonly RuntimeDbRepairTargetReport[],
): boolean {
  if (incompleteMigrationNames.length === 0) {
    return false;
  }

  if (!incompleteMigrationNames.every(name => RUNTIME_DB_HISTORY_REPAIR_MIGRATIONS.includes(name as never))) {
    return false;
  }

  if (!incompleteMigrationNames.includes(RUNTIME_DB_HISTORY_REPAIR_MIGRATIONS[0])) {
    return false;
  }

  return repairTargetReports.every(report => report.ready);
}

export function resolveRuntimeDbSyncMode(inspection: RuntimeDbInspection): RuntimeDbSyncMode {
  if (inspection.hasIncompletePrismaMigration) {
    return 'db-push';
  }

  if (inspection.hasPrismaMigrationsTable) {
    return 'prisma-deploy';
  }

  if (inspection.existingLegacyMarkerTables.length > 0) {
    return 'db-push';
  }

  return 'prisma-deploy';
}

export function buildRuntimeDbPrepareSteps(mode: RuntimeDbSyncMode): string[] {
  if (mode === 'db-push') {
    return ['db:push:skip-generate', 'prisma:generate', 'db:constraints'];
  }

  return ['prisma:deploy', 'prisma:generate', 'db:constraints'];
}

export async function inspectRuntimeDbState(client: QueryClient): Promise<RuntimeDbState> {
  const schemaRows = await client.$queryRawUnsafe<SchemaRow[]>('SELECT current_schema() AS schema_name');
  const schema = String(schemaRows[0]?.schema_name ?? 'public');
  const markerListSql = buildSqlList(RUNTIME_DB_LEGACY_MARKER_TABLES);

  const migrationsRows = await client.$queryRawUnsafe<ExistsRow[]>(`
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = '_prisma_migrations'
    ) AS table_exists
  `);
  const hasPrismaMigrationsTable = Boolean(migrationsRows[0]?.table_exists);

  const markerRows = await client.$queryRawUnsafe<TableRow[]>(`
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = current_schema()
       AND tablename IN (${markerListSql})
     ORDER BY tablename
  `);

  let migrationRecords: RuntimeDbMigrationRecord[] = [];
  if (hasPrismaMigrationsTable) {
    const rows = await client.$queryRawUnsafe<MigrationRow[]>(`
      SELECT migration_name, finished_at, rolled_back_at
        FROM "_prisma_migrations"
       ORDER BY started_at, migration_name
    `);
    migrationRecords = rows.map(row => ({
      migrationName: String(row.migration_name),
      finishedAt: row.finished_at ?? null,
      rolledBackAt: row.rolled_back_at ?? null,
    }));
  }

  const incompleteMigrationNames = migrationRecords
    .filter(record => record.finishedAt == null && record.rolledBackAt == null)
    .map(record => record.migrationName);

  return {
    schema,
    hasPrismaMigrationsTable,
    hasIncompletePrismaMigration: incompleteMigrationNames.length > 0,
    existingLegacyMarkerTables: markerRows.map(row => String(row.tablename)),
    unfinishedMigrationCount: incompleteMigrationNames.length,
    incompleteMigrationNames,
    migrationRecords,
  };
}

export async function inspectRuntimeDbRepairTargets(
  client: QueryClient,
  targets: readonly RuntimeDbRepairTarget[] = RUNTIME_DB_HISTORY_REPAIR_TARGETS,
): Promise<RuntimeDbRepairTargetReport[]> {
  const tableNames = Array.from(
    new Set(targets.flatMap(target => [...target.requiredTables, ...target.requiredColumns.map(column => column.tableName)])),
  );
  const columnTableNames = Array.from(new Set(targets.flatMap(target => target.requiredColumns.map(column => column.tableName))));

  let existingTables = new Set<string>();
  if (tableNames.length > 0) {
    const tableRows = await client.$queryRawUnsafe<TableRow[]>(`
      SELECT tablename
        FROM pg_tables
       WHERE schemaname = current_schema()
         AND tablename IN (${buildSqlList(tableNames)})
       ORDER BY tablename
    `);
    existingTables = new Set(tableRows.map(row => String(row.tablename)));
  }

  let existingColumns = new Set<string>();
  if (columnTableNames.length > 0) {
    const columnRows = await client.$queryRawUnsafe<ColumnRow[]>(`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name IN (${buildSqlList(columnTableNames)})
       ORDER BY table_name, column_name
    `);
    existingColumns = new Set(
      columnRows.map(row => buildColumnKey(String(row.table_name), String(row.column_name))),
    );
  }

  return targets.map(target => {
    const missingTables = target.requiredTables.filter(tableName => !existingTables.has(tableName));
    const missingColumns = target.requiredColumns.filter(
      column => !existingColumns.has(buildColumnKey(column.tableName, column.columnName)),
    );

    return {
      ...target,
      missingTables: [...missingTables],
      missingColumns: [...missingColumns],
      ready: missingTables.length === 0 && missingColumns.length === 0,
    };
  });
}

export function evaluateRuntimeDbCheck(input: RuntimeDbCheckInput): RuntimeDbCheckResult {
  const details: string[] = [];
  const missingRuntimeArtifacts = missingArtifactsFromRepairTargets(input.repairTargetReports);

  if (input.inspection.hasIncompletePrismaMigration) {
    details.push(`unfinished_migrations=${input.inspection.incompleteMigrationNames.join(', ')}`);
    details.push(...missingRuntimeArtifacts);

    if (canRepairRuntimeDbHistory(input.inspection.incompleteMigrationNames, input.repairTargetReports)) {
      return {
        ready: false,
        status: 'repair_required',
        summary: '检测到 Prisma migration 历史未收尾，但对应 schema 结构已经存在。',
        details,
        nextSteps: ['pnpm db:repair:migration-history'],
      };
    }

    return {
      ready: false,
      status: 'prepare_required',
      summary: '检测到未完成的 Prisma migration，且运行时所需 schema 尚未完全对齐。',
      details,
      nextSteps: ['bash scripts/system/start.sh --prepare-db', 'pnpm db:prepare:runtime'],
    };
  }

  if (!input.inspection.hasPrismaMigrationsTable) {
    if (input.inspection.existingLegacyMarkerTables.length > 0) {
      details.push(`legacy_marker_tables=${input.inspection.existingLegacyMarkerTables.join(', ')}`);
    } else {
      details.push('fresh_database_without_migration_history=true');
    }
    details.push(...missingRuntimeArtifacts);

    return {
      ready: false,
      status: 'prepare_required',
      summary: '当前数据库缺少 Prisma migration 历史，需要先执行一次显式 schema 准备。',
      details,
      nextSteps: ['bash scripts/system/start.sh --prepare-db', 'pnpm db:prepare:runtime'],
    };
  }

  if (input.missingBacktestTables.length > 0) {
    details.push(`missing_backtest_tables=${input.missingBacktestTables.join(', ')}`);
  }
  if (input.missingAgentBacktestTables.length > 0) {
    details.push(`missing_agent_backtest_tables=${input.missingAgentBacktestTables.join(', ')}`);
  }
  details.push(...missingRuntimeArtifacts);

  if (details.length > 0) {
    return {
      ready: false,
      status: 'prepare_required',
      summary: '当前数据库缺少运行时所需的 schema 表或列。',
      details,
      nextSteps: ['bash scripts/system/start.sh --prepare-db', 'pnpm db:prepare:runtime'],
    };
  }

  return {
    ready: true,
    status: 'ok',
    summary: '运行时数据库检查通过。',
    details: [
      `required_backtest_tables=${STRATEGY_BACKTEST_REQUIRED_TABLES.join(', ')}`,
      `required_agent_backtest_tables=${AGENT_BACKTEST_REQUIRED_TABLES.join(', ')}`,
    ],
    nextSteps: [],
  };
}
