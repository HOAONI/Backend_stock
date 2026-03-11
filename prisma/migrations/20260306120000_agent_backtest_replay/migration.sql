-- CreateTable
CREATE TABLE "agent_backtest_run_groups" (
    "id" SERIAL NOT NULL,
    "owner_user_id" INTEGER,
    "code" VARCHAR(16) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "effective_start_date" DATE,
    "effective_end_date" DATE,
    "engine_version" VARCHAR(32) NOT NULL DEFAULT 'agent_replay_v1',
    "status" VARCHAR(16) NOT NULL DEFAULT 'completed',
    "phase" VARCHAR(16) NOT NULL DEFAULT 'done',
    "request_hash" VARCHAR(128) NOT NULL,
    "active_result_version" INTEGER NOT NULL DEFAULT 1,
    "latest_result_version" INTEGER NOT NULL DEFAULT 1,
    "progress_pct" INTEGER NOT NULL DEFAULT 100,
    "message" VARCHAR(255),
    "config_json" JSONB,
    "summary_json" JSONB,
    "diagnostics_json" JSONB,
    "fast_ready_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_backtest_run_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_backtest_daily_steps" (
    "id" SERIAL NOT NULL,
    "run_group_id" INTEGER NOT NULL,
    "result_version" INTEGER NOT NULL DEFAULT 1,
    "trade_date" DATE NOT NULL,
    "decision_source" VARCHAR(32) NOT NULL,
    "ai_used" BOOLEAN NOT NULL DEFAULT false,
    "data_payload_json" JSONB,
    "signal_payload_json" JSONB,
    "risk_payload_json" JSONB,
    "execution_payload_json" JSONB,

    CONSTRAINT "agent_backtest_daily_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_backtest_trades" (
    "id" SERIAL NOT NULL,
    "run_group_id" INTEGER NOT NULL,
    "result_version" INTEGER NOT NULL DEFAULT 1,
    "entry_date" DATE,
    "exit_date" DATE,
    "entry_price" DOUBLE PRECISION,
    "exit_price" DOUBLE PRECISION,
    "qty" INTEGER,
    "gross_return_pct" DOUBLE PRECISION,
    "net_return_pct" DOUBLE PRECISION,
    "fees" DOUBLE PRECISION,
    "exit_reason" VARCHAR(64),

    CONSTRAINT "agent_backtest_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_backtest_equity_points" (
    "id" SERIAL NOT NULL,
    "run_group_id" INTEGER NOT NULL,
    "result_version" INTEGER NOT NULL DEFAULT 1,
    "trade_date" DATE NOT NULL,
    "equity" DOUBLE PRECISION NOT NULL,
    "drawdown_pct" DOUBLE PRECISION,
    "benchmark_equity" DOUBLE PRECISION,
    "position_ratio" DOUBLE PRECISION,
    "cash" DOUBLE PRECISION,

    CONSTRAINT "agent_backtest_equity_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_backtest_signal_snapshots" (
    "id" SERIAL NOT NULL,
    "owner_user_id" INTEGER,
    "code" VARCHAR(16) NOT NULL,
    "trade_date" DATE NOT NULL,
    "signal_profile_hash" VARCHAR(128) NOT NULL,
    "snapshot_version" INTEGER NOT NULL DEFAULT 1,
    "decision_source" VARCHAR(32) NOT NULL,
    "llm_used" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "factor_payload_json" JSONB,
    "archived_news_payload_json" JSONB,
    "signal_payload_json" JSONB,
    "ai_overlay_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_backtest_signal_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uix_agent_backtest_request_hash" ON "agent_backtest_run_groups"("request_hash");

-- CreateIndex
CREATE INDEX "ix_agent_backtest_group_owner_created" ON "agent_backtest_run_groups"("owner_user_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_agent_backtest_group_status_phase_created" ON "agent_backtest_run_groups"("status", "phase", "created_at");

-- CreateIndex
CREATE INDEX "ix_agent_backtest_group_code_range" ON "agent_backtest_run_groups"("code", "start_date", "end_date");

-- CreateIndex
CREATE UNIQUE INDEX "uix_agent_backtest_step_group_version_day" ON "agent_backtest_daily_steps"("run_group_id", "result_version", "trade_date");

-- CreateIndex
CREATE INDEX "ix_agent_backtest_step_group_version_day" ON "agent_backtest_daily_steps"("run_group_id", "result_version", "trade_date");

-- CreateIndex
CREATE INDEX "ix_agent_backtest_trade_group_version_entry" ON "agent_backtest_trades"("run_group_id", "result_version", "entry_date");

-- CreateIndex
CREATE INDEX "ix_agent_backtest_equity_group_version_day" ON "agent_backtest_equity_points"("run_group_id", "result_version", "trade_date");

-- CreateIndex
CREATE UNIQUE INDEX "uix_agent_backtest_signal_owner_code_day_profile_version" ON "agent_backtest_signal_snapshots"("owner_user_id", "code", "trade_date", "signal_profile_hash", "snapshot_version");

-- CreateIndex
CREATE INDEX "ix_agent_backtest_signal_owner_code_day" ON "agent_backtest_signal_snapshots"("owner_user_id", "code", "trade_date");

-- AddForeignKey
ALTER TABLE "agent_backtest_run_groups" ADD CONSTRAINT "agent_backtest_run_groups_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_backtest_daily_steps" ADD CONSTRAINT "agent_backtest_daily_steps_run_group_id_fkey" FOREIGN KEY ("run_group_id") REFERENCES "agent_backtest_run_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_backtest_trades" ADD CONSTRAINT "agent_backtest_trades_run_group_id_fkey" FOREIGN KEY ("run_group_id") REFERENCES "agent_backtest_run_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_backtest_equity_points" ADD CONSTRAINT "agent_backtest_equity_points_run_group_id_fkey" FOREIGN KEY ("run_group_id") REFERENCES "agent_backtest_run_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_backtest_signal_snapshots" ADD CONSTRAINT "agent_backtest_signal_snapshots_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
