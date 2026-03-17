/** Agent 通信基础设施使用的错误定义，统一约束跨层错误语义。 */

import { AgentBridgeMeta } from './agent.types';

export type AgentClientErrorCode =
  | 'agent_timeout'
  | 'agent_network_error'
  | 'agent_http_error'
  | 'agent_response_parse_error';

export interface AgentClientErrorOptions {
  statusCode?: number;
  upstreamErrorCode?: string | null;
  retryable?: boolean;
}

export class AgentClientError extends Error {
  readonly code: AgentClientErrorCode;
  readonly statusCode: number | null;
  readonly upstreamErrorCode: string | null;
  readonly retryable: boolean;

  constructor(message: string, code: AgentClientErrorCode, options?: AgentClientErrorOptions) {
    super(message);
    this.name = 'AgentClientError';
    this.code = code;
    this.statusCode = options?.statusCode ?? null;
    this.upstreamErrorCode = options?.upstreamErrorCode ?? null;
    this.retryable = Boolean(options?.retryable);
  }
}

export function isAgentClientError(error: unknown): error is AgentClientError {
  return error instanceof AgentClientError;
}

export type AgentRunBridgeErrorCode =
  | 'agent_task_submit_failed'
  | 'agent_task_failed'
  | 'agent_poll_timeout'
  | 'agent_poll_network_error'
  | 'agent_task_invalid_payload'
  | 'agent_run_fetch_failed'
  | 'agent_upstream_error';

export class AgentRunBridgeError extends Error {
  readonly code: AgentRunBridgeErrorCode;
  readonly bridgeMeta: AgentBridgeMeta;

  constructor(message: string, code: AgentRunBridgeErrorCode, bridgeMeta: AgentBridgeMeta) {
    super(message);
    this.name = 'AgentRunBridgeError';
    this.code = code;
    this.bridgeMeta = bridgeMeta;
  }
}

export function isAgentRunBridgeError(error: unknown): error is AgentRunBridgeError {
  return error instanceof AgentRunBridgeError;
}
