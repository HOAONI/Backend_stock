#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_NAME="${DB_NAME:-backend_stock}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-$(whoami)}"

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required but not found."
  exit 1
fi

if [ ! -f ".env" ]; then
  cp .env.example .env
fi

DB_EXISTS="$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")"
if [ "$DB_EXISTS" != "1" ]; then
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "CREATE DATABASE \"${DB_NAME}\";"
fi

DATABASE_URL="postgresql://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public"

if grep -q '^DATABASE_URL=' .env; then
  awk -v repl="DATABASE_URL=${DATABASE_URL}" '
    BEGIN { done = 0 }
    /^DATABASE_URL=/ && done == 0 { print repl; done = 1; next }
    { print }
    END { if (done == 0) print repl }
  ' .env > .env.tmp && mv .env.tmp .env
else
  echo "DATABASE_URL=${DATABASE_URL}" >> .env
fi

pnpm prisma:generate
pnpm db:push
pnpm db:constraints

echo "Database ready: ${DATABASE_URL}"
