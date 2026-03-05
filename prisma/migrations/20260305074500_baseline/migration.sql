-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AnalysisTaskStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "AdminUserStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "AdminAuditAction" AS ENUM ('read', 'write');

-- CreateEnum
CREATE TYPE "UserBrokerAccountStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "BrokerEnvironment" AS ENUM ('paper', 'simulation');

-- CreateEnum
CREATE TYPE "SimulationOrderStatus" AS ENUM ('pending', 'partial_filled', 'filled', 'cancelled');

-- CreateEnum
CREATE TYPE "SimulationOrderDirection" AS ENUM ('buy', 'sell');

-- CreateEnum
CREATE TYPE "SimulationOrderType" AS ENUM ('limit', 'market');

-- CreateEnum
CREATE TYPE "AgentCredentialScope" AS ENUM ('read', 'trade');

-- CreateTable
CREATE TABLE "analysis_history" (
    "id" SERIAL NOT NULL,
    "owner_user_id" INTEGER,
    "query_id" VARCHAR(64),
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(50),
    "report_type" VARCHAR(16),
    "sentiment_score" INTEGER,
    "operation_advice" VARCHAR(128),
    "trend_prediction" VARCHAR(50),
    "analysis_summary" TEXT,
    "raw_result" TEXT,
    "news_content" TEXT,
    "context_snapshot" TEXT,
    "ideal_buy" DOUBLE PRECISION,
    "secondary_buy" DOUBLE PRECISION,
    "stop_loss" DOUBLE PRECISION,
    "take_profit" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analysis_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_intel" (
    "id" SERIAL NOT NULL,
    "owner_user_id" INTEGER,
    "query_id" VARCHAR(64),
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(50),
    "dimension" VARCHAR(32),
    "query" VARCHAR(255),
    "provider" VARCHAR(32),
    "title" VARCHAR(300) NOT NULL,
    "snippet" TEXT,
    "url" VARCHAR(1000) NOT NULL,
    "source" VARCHAR(100),
    "published_date" TIMESTAMP(3),
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "query_source" VARCHAR(32),
    "requester_platform" VARCHAR(20),
    "requester_user_id" VARCHAR(64),
    "requester_user_name" VARCHAR(64),
    "requester_chat_id" VARCHAR(64),
    "requester_message_id" VARCHAR(64),
    "requester_query" VARCHAR(255),

    CONSTRAINT "news_intel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_results" (
    "id" SERIAL NOT NULL,
    "owner_user_id" INTEGER,
    "analysis_history_id" INTEGER NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "analysis_date" DATE,
    "eval_window_days" INTEGER NOT NULL DEFAULT 10,
    "engine_version" VARCHAR(16) NOT NULL DEFAULT 'v1',
    "eval_status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operation_advice" VARCHAR(128),
    "position_recommendation" VARCHAR(8),
    "start_price" DOUBLE PRECISION,
    "end_close" DOUBLE PRECISION,
    "max_high" DOUBLE PRECISION,
    "min_low" DOUBLE PRECISION,
    "stock_return_pct" DOUBLE PRECISION,
    "direction_expected" VARCHAR(16),
    "direction_correct" BOOLEAN,
    "outcome" VARCHAR(16),
    "stop_loss" DOUBLE PRECISION,
    "take_profit" DOUBLE PRECISION,
    "hit_stop_loss" BOOLEAN,
    "hit_take_profit" BOOLEAN,
    "first_hit" VARCHAR(16),
    "first_hit_date" DATE,
    "first_hit_trading_days" INTEGER,
    "simulated_entry_price" DOUBLE PRECISION,
    "simulated_exit_price" DOUBLE PRECISION,
    "simulated_exit_reason" VARCHAR(24),
    "simulated_return_pct" DOUBLE PRECISION,

    CONSTRAINT "backtest_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_summaries" (
    "id" SERIAL NOT NULL,
    "owner_user_id" INTEGER,
    "scope" VARCHAR(16) NOT NULL,
    "code" VARCHAR(16),
    "eval_window_days" INTEGER NOT NULL DEFAULT 10,
    "engine_version" VARCHAR(16) NOT NULL DEFAULT 'v1',
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_evaluations" INTEGER NOT NULL DEFAULT 0,
    "completed_count" INTEGER NOT NULL DEFAULT 0,
    "insufficient_count" INTEGER NOT NULL DEFAULT 0,
    "long_count" INTEGER NOT NULL DEFAULT 0,
    "cash_count" INTEGER NOT NULL DEFAULT 0,
    "win_count" INTEGER NOT NULL DEFAULT 0,
    "loss_count" INTEGER NOT NULL DEFAULT 0,
    "neutral_count" INTEGER NOT NULL DEFAULT 0,
    "direction_accuracy_pct" DOUBLE PRECISION,
    "prediction_win_rate_pct" DOUBLE PRECISION,
    "trade_win_rate_pct" DOUBLE PRECISION,
    "win_rate_pct" DOUBLE PRECISION,
    "neutral_rate_pct" DOUBLE PRECISION,
    "avg_stock_return_pct" DOUBLE PRECISION,
    "avg_simulated_return_pct" DOUBLE PRECISION,
    "stop_loss_trigger_rate" DOUBLE PRECISION,
    "take_profit_trigger_rate" DOUBLE PRECISION,
    "ambiguous_rate" DOUBLE PRECISION,
    "avg_days_to_first_hit" DOUBLE PRECISION,
    "advice_breakdown_json" TEXT,
    "diagnostics_json" TEXT,

    CONSTRAINT "backtest_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_backtest_run_groups" (
    "id" SERIAL NOT NULL,
    "owner_user_id" INTEGER,
    "code" VARCHAR(16) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "effective_start_date" DATE,
    "effective_end_date" DATE,
    "engine_version" VARCHAR(32) NOT NULL DEFAULT 'backtrader_v1',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_backtest_run_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_backtest_runs" (
    "id" SERIAL NOT NULL,
    "run_group_id" INTEGER NOT NULL,
    "strategy_code" VARCHAR(32) NOT NULL,
    "strategy_version" VARCHAR(32) NOT NULL DEFAULT 'v1',
    "params_json" JSONB,
    "metrics_json" JSONB,
    "benchmark_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_backtest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_backtest_trades" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "entry_date" DATE,
    "exit_date" DATE,
    "entry_price" DOUBLE PRECISION,
    "exit_price" DOUBLE PRECISION,
    "qty" INTEGER,
    "gross_return_pct" DOUBLE PRECISION,
    "net_return_pct" DOUBLE PRECISION,
    "fees" DOUBLE PRECISION,
    "exit_reason" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_backtest_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_backtest_equity_points" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "trade_date" DATE NOT NULL,
    "equity" DOUBLE PRECISION NOT NULL,
    "drawdown_pct" DOUBLE PRECISION,
    "benchmark_equity" DOUBLE PRECISION,

    CONSTRAINT "strategy_backtest_equity_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_tasks" (
    "id" SERIAL NOT NULL,
    "owner_user_id" INTEGER,
    "task_id" VARCHAR(64) NOT NULL,
    "stock_code" VARCHAR(16) NOT NULL,
    "report_type" VARCHAR(16) NOT NULL DEFAULT 'detailed',
    "status" "AnalysisTaskStatus" NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "message" VARCHAR(200),
    "result_query_id" VARCHAR(64),
    "error" VARCHAR(500),
    "request_payload" JSONB,
    "result_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analysis_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_config_items" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "is_sensitive" BOOLEAN NOT NULL DEFAULT false,
    "category" VARCHAR(32) NOT NULL DEFAULT 'uncategorized',
    "data_type" VARCHAR(16) NOT NULL DEFAULT 'string',
    "ui_control" VARCHAR(16) NOT NULL DEFAULT 'text',
    "display_order" INTEGER NOT NULL DEFAULT 9999,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_config_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_config_revisions" (
    "id" SERIAL NOT NULL,
    "version" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_config_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" SERIAL NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" VARCHAR(64),
    "email" VARCHAR(128),
    "status" "AdminUserStatus" NOT NULL DEFAULT 'active',
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_user_profiles" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "simulation_account_name" VARCHAR(128) NOT NULL DEFAULT '',
    "simulation_account_id" VARCHAR(128) NOT NULL DEFAULT '',
    "simulation_initial_capital" DOUBLE PRECISION NOT NULL DEFAULT 100000,
    "simulation_note" VARCHAR(255),
    "ai_provider" VARCHAR(32) NOT NULL DEFAULT 'openai',
    "ai_base_url" VARCHAR(255) NOT NULL DEFAULT 'https://api.openai.com/v1',
    "ai_model" VARCHAR(128) NOT NULL DEFAULT 'gpt-4o-mini',
    "ai_token_ciphertext" TEXT,
    "ai_token_iv" VARCHAR(64),
    "ai_token_tag" VARCHAR(64),
    "strategy_position_max_pct" DOUBLE PRECISION NOT NULL DEFAULT 30,
    "strategy_stop_loss_pct" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "strategy_take_profit_pct" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_roles" (
    "id" SERIAL NOT NULL,
    "role_code" VARCHAR(64) NOT NULL,
    "role_name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(255),
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "admin_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_user_roles" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "role_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_role_permissions" (
    "id" SERIAL NOT NULL,
    "role_id" INTEGER NOT NULL,
    "module_code" VARCHAR(64) NOT NULL,
    "can_read" BOOLEAN NOT NULL DEFAULT true,
    "can_write" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" SERIAL NOT NULL,
    "session_id" VARCHAR(128) NOT NULL,
    "user_id" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(255),

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_login_rate_limits" (
    "id" SERIAL NOT NULL,
    "ip" VARCHAR(64) NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "first_failed_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_login_rate_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" SERIAL NOT NULL,
    "request_id" VARCHAR(64),
    "user_id" INTEGER,
    "username_snapshot" VARCHAR(64),
    "method" VARCHAR(8) NOT NULL,
    "path" VARCHAR(255) NOT NULL,
    "module_code" VARCHAR(64),
    "action" "AdminAuditAction" NOT NULL,
    "status_code" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "duration_ms" INTEGER NOT NULL,
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(255),
    "query_masked_json" TEXT,
    "body_masked_json" TEXT,
    "response_masked_json" TEXT,
    "error_code" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_broker_accounts" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "broker_code" VARCHAR(32) NOT NULL,
    "provider_code" VARCHAR(32) NOT NULL DEFAULT 'default',
    "provider_name" VARCHAR(64),
    "environment" "BrokerEnvironment" NOT NULL DEFAULT 'paper',
    "account_uid" VARCHAR(128) NOT NULL,
    "account_display_name" VARCHAR(128),
    "credential_ciphertext" TEXT NOT NULL,
    "credential_iv" VARCHAR(64) NOT NULL,
    "credential_tag" VARCHAR(64) NOT NULL,
    "status" "UserBrokerAccountStatus" NOT NULL DEFAULT 'active',
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "last_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "user_broker_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_broker_snapshot_cache" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "broker_account_id" INTEGER NOT NULL,
    "summary_json" TEXT,
    "positions_json" TEXT,
    "orders_json" TEXT,
    "trades_json" TEXT,
    "performance_json" TEXT,
    "snapshot_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_broker_snapshot_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_credential_tickets" (
    "id" SERIAL NOT NULL,
    "ticket_hash" VARCHAR(128) NOT NULL,
    "user_id" INTEGER NOT NULL,
    "broker_account_id" INTEGER NOT NULL,
    "scope" "AgentCredentialScope" NOT NULL DEFAULT 'read',
    "task_id" VARCHAR(64),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_credential_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_execution_events" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "broker_account_id" INTEGER NOT NULL,
    "task_id" VARCHAR(64),
    "event_type" VARCHAR(64) NOT NULL,
    "payload_json" TEXT,
    "status" VARCHAR(32) NOT NULL DEFAULT 'received',
    "error_code" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_execution_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_auto_orders" (
    "id" SERIAL NOT NULL,
    "task_id" VARCHAR(64) NOT NULL,
    "user_id" INTEGER NOT NULL,
    "broker_account_id" INTEGER NOT NULL,
    "stock_code" VARCHAR(16) NOT NULL,
    "direction" VARCHAR(8) NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "provider_order_id" VARCHAR(128),
    "provider_status" VARCHAR(64),
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(500),
    "idempotency_key" VARCHAR(128),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analysis_auto_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_credentials" (
    "id" INTEGER NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" SERIAL NOT NULL,
    "session_id" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_rate_limits" (
    "id" SERIAL NOT NULL,
    "ip" VARCHAR(64) NOT NULL,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "first_failed_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_rate_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_daily" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "date" DATE NOT NULL,
    "open" DOUBLE PRECISION,
    "high" DOUBLE PRECISION,
    "low" DOUBLE PRECISION,
    "close" DOUBLE PRECISION,
    "volume" DOUBLE PRECISION,
    "amount" DOUBLE PRECISION,
    "pct_chg" DOUBLE PRECISION,
    "ma5" DOUBLE PRECISION,
    "ma10" DOUBLE PRECISION,
    "ma20" DOUBLE PRECISION,
    "volume_ratio" DOUBLE PRECISION,
    "data_source" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migration_checkpoints" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "migration_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulation_positions" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "broker_account_id" INTEGER NOT NULL,
    "stock_code" VARCHAR(10) NOT NULL,
    "stock_name" VARCHAR(50),
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cost_basis" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avg_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "market_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unrealized_pnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "simulation_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulation_orders" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "broker_account_id" INTEGER NOT NULL,
    "order_id" VARCHAR(64) NOT NULL,
    "stock_code" VARCHAR(10) NOT NULL,
    "stock_name" VARCHAR(50),
    "direction" "SimulationOrderDirection" NOT NULL,
    "type" "SimulationOrderType" NOT NULL DEFAULT 'limit',
    "price" DOUBLE PRECISION NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "filled_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "filled_price" DOUBLE PRECISION,
    "status" "SimulationOrderStatus" NOT NULL DEFAULT 'pending',
    "error_message" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "simulation_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulation_trades" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "broker_account_id" INTEGER NOT NULL,
    "trade_id" VARCHAR(64) NOT NULL,
    "order_id" VARCHAR(64) NOT NULL,
    "stock_code" VARCHAR(10) NOT NULL,
    "stock_name" VARCHAR(50),
    "direction" "SimulationOrderDirection" NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "traded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "simulation_trades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_analysis_history_query_id" ON "analysis_history"("query_id");

-- CreateIndex
CREATE INDEX "ix_analysis_code_time" ON "analysis_history"("code", "created_at");

-- CreateIndex
CREATE INDEX "ix_analysis_history_owner_created" ON "analysis_history"("owner_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uix_news_url" ON "news_intel"("url");

-- CreateIndex
CREATE INDEX "ix_news_query_id" ON "news_intel"("query_id");

-- CreateIndex
CREATE INDEX "ix_news_code_pub" ON "news_intel"("code", "published_date");

-- CreateIndex
CREATE INDEX "ix_news_fetched_at" ON "news_intel"("fetched_at");

-- CreateIndex
CREATE INDEX "ix_news_owner_fetched_at" ON "news_intel"("owner_user_id", "fetched_at");

-- CreateIndex
CREATE INDEX "ix_backtest_code_date" ON "backtest_results"("code", "analysis_date");

-- CreateIndex
CREATE INDEX "ix_backtest_evaluated_at" ON "backtest_results"("evaluated_at");

-- CreateIndex
CREATE INDEX "ix_backtest_results_owner_evaluated" ON "backtest_results"("owner_user_id", "evaluated_at");

-- CreateIndex
CREATE UNIQUE INDEX "uix_backtest_analysis_window_version" ON "backtest_results"("analysis_history_id", "eval_window_days", "engine_version");

-- CreateIndex
CREATE INDEX "ix_backtest_summary_computed_at" ON "backtest_summaries"("computed_at");

-- CreateIndex
CREATE INDEX "ix_backtest_summary_owner_computed" ON "backtest_summaries"("owner_user_id", "computed_at");

-- CreateIndex
CREATE UNIQUE INDEX "uix_backtest_summary_owner_scope_code_window_version" ON "backtest_summaries"("owner_user_id", "scope", "code", "eval_window_days", "engine_version");

-- CreateIndex
CREATE INDEX "ix_strategy_backtest_group_owner_created" ON "strategy_backtest_run_groups"("owner_user_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_strategy_backtest_group_code_range" ON "strategy_backtest_run_groups"("code", "start_date", "end_date");

-- CreateIndex
CREATE INDEX "ix_strategy_backtest_run_group_strategy" ON "strategy_backtest_runs"("run_group_id", "strategy_code");

-- CreateIndex
CREATE INDEX "ix_strategy_backtest_trade_run_entry" ON "strategy_backtest_trades"("run_id", "entry_date");

-- CreateIndex
CREATE INDEX "ix_strategy_backtest_equity_run_date" ON "strategy_backtest_equity_points"("run_id", "trade_date");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_tasks_task_id_key" ON "analysis_tasks"("task_id");

-- CreateIndex
CREATE INDEX "ix_analysis_tasks_status_created" ON "analysis_tasks"("status", "created_at");

-- CreateIndex
CREATE INDEX "ix_analysis_tasks_stock_status" ON "analysis_tasks"("stock_code", "status");

-- CreateIndex
CREATE INDEX "ix_analysis_tasks_owner_created" ON "analysis_tasks"("owner_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "system_config_items_key_key" ON "system_config_items"("key");

-- CreateIndex
CREATE INDEX "ix_system_config_category_order" ON "system_config_items"("category", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "system_config_revisions_version_key" ON "system_config_revisions"("version");

-- CreateIndex
CREATE UNIQUE INDEX "uix_admin_users_username" ON "admin_users"("username");

-- CreateIndex
CREATE INDEX "ix_admin_users_status_deleted" ON "admin_users"("status", "is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "admin_user_profiles_user_id_key" ON "admin_user_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uix_admin_roles_code" ON "admin_roles"("role_code");

-- CreateIndex
CREATE INDEX "ix_admin_roles_deleted" ON "admin_roles"("is_deleted");

-- CreateIndex
CREATE INDEX "ix_admin_user_roles_role_id" ON "admin_user_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "uix_admin_user_roles_user_role" ON "admin_user_roles"("user_id", "role_id");

-- CreateIndex
CREATE INDEX "ix_admin_role_permissions_module" ON "admin_role_permissions"("module_code");

-- CreateIndex
CREATE UNIQUE INDEX "uix_admin_role_permissions_role_module" ON "admin_role_permissions"("role_id", "module_code");

-- CreateIndex
CREATE UNIQUE INDEX "uix_admin_sessions_session_id" ON "admin_sessions"("session_id");

-- CreateIndex
CREATE INDEX "ix_admin_sessions_expires_at" ON "admin_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "ix_admin_sessions_user_id" ON "admin_sessions"("user_id");

-- CreateIndex
CREATE INDEX "ix_admin_login_rate_limits_updated_at" ON "admin_login_rate_limits"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "uix_admin_login_rate_limits_ip_username" ON "admin_login_rate_limits"("ip", "username");

-- CreateIndex
CREATE INDEX "ix_admin_audit_logs_created_at" ON "admin_audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "ix_admin_audit_logs_module_code" ON "admin_audit_logs"("module_code");

-- CreateIndex
CREATE INDEX "ix_admin_audit_logs_user_id" ON "admin_audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "ix_admin_audit_logs_status_code" ON "admin_audit_logs"("status_code");

-- CreateIndex
CREATE INDEX "ix_user_broker_accounts_user_status" ON "user_broker_accounts"("user_id", "status");

-- CreateIndex
CREATE INDEX "ix_user_broker_accounts_deleted_at" ON "user_broker_accounts"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "uix_user_broker_accounts_user_broker_uid" ON "user_broker_accounts"("user_id", "broker_code", "account_uid");

-- CreateIndex
CREATE INDEX "ix_user_broker_snapshot_expires_at" ON "user_broker_snapshot_cache"("expires_at");

-- CreateIndex
CREATE INDEX "ix_user_broker_snapshot_user_expires" ON "user_broker_snapshot_cache"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "uix_user_broker_snapshot_user_account" ON "user_broker_snapshot_cache"("user_id", "broker_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "uix_agent_credential_tickets_hash" ON "agent_credential_tickets"("ticket_hash");

-- CreateIndex
CREATE INDEX "ix_agent_credential_tickets_expires_at" ON "agent_credential_tickets"("expires_at");

-- CreateIndex
CREATE INDEX "ix_agent_credential_tickets_user_created" ON "agent_credential_tickets"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_agent_credential_tickets_account_created" ON "agent_credential_tickets"("broker_account_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_agent_execution_events_user_created" ON "agent_execution_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_agent_execution_events_account_created" ON "agent_execution_events"("broker_account_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_agent_execution_events_task_id" ON "agent_execution_events"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "uix_analysis_auto_orders_idempotency_key" ON "analysis_auto_orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "ix_analysis_auto_orders_user_created" ON "analysis_auto_orders"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_analysis_auto_orders_account_created" ON "analysis_auto_orders"("broker_account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uix_analysis_auto_orders_task_stock" ON "analysis_auto_orders"("task_id", "stock_code");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_session_id_key" ON "auth_sessions"("session_id");

-- CreateIndex
CREATE INDEX "ix_auth_sessions_expires_at" ON "auth_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_rate_limits_ip_key" ON "auth_rate_limits"("ip");

-- CreateIndex
CREATE INDEX "ix_code_date" ON "stock_daily"("code", "date");

-- CreateIndex
CREATE UNIQUE INDEX "uix_code_date" ON "stock_daily"("code", "date");

-- CreateIndex
CREATE UNIQUE INDEX "migration_checkpoints_key_key" ON "migration_checkpoints"("key");

-- CreateIndex
CREATE INDEX "ix_simulation_position_user_broker" ON "simulation_positions"("user_id", "broker_account_id");

-- CreateIndex
CREATE INDEX "ix_simulation_position_stock_code" ON "simulation_positions"("stock_code");

-- CreateIndex
CREATE UNIQUE INDEX "uix_simulation_position_user_broker_stock" ON "simulation_positions"("user_id", "broker_account_id", "stock_code");

-- CreateIndex
CREATE UNIQUE INDEX "simulation_orders_order_id_key" ON "simulation_orders"("order_id");

-- CreateIndex
CREATE INDEX "ix_simulation_order_user_broker" ON "simulation_orders"("user_id", "broker_account_id");

-- CreateIndex
CREATE INDEX "ix_simulation_order_stock_code" ON "simulation_orders"("stock_code");

-- CreateIndex
CREATE INDEX "ix_simulation_order_status" ON "simulation_orders"("status");

-- CreateIndex
CREATE INDEX "ix_simulation_order_created_at" ON "simulation_orders"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "simulation_trades_trade_id_key" ON "simulation_trades"("trade_id");

-- CreateIndex
CREATE INDEX "ix_simulation_trade_user_broker" ON "simulation_trades"("user_id", "broker_account_id");

-- CreateIndex
CREATE INDEX "ix_simulation_trade_stock_code" ON "simulation_trades"("stock_code");

-- CreateIndex
CREATE INDEX "ix_simulation_trade_traded_at" ON "simulation_trades"("traded_at");

-- AddForeignKey
ALTER TABLE "analysis_history" ADD CONSTRAINT "analysis_history_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "news_intel" ADD CONSTRAINT "news_intel_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_analysis_history_id_fkey" FOREIGN KEY ("analysis_history_id") REFERENCES "analysis_history"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtest_summaries" ADD CONSTRAINT "backtest_summaries_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_backtest_run_groups" ADD CONSTRAINT "strategy_backtest_run_groups_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_backtest_runs" ADD CONSTRAINT "strategy_backtest_runs_run_group_id_fkey" FOREIGN KEY ("run_group_id") REFERENCES "strategy_backtest_run_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_backtest_trades" ADD CONSTRAINT "strategy_backtest_trades_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "strategy_backtest_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_backtest_equity_points" ADD CONSTRAINT "strategy_backtest_equity_points_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "strategy_backtest_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_tasks" ADD CONSTRAINT "analysis_tasks_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_profiles" ADD CONSTRAINT "admin_user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "admin_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_role_permissions" ADD CONSTRAINT "admin_role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "admin_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_broker_accounts" ADD CONSTRAINT "user_broker_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_broker_snapshot_cache" ADD CONSTRAINT "user_broker_snapshot_cache_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_broker_snapshot_cache" ADD CONSTRAINT "user_broker_snapshot_cache_broker_account_id_fkey" FOREIGN KEY ("broker_account_id") REFERENCES "user_broker_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_credential_tickets" ADD CONSTRAINT "agent_credential_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_credential_tickets" ADD CONSTRAINT "agent_credential_tickets_broker_account_id_fkey" FOREIGN KEY ("broker_account_id") REFERENCES "user_broker_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_execution_events" ADD CONSTRAINT "agent_execution_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_execution_events" ADD CONSTRAINT "agent_execution_events_broker_account_id_fkey" FOREIGN KEY ("broker_account_id") REFERENCES "user_broker_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_auto_orders" ADD CONSTRAINT "analysis_auto_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_auto_orders" ADD CONSTRAINT "analysis_auto_orders_broker_account_id_fkey" FOREIGN KEY ("broker_account_id") REFERENCES "user_broker_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulation_positions" ADD CONSTRAINT "simulation_positions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulation_positions" ADD CONSTRAINT "simulation_positions_broker_account_id_fkey" FOREIGN KEY ("broker_account_id") REFERENCES "user_broker_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulation_orders" ADD CONSTRAINT "simulation_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulation_orders" ADD CONSTRAINT "simulation_orders_broker_account_id_fkey" FOREIGN KEY ("broker_account_id") REFERENCES "user_broker_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulation_trades" ADD CONSTRAINT "simulation_trades_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulation_trades" ADD CONSTRAINT "simulation_trades_broker_account_id_fkey" FOREIGN KEY ("broker_account_id") REFERENCES "user_broker_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

