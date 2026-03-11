import { buildRuntimeDbPrepareSteps, resolveRuntimeDbSyncMode } from '@/common/database/runtime-db-prepare';

describe('runtime db prepare', () => {
  it('uses prisma deploy when prisma migration history already exists', () => {
    const mode = resolveRuntimeDbSyncMode({
      hasPrismaMigrationsTable: true,
      hasIncompletePrismaMigration: false,
      existingLegacyMarkerTables: ['analysis_history'],
    });

    expect(mode).toBe('prisma-deploy');
    expect(buildRuntimeDbPrepareSteps(mode)).toEqual(['prisma:generate', 'prisma:deploy', 'db:constraints']);
  });

  it('uses prisma deploy for a fresh database without application tables', () => {
    const mode = resolveRuntimeDbSyncMode({
      hasPrismaMigrationsTable: false,
      hasIncompletePrismaMigration: false,
      existingLegacyMarkerTables: [],
    });

    expect(mode).toBe('prisma-deploy');
    expect(buildRuntimeDbPrepareSteps(mode)).toEqual(['prisma:generate', 'prisma:deploy', 'db:constraints']);
  });

  it('uses db push for legacy databases that have application tables but no migration history', () => {
    const mode = resolveRuntimeDbSyncMode({
      hasPrismaMigrationsTable: false,
      hasIncompletePrismaMigration: false,
      existingLegacyMarkerTables: ['analysis_history', 'strategy_backtest_run_groups'],
    });

    expect(mode).toBe('db-push');
    expect(buildRuntimeDbPrepareSteps(mode)).toEqual(['prisma:generate', 'db:push', 'db:constraints']);
  });

  it('uses db push when prisma migration history exists but contains an unfinished migration', () => {
    const mode = resolveRuntimeDbSyncMode({
      hasPrismaMigrationsTable: true,
      hasIncompletePrismaMigration: true,
      existingLegacyMarkerTables: ['analysis_tasks'],
    });

    expect(mode).toBe('db-push');
    expect(buildRuntimeDbPrepareSteps(mode)).toEqual(['prisma:generate', 'db:push', 'db:constraints']);
  });
});
