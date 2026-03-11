export const STRATEGY_BACKTEST_REQUIRED_TABLES = [
  'user_backtest_strategies',
  'strategy_backtest_run_groups',
  'strategy_backtest_runs',
  'strategy_backtest_trades',
  'strategy_backtest_equity_points',
] as const;

export const STRATEGY_BACKTEST_SCHEMA_NOT_READY_MESSAGE = 'strategy backtest tables missing; run db migration';
export const AGENT_BACKTEST_REQUIRED_TABLES = [
  'agent_backtest_run_groups',
  'agent_backtest_daily_steps',
  'agent_backtest_trades',
  'agent_backtest_equity_points',
  'agent_backtest_signal_snapshots',
] as const;

export const AGENT_BACKTEST_SCHEMA_NOT_READY_MESSAGE = 'agent backtest tables missing; run db migration';

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

function buildTableListSql(requiredTables: readonly string[]): string {
  return requiredTables.map((name) => `'${name}'`).join(', ');
}

async function getStorageReadiness(
  client: QueryClient,
  requiredTables: readonly string[],
): Promise<BacktestStorageReadiness> {
  const schemaRows = await client.$queryRawUnsafe<Array<{ schema_name: string | null }>>(
    'SELECT current_schema() AS schema_name',
  );
  const schema = String(schemaRows?.[0]?.schema_name ?? 'public');
  const tableListSql = buildTableListSql(requiredTables);

  const tableRows = await client.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename IN (${tableListSql})
      ORDER BY tablename`,
  );

  const existing = new Set(tableRows.map((row) => String(row.tablename)));
  const missing = requiredTables.filter((name) => !existing.has(name));

  return {
    ready: missing.length === 0,
    schema,
    requiredTables: [...requiredTables],
    existingTables: Array.from(existing).sort((a, b) => a.localeCompare(b)),
    missingTables: [...missing],
  };
}

export async function getBacktestStorageReadiness(client: QueryClient): Promise<BacktestStorageReadiness> {
  return await getStorageReadiness(client, STRATEGY_BACKTEST_REQUIRED_TABLES);
}

export async function getAgentBacktestStorageReadiness(client: QueryClient): Promise<BacktestStorageReadiness> {
  return await getStorageReadiness(client, AGENT_BACKTEST_REQUIRED_TABLES);
}
