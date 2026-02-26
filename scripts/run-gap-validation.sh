#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEGACY_DIR="$(cd "$ROOT_DIR/../daily_stock_analysis" && pwd)"
AGENT_DIR="$(cd "$ROOT_DIR/../Agent_stock" && pwd)"
TMP_DIR="${TMP_DIR:-/tmp/backend_gap_validation}"

E2E_DB="${E2E_DB:-backend_stock_e2e}"
MIG_DB="${MIG_DB:-backend_stock_migtest}"
PG_USER="${PG_USER:-$(whoami)}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"

E2E_DATABASE_URL="postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/${E2E_DB}?schema=public"
MIG_DATABASE_URL="postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/${MIG_DB}?schema=public"
AGENT_DATABASE_URL="sqlite:///${AGENT_DIR}/data/stock_analysis.db"
AGENT_TOKEN="${AGENT_TOKEN:-backend_agent_token_v4_2026}"
E2E_ADMIN_USERNAME="${E2E_ADMIN_USERNAME:-admin}"
E2E_ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-BackendE2E#2026}"

mkdir -p "$TMP_DIR"

BACKEND_API_PID=""
BACKEND_WORKER_PID=""
AGENT_PID=""
OLD_API_PID=""

cleanup() {
  set +e
  if [[ -n "$BACKEND_WORKER_PID" ]]; then kill "$BACKEND_WORKER_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "$BACKEND_API_PID" ]]; then kill "$BACKEND_API_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "$AGENT_PID" ]]; then kill "$AGENT_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "$OLD_API_PID" ]]; then kill "$OLD_API_PID" >/dev/null 2>&1 || true; fi
  kill_port 8000 || true
  kill_port 8001 || true
  kill_port 8002 || true
}
trap cleanup EXIT

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi
  kill $pids >/dev/null 2>&1 || true
  sleep 1
  local remain
  remain="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [[ -n "$remain" ]]; then
    kill -9 $remain >/dev/null 2>&1 || true
  fi
}

wait_for_url() {
  local url="$1"
  local label="$2"
  for _ in {1..90}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "${label} is ready: ${url}"
      return 0
    fi
    sleep 1
  done
  echo "Timeout waiting for ${label}: ${url}" >&2
  return 1
}

recreate_db() {
  local db_name="$1"
  psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db_name}' AND pid <> pg_backend_pid();" >/dev/null
  psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS \"${db_name}\";" >/dev/null
  psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -c "CREATE DATABASE \"${db_name}\";" >/dev/null
}

prepare_backend_db() {
  local db_url="$1"
  (
    cd "$ROOT_DIR"
    DATABASE_URL="$db_url" pnpm db:push >/dev/null
    DATABASE_URL="$db_url" pnpm db:constraints >/dev/null
  )
}

echo "[Build] Compile backend before validation"
(
  cd "$ROOT_DIR"
  pnpm build >/dev/null
)

echo "[Phase 1/3] Runtime contract comparison (old vs new)"
kill_port 8000 || true
kill_port 8001 || true
kill_port 8002 || true
recreate_db "$E2E_DB"
prepare_backend_db "$E2E_DATABASE_URL"

(
  cd "$LEGACY_DIR"
  ADMIN_AUTH_ENABLED=false "$AGENT_DIR/.venv/bin/python" -m uvicorn server:app --host 127.0.0.1 --port 8000 >"$TMP_DIR/old_api.log" 2>&1 &
  OLD_API_PID=$!
  echo "$OLD_API_PID" >"$TMP_DIR/old_api.pid"
)
OLD_API_PID="$(cat "$TMP_DIR/old_api.pid")"

(
  cd "$ROOT_DIR"
  DATABASE_URL="$E2E_DATABASE_URL" \
  AGENT_BASE_URL="http://127.0.0.1:8001" \
  AGENT_SERVICE_AUTH_TOKEN="$AGENT_TOKEN" \
  ADMIN_AUTH_ENABLED=false \
  pnpm start:api >"$TMP_DIR/backend_api_contract.log" 2>&1 &
  BACKEND_API_PID=$!
  echo "$BACKEND_API_PID" >"$TMP_DIR/backend_api_contract.pid"
)
BACKEND_API_PID="$(cat "$TMP_DIR/backend_api_contract.pid")"

wait_for_url "http://127.0.0.1:8000/api/health" "old backend"
wait_for_url "http://127.0.0.1:8002/api/health" "new backend"

(
  cd "$ROOT_DIR"
  pnpm contract:compare "http://127.0.0.1:8000" "http://127.0.0.1:8002" "$ROOT_DIR/docs/CONTRACT_REPORT.md"
)

