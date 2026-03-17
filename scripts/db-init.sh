#!/usr/bin/env bash
# 初始化本地 PostgreSQL 与 Prisma 运行环境，适合开发机首次启动前执行。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# 允许开发机通过环境变量快速切换数据库名、端口和用户，避免每次都要手改脚本。
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

# 这里直接在 postgres 库里探测/建库，避免对目标业务库不存在时的连接报错做额外分支。
DB_EXISTS="$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")"
if [ "$DB_EXISTS" != "1" ]; then
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "CREATE DATABASE \"${DB_NAME}\";"
fi

DATABASE_URL="postgresql://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public"

# 优先原位更新 .env 里的 DATABASE_URL，避免开发者手工维护多个环境文件时漏改连接串。
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

# 先生成 Prisma Client，再决定是走 migration 还是 db push，保证后续命令用到的是最新类型。
pnpm prisma:generate
# 默认优先走 migrate deploy；只有显式声明 DB_INIT_USE_DB_PUSH 时才退回到宽松的 db push。
if [ "${DB_INIT_USE_DB_PUSH:-false}" = "true" ]; then
  pnpm db:push
else
  if ! pnpm prisma:deploy; then
    echo "prisma migrate deploy failed."
    echo "If this database was previously initialized via db push, resolve the baseline first:"
    echo "pnpm exec prisma migrate resolve --applied 20260305074500_baseline"
    exit 1
  fi
fi
pnpm db:constraints

echo "Database ready: ${DATABASE_URL}"
