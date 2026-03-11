export type AgentExecutionMode = 'paper' | 'broker';

export interface AgentRuntimeExecutionConfig {
  mode: AgentExecutionMode;
  has_ticket: boolean;
  broker_account_id?: number;
}

export interface AgentRuntimeContext {
  account_snapshot?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  positions?: Array<Record<string, unknown>>;
}

export interface AgentRuntimeConfig {
  account: {
    account_name: string;
    initial_cash: number;
    account_display_name?: string | null;
  };
  llm?: {
    provider: string;
    base_url: string;
    model: string;
    has_token: boolean;
    api_token?: string;
  };
  strategy: {
    position_max_pct: number;
    stop_loss_pct: number;
    take_profit_pct: number;
  };
  execution?: AgentRuntimeExecutionConfig;
  context?: AgentRuntimeContext;
}

export interface AgentBridgeMeta {
  agent_task_id: string | null;
  agent_run_id: string | null;
  poll_attempts: number;
  last_agent_status: string | null;
  bridge_error_code?: string | null;
}

export interface CreateAgentRunOptions {
  accountName?: string | null;
  runtimeConfig?: AgentRuntimeConfig | null;
  forceRuntimeConfig?: boolean;
}

export interface AgentBridgeRunResult {
  run: AgentRunPayload;
  bridgeMeta: AgentBridgeMeta;
}

export interface AgentRunPayload {
  run_id: string;
  mode?: string;
  trade_date?: string;
  stock_codes?: string[];
  status?: string;
  data_snapshot?: Record<string, unknown>;
  signal_snapshot?: Record<string, unknown>;
  risk_snapshot?: Record<string, unknown>;
  execution_snapshot?: Record<string, unknown>;
  account_snapshot?: Record<string, unknown>;
  started_at?: string;
  ended_at?: string;
  created_at?: string;
}

export interface AgentTaskPayload {
  task_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | string;
  request_id?: string;
  stock_codes?: string[];
  account_name?: string;
  run_id?: string;
  error_message?: string;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  updated_at?: string;
}
