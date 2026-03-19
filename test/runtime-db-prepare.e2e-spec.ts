/** 运行时数据库预处理单测，确保不同历史库形态会选中正确的 schema 同步策略。 */

import {
  RUNTIME_DB_HISTORY_REPAIR_TARGETS,
  buildRuntimeDbPrepareSteps,
  evaluateRuntimeDbCheck,
  resolveRuntimeDbSyncMode,
  type RuntimeDbRepairTargetReport,
} from '@/common/database/runtime-db-prepare';

function buildRepairReports(overrides?: Partial<Record<(typeof RUNTIME_DB_HISTORY_REPAIR_TARGETS)[number]['migrationName'], Partial<RuntimeDbRepairTargetReport>>>): RuntimeDbRepairTargetReport[] {
  return RUNTIME_DB_HISTORY_REPAIR_TARGETS.map(target => ({
    ...target,
    missingTables: [],
    missingColumns: [],
    ready: true,
    ...(overrides?.[target.migrationName] ?? {}),
  }));
}

describe('runtime db prepare', () => {
  it('uses prisma deploy when prisma migration history already exists', () => {
    const mode = resolveRuntimeDbSyncMode({
      hasPrismaMigrationsTable: true,
      hasIncompletePrismaMigration: false,
      existingLegacyMarkerTables: ['analysis_history'],
    });

    expect(mode).toBe('prisma-deploy');
    expect(buildRuntimeDbPrepareSteps(mode)).toEqual(['prisma:deploy', 'prisma:generate', 'db:constraints']);
  });

  it('uses prisma deploy for a fresh database without application tables', () => {
    const mode = resolveRuntimeDbSyncMode({
      hasPrismaMigrationsTable: false,
      hasIncompletePrismaMigration: false,
      existingLegacyMarkerTables: [],
    });

    expect(mode).toBe('prisma-deploy');
    expect(buildRuntimeDbPrepareSteps(mode)).toEqual(['prisma:deploy', 'prisma:generate', 'db:constraints']);
  });

  it('uses db push for legacy databases that have application tables but no migration history', () => {
    const mode = resolveRuntimeDbSyncMode({
      hasPrismaMigrationsTable: false,
      hasIncompletePrismaMigration: false,
      existingLegacyMarkerTables: ['analysis_history', 'strategy_backtest_run_groups'],
    });

    expect(mode).toBe('db-push');
    expect(buildRuntimeDbPrepareSteps(mode)).toEqual(['db:push:skip-generate', 'prisma:generate', 'db:constraints']);
  });

  it('uses db push when prisma migration history exists but contains an unfinished migration', () => {
    const mode = resolveRuntimeDbSyncMode({
      hasPrismaMigrationsTable: true,
      hasIncompletePrismaMigration: true,
      existingLegacyMarkerTables: ['analysis_tasks'],
    });

    expect(mode).toBe('db-push');
    expect(buildRuntimeDbPrepareSteps(mode)).toEqual(['db:push:skip-generate', 'prisma:generate', 'db:constraints']);
  });
});

describe('runtime db check', () => {
  it('passes when migration history and required runtime tables are all ready', () => {
    const result = evaluateRuntimeDbCheck({
      inspection: {
        hasPrismaMigrationsTable: true,
        hasIncompletePrismaMigration: false,
        existingLegacyMarkerTables: [],
        incompleteMigrationNames: [],
      },
      missingBacktestTables: [],
      missingAgentBacktestTables: [],
      repairTargetReports: buildRepairReports(),
    });

    expect(result).toMatchObject({
      ready: true,
      status: 'ok',
    });
  });

  it('requires prepare for a fresh database without migration history', () => {
    const result = evaluateRuntimeDbCheck({
      inspection: {
        hasPrismaMigrationsTable: false,
        hasIncompletePrismaMigration: false,
        existingLegacyMarkerTables: [],
        incompleteMigrationNames: [],
      },
      missingBacktestTables: ['strategy_backtest_runs'],
      missingAgentBacktestTables: ['agent_backtest_trades'],
      repairTargetReports: buildRepairReports(),
    });

    expect(result).toMatchObject({
      ready: false,
      status: 'prepare_required',
    });
    expect(result.nextSteps).toContain('bash scripts/system/start.sh --prepare-db');
  });

  it('requires repair when unfinished scheduler migration already has all target structures', () => {
    const result = evaluateRuntimeDbCheck({
      inspection: {
        hasPrismaMigrationsTable: true,
        hasIncompletePrismaMigration: true,
        existingLegacyMarkerTables: ['analysis_tasks'],
        incompleteMigrationNames: ['20260307193000_scheduler_center'],
      },
      missingBacktestTables: [],
      missingAgentBacktestTables: [],
      repairTargetReports: buildRepairReports(),
    });

    expect(result).toMatchObject({
      ready: false,
      status: 'repair_required',
    });
    expect(result.nextSteps).toEqual(['pnpm db:repair:migration-history']);
  });

  it('requires prepare when unfinished migration still misses runtime artifacts', () => {
    const result = evaluateRuntimeDbCheck({
      inspection: {
        hasPrismaMigrationsTable: true,
        hasIncompletePrismaMigration: true,
        existingLegacyMarkerTables: ['analysis_tasks'],
        incompleteMigrationNames: ['20260307193000_scheduler_center'],
      },
      missingBacktestTables: [],
      missingAgentBacktestTables: [],
      repairTargetReports: buildRepairReports({
        '20260317110000_strategy_backtest_ai_queue': {
          ready: false,
          missingColumns: [{ tableName: 'strategy_backtest_run_groups', columnName: 'ai_interpretation_status' }],
        },
      }),
    });

    expect(result).toMatchObject({
      ready: false,
      status: 'prepare_required',
    });
    expect(result.nextSteps).toContain('pnpm db:prepare:runtime');
  });
});
