export const RUNTIME_DB_LEGACY_MARKER_TABLES = [
  'analysis_history',
  'news_intel',
  'backtest_results',
  'backtest_summaries',
  'strategy_backtest_run_groups',
  'analysis_tasks',
  'admin_users',
] as const;

export type RuntimeDbSyncMode = 'prisma-deploy' | 'db-push';

export type RuntimeDbInspection = {
  hasPrismaMigrationsTable: boolean;
  hasIncompletePrismaMigration: boolean;
  existingLegacyMarkerTables: string[];
};

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
  return ['prisma:generate', mode === 'prisma-deploy' ? 'prisma:deploy' : 'db:push', 'db:constraints'];
}
