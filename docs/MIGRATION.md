# Migration

Use `pnpm migrate:sqlite` to migrate legacy SQLite data into PostgreSQL.

Prisma schema migrations are versioned under `prisma/migrations/`.

- Baseline migration id: `20260305074500_baseline`
- Fresh DB deploy: `pnpm prisma:deploy`
- Existing DB already created by `db push`: run `pnpm exec prisma migrate resolve --applied 20260305074500_baseline` once
- Existing local DB whose schema is aligned but `_prisma_migrations` still contains the failed `20260307193000_scheduler_center`: run `pnpm db:repair:migration-history` once

Core migrated tables:

- analysis_history
- news_intel
- backtest_results
- backtest_summaries

Optional tables (migrated when present in source DB):

- analysis_tasks
- system_config_items
- system_config_revisions
- auth_credentials
- auth_sessions
- auth_rate_limits

Features:

- Re-runnable (idempotent with `skipDuplicates`)
- Batched migration
- Checkpoint resume via `migration_checkpoints`
- Sequence sync after migration

After `db push` / `migrate deploy`, run `pnpm db:constraints` to apply partial unique indexes (for active task deduplication).

Notes:

- New multi-user admin auth/RBAC tables (`admin_*`) are initialized by runtime seed when `ADMIN_AUTH_ENABLED=true`.
- Legacy `auth_*` data is not migrated into the new `admin_*` auth system.
