export const STRATEGY_BACKTEST_REQUIRED_TABLES = [
  'strategy_backtest_run_groups',
  'strategy_backtest_runs',
  'strategy_backtest_trades',
  'strategy_backtest_equity_points',
] as const;

export const STRATEGY_BACKTEST_SCHEMA_NOT_READY_MESSAGE = 'strategy backtest tables missing; run db migration';

type QueryClient = {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
};

export type BacktestStorageReadiness = {
  ready: boolean;
  schema: string;
  requiredTables: string[];
  existingTables: string[];
  missingTables: string[];
};

const TABLE_LIST_SQL = STRATEGY_BACKTEST_REQUIRED_TABLES.map((name) => `'${name}'`).join(', ');

export async function getBacktestStorageReadiness(client: QueryClient): Promise<BacktestStorageReadiness> {
  const schemaRows = await client.$queryRawUnsafe<Array<{ schema_name: string | null }>>(
    'SELECT current_schema() AS schema_name',
  );
  const schema = String(schemaRows?.[0]?.schema_name ?? 'public');

  const tableRows = await client.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename IN (${TABLE_LIST_SQL})
      ORDER BY tablename`,
  );

  const existing = new Set(tableRows.map((row) => String(row.tablename)));
  const missing = STRATEGY_BACKTEST_REQUIRED_TABLES.filter((name) => !existing.has(name));

  return {
    ready: missing.length === 0,
    schema,
    requiredTables: [...STRATEGY_BACKTEST_REQUIRED_TABLES],
    existingTables: Array.from(existing).sort((a, b) => a.localeCompare(b)),
    missingTables: [...missing],
  };
}