kill "$BACKEND_API_PID" >/dev/null 2>&1 || true
kill "$OLD_API_PID" >/dev/null 2>&1 || true
BACKEND_API_PID=""
OLD_API_PID=""
kill_port 8000 || true
kill_port 8002 || true

echo "[Phase 2/3] Agent integration + e2e flow validation"
kill_port 8000 || true
kill_port 8001 || true
kill_port 8002 || true
recreate_db "$E2E_DB"
prepare_backend_db "$E2E_DATABASE_URL"

(
  cd "$AGENT_DIR"
  AGENT_SERVICE_MODE=true \
  AGENT_SERVICE_HOST=127.0.0.1 \
  AGENT_SERVICE_PORT=8001 \
  AGENT_SERVICE_AUTH_TOKEN="$AGENT_TOKEN" \
  DATABASE_URL="$AGENT_DATABASE_URL" \
  "$AGENT_DIR/.venv/bin/python" -m uvicorn agent_server:app --host 127.0.0.1 --port 8001 >"$TMP_DIR/agent.log" 2>&1 &
  AGENT_PID=$!
  echo "$AGENT_PID" >"$TMP_DIR/agent.pid"
)
AGENT_PID="$(cat "$TMP_DIR/agent.pid")"

(
  cd "$ROOT_DIR"
  DATABASE_URL="$E2E_DATABASE_URL" \
  AGENT_BASE_URL="http://127.0.0.1:8001" \
  AGENT_SERVICE_AUTH_TOKEN="$AGENT_TOKEN" \
  ADMIN_AUTH_ENABLED=true \
  ADMIN_INIT_USERNAME="$E2E_ADMIN_USERNAME" \
  ADMIN_INIT_PASSWORD="$E2E_ADMIN_PASSWORD" \
  pnpm start:api >"$TMP_DIR/backend_api.log" 2>&1 &
  BACKEND_API_PID=$!
  echo "$BACKEND_API_PID" >"$TMP_DIR/backend_api.pid"
)
BACKEND_API_PID="$(cat "$TMP_DIR/backend_api.pid")"

(
  cd "$ROOT_DIR"
  DATABASE_URL="$E2E_DATABASE_URL" \
  AGENT_BASE_URL="http://127.0.0.1:8001" \
  AGENT_SERVICE_AUTH_TOKEN="$AGENT_TOKEN" \
  ADMIN_AUTH_ENABLED=true \
  ADMIN_INIT_USERNAME="$E2E_ADMIN_USERNAME" \
  ADMIN_INIT_PASSWORD="$E2E_ADMIN_PASSWORD" \
  pnpm start:worker >"$TMP_DIR/backend_worker.log" 2>&1 &
  BACKEND_WORKER_PID=$!
  echo "$BACKEND_WORKER_PID" >"$TMP_DIR/backend_worker.pid"
)
BACKEND_WORKER_PID="$(cat "$TMP_DIR/backend_worker.pid")"

wait_for_url "http://127.0.0.1:8001/api/health/live" "agent service"
wait_for_url "http://127.0.0.1:8002/api/health" "new backend api"

(
  cd "$ROOT_DIR"
  E2E_ADMIN_USERNAME="$E2E_ADMIN_USERNAME" \
  E2E_ADMIN_PASSWORD="$E2E_ADMIN_PASSWORD" \
  pnpm validate:e2e:flows "$ROOT_DIR/docs/GAP_VALIDATION_REPORT.md" "http://127.0.0.1:8002"
)

kill "$BACKEND_WORKER_PID" >/dev/null 2>&1 || true
kill "$BACKEND_API_PID" >/dev/null 2>&1 || true
kill "$AGENT_PID" >/dev/null 2>&1 || true
BACKEND_WORKER_PID=""
BACKEND_API_PID=""
AGENT_PID=""
kill_port 8001 || true
kill_port 8002 || true

echo "[Phase 3/3] Migration replay + reconciliation"
recreate_db "$MIG_DB"
prepare_backend_db "$MIG_DATABASE_URL"

(
  cd "$ROOT_DIR"
  DATABASE_URL="$MIG_DATABASE_URL" \
  LEGACY_SQLITE_PATH="$AGENT_DIR/data/stock_analysis.db" \
  pnpm migrate:sqlite >/dev/null
  DATABASE_URL="$MIG_DATABASE_URL" \
  pnpm verify:migration "$AGENT_DIR/data/stock_analysis.db" "$ROOT_DIR/docs/MIGRATION_VERIFICATION_REPORT.md"
)

echo "Gap validation completed."
echo "Reports:"
echo " - $ROOT_DIR/docs/CONTRACT_REPORT.md"
echo " - $ROOT_DIR/docs/GAP_VALIDATION_REPORT.md"
echo " - $ROOT_DIR/docs/MIGRATION_VERIFICATION_REPORT.md"
