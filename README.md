# Backend_stock

Standalone backend service extracted from `daily_stock_analysis`.

## Stack

- Node.js 22+
- NestJS
- Prisma + PostgreSQL
- pnpm

## Quick Start

```bash
cp .env.example .env
pnpm install
pnpm db:init
pnpm start:dev
```

If you enable admin auth (`ADMIN_AUTH_ENABLED=true`) and the database has no admin users yet, set at least:

```bash
ADMIN_INIT_USERNAME=admin
ADMIN_INIT_PASSWORD=your_strong_password
```

Optional auth/user settings env:

```bash
ADMIN_SELF_REGISTER_ENABLED=true
PERSONAL_SECRET_KEY=<32-byte key in hex/base64>
AGENT_FORWARD_RUNTIME_CONFIG=false
BROKER_SECRET_KEY=<32-byte key in hex/base64>
BROKER_GATEWAY_BASE_URL=http://127.0.0.1:8010
BROKER_SNAPSHOT_CACHE_TTL_MS=60000
# Agent async bridge polling (avoid long sync call timeout false-fail)
AGENT_REQUEST_TIMEOUT_MS=30000
AGENT_TASK_POLL_INTERVAL_MS=2000
AGENT_TASK_POLL_TIMEOUT_MS=600000
AGENT_TASK_POLL_MAX_RETRIES=3
AGENT_TASK_RETRY_BASE_DELAY_MS=1000
AGENT_CREDENTIAL_TICKET_TTL_SEC=900
AGENT_CREDENTIAL_TICKET_MAX_TTL_SEC=3600
```

Single-process mode (API + Worker in one command):

```bash
pnpm start:dev:all
```

Start worker in another terminal:

```bash
pnpm start:worker:dev
```

`RUN_WORKER_IN_API=true` enables embedded worker mode. Default is `false`.

Production-style start:

```bash
pnpm build
pnpm start:api
pnpm start:worker
```

## API Base

- `http://127.0.0.1:8002`
- Health: `GET /api/health`
- OpenAPI JSON: `GET /openapi.json`
- Swagger UI: `GET /docs`

## Main Compatibility Endpoints

- `/api/v1/auth/*`
- `/api/v1/users/me/settings`
- `/api/v1/users/me/broker-accounts/*`
- `/api/v1/users/me/trading/*`
- `/api/v1/analysis/*`
- `/api/v1/history*`
- `/api/v1/backtest/*`
- `/api/v1/stocks/*`
- `/api/v1/system/*`
- `/api/v1/admin/users/*`
- `/api/v1/admin/roles/*`
- `/api/v1/admin/logs/*`
- `/api/v1/internal/agent/*` (service token auth)

Additional real-data endpoints (for Frontend_stock reserved APIs):

- `GET /api/v1/stocks/:stock_code/indicators`
- `GET /api/v1/stocks/:stock_code/factors`
- `GET /api/v1/backtest/curves`
- `GET /api/v1/backtest/distribution`
- `POST /api/v1/backtest/compare`
- `GET /api/v1/analysis/tasks/:task_id/stages`
- `GET /api/v1/analysis/tasks/:task_id/stages/stream` (SSE)

## Auth & RBAC

- Login request body is now `username + password`.
- Self-register endpoint: `POST /api/v1/auth/register` (default enabled, assign `analyst` role).
- The system uses module-level RBAC:
  - Modules: `analysis/history/stocks/backtest/system_config/user_settings/broker_account/trading_account/admin_user/admin_role/admin_log/auth`
  - Roles: `super_admin`, `analyst`, `operator`
- Audit logs are persisted for all `/api/v1/*` requests with masked request/response summaries.
- Non-`super_admin` users can only view their own business data (analysis/history/backtest) and own audit logs.

## Agent Runtime Forwarding

- `AGENT_FORWARD_RUNTIME_CONFIG=false` (default): Backend does not send user runtime config to Agent.
- `AGENT_FORWARD_RUNTIME_CONFIG=true`: Backend forwards `runtime_config` to Agent and includes decrypted per-user `api_token` in-memory only when available.
- Broker mode (`execution_mode=broker`) always forces runtime forwarding for that task, even when `AGENT_FORWARD_RUNTIME_CONFIG=false`.
- `analysis_tasks.request_payload.runtime_config` always stores masked payload (no plaintext token).

## Agent Async Bridge (Task Stability)

- Backend worker submits Agent run via async mode and polls `/api/v1/tasks/:task_id`, then fetches final run by `/api/v1/runs/:run_id`.
- This avoids marking long-running tasks as failed due to single request timeout.
- `analysis_tasks.result_payload.bridge_meta` includes:
  - `agent_task_id`
  - `agent_run_id`
  - `poll_attempts`
  - `last_agent_status`
  - `bridge_error_code` (on failure)

## Broker Account Binding (Backend-only)

- Backend supports per-user broker account binding and encrypted credential storage.
- Credentials are encrypted with `BROKER_SECRET_KEY` and never returned in plaintext.
- Real account data APIs (summary/positions/orders/trades/performance) call Broker Gateway and use short cache.
- Internal Agent bridge endpoints are prepared:
  - `POST /api/v1/internal/agent/credential-tickets`
  - `POST /api/v1/internal/agent/credential-tickets/exchange`
  - `POST /api/v1/internal/agent/execution-events`
- Internal endpoints require `Authorization: Bearer <AGENT_SERVICE_AUTH_TOKEN>`.
- `POST /api/v1/analysis/analyze` now supports optional `execution_mode=auto|paper|broker` and `broker_account_id`.
- `execution_mode=auto` strategy: has verified active broker account => broker; otherwise paper.
- If a task expects broker execution but Agent returns paper/fallback (`executed_via!=broker` or `fallback_reason`), Backend marks task failed with `broker_execution_degraded`.
- Current Agent repository still reports broker fallback when broker order contract is disabled; in that state broker tasks will fail by design (no false success).

## Frontend Integration Hint

- Set `Frontend_stock` `VITE_DATA_MODE=api` when you need full real-data path without mock/derived fallback.

## SQLite Migration

```bash
pnpm migrate:sqlite
```

This migrates core data from the legacy sqlite database into PostgreSQL.

Core migrated tables:

- `analysis_history`
- `news_intel`
- `backtest_results`
- `backtest_summaries`
- `analysis_tasks` (if present)
- `system_config_items` (if present)
- `system_config_revisions` (if present)
- `auth_credentials` (if present)
- `auth_sessions` (if present)
- `auth_rate_limits` (if present)

The script is re-runnable and checkpoint-based.

## Supplemental SQL Constraints

```bash
pnpm db:constraints
```

This applies PostgreSQL-native constraints not expressed by Prisma partial indexes (for example active task deduplication by `stock_code`).

## Full Gap Validation

```bash
pnpm gap:validate
```

This runs:

- Runtime contract comparison between legacy backend (`:8000`) and Backend_stock (`:8002`)
- Agent_stock + Backend_stock integration flow validation (auth/analysis/task/history/backtest/stocks/system-config)
- SQLite-to-PostgreSQL migration replay and reconciliation

Generated reports:

- `docs/CONTRACT_REPORT.md`
- `docs/GAP_VALIDATION_REPORT.md`
- `docs/MIGRATION_VERIFICATION_REPORT.md`
