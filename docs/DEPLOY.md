# Deploy

1. Configure `.env` (or copy from `.env.example`).
   - If `ADMIN_AUTH_ENABLED=true` and this is a fresh database, configure `ADMIN_INIT_USERNAME` and `ADMIN_INIT_PASSWORD`.
   - If you need self register, keep `ADMIN_SELF_REGISTER_ENABLED=true` (default true).
   - Configure `PERSONAL_SECRET_KEY` (32-byte hex/base64) to enable encrypted user AI token storage.
   - Configure `BROKER_SECRET_KEY` (32-byte hex/base64) to enable encrypted broker credential storage.
   - Configure Broker Gateway endpoint:
     - `BROKER_GATEWAY_BASE_URL` (e.g. `http://127.0.0.1:8010`)
     - `BROKER_GATEWAY_TIMEOUT_MS` (default `15000`)
     - `BROKER_SNAPSHOT_CACHE_TTL_MS` (default `60000`)
   - Keep `AGENT_FORWARD_RUNTIME_CONFIG=false` unless Agent service already supports runtime config payload.
   - If you enable `AGENT_FORWARD_RUNTIME_CONFIG=true`, ensure `PERSONAL_SECRET_KEY` is valid so user token can be decrypted for Agent forwarding.
   - For broker tasks, Backend force-forwards runtime config regardless of `AGENT_FORWARD_RUNTIME_CONFIG`.
   - Keep `AGENT_REQUEST_TIMEOUT_MS` in a short range (recommended `15000~30000`) for single HTTP calls.
   - Use async bridge polling vars for long tasks:
     - `AGENT_TASK_POLL_INTERVAL_MS=2000`
     - `AGENT_TASK_POLL_TIMEOUT_MS=600000`
     - `AGENT_TASK_POLL_MAX_RETRIES=3`
     - `AGENT_TASK_RETRY_BASE_DELAY_MS=1000`
     - `AGENT_CREDENTIAL_TICKET_TTL_SEC=900`
     - `AGENT_CREDENTIAL_TICKET_MAX_TTL_SEC=3600`
2. Install dependencies: `pnpm install`.
3. Prepare PostgreSQL and schema: `pnpm db:init` (dev) or `pnpm prisma:deploy && pnpm db:constraints` (prod).
4. Build: `pnpm build`.
5. Start API: `pnpm start:api`.
6. Start worker: `pnpm start:worker`.

Notes:

- Dev default `DATABASE_URL` follows Homebrew local no-password mode: `postgresql://<macOS-user>@localhost:5432/backend_stock?schema=public`.
- Keep `AGENT_BASE_URL` pointing to `Agent_stock` service.
- Backend analysis worker now uses async bridge (`/api/v1/runs` async + `/api/v1/tasks/:id` poll + `/api/v1/runs/:id` fetch) to avoid false-failure caused by long sync requests.
- Frontend integration in real-data mode should use `VITE_DATA_MODE=api` (in Frontend_stock env).
- New broker/account endpoints in Backend:
  - `GET|POST|PUT|DELETE /api/v1/users/me/broker-accounts`
  - `POST /api/v1/users/me/broker-accounts/:id/verify`
  - `GET /api/v1/users/me/trading/account-summary|positions|orders|trades|performance`
- Internal Agent bridge endpoints (service token auth):
  - `POST /api/v1/internal/agent/credential-tickets`
  - `POST /api/v1/internal/agent/credential-tickets/exchange`
  - `POST /api/v1/internal/agent/execution-events`
- Analysis API supports optional execution planning fields:
  - `execution_mode=auto|paper|broker` (default `auto`)
  - `broker_account_id` (optional)
- If broker execution is requested but Agent returns paper/fallback, Backend marks task failed with `broker_execution_degraded`.
- Current Agent implementation may still fall back to paper when broker order contract is disabled.
- Reserved API mappings now exist in Backend:
  - `/api/v1/stocks/:stock_code/indicators`
  - `/api/v1/stocks/:stock_code/factors`
  - `/api/v1/backtest/curves`
  - `/api/v1/backtest/distribution`
  - `/api/v1/backtest/compare`
  - `/api/v1/analysis/tasks/:task_id/stages`
  - `/api/v1/analysis/tasks/:task_id/stages/stream`
