CREATE TABLE "user_backtest_strategies" (
    "id" SERIAL NOT NULL,
    "owner_user_id" INTEGER NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(255),
    "template_code" VARCHAR(32) NOT NULL,
    "params_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_backtest_strategies_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "strategy_backtest_runs"
    ADD COLUMN "saved_strategy_id" INTEGER,
    ADD COLUMN "saved_strategy_name" VARCHAR(64);

CREATE UNIQUE INDEX "uix_user_backtest_strategies_owner_name"
ON "user_backtest_strategies"("owner_user_id", "name");

CREATE INDEX "ix_user_backtest_strategies_owner_updated"
ON "user_backtest_strategies"("owner_user_id", "updated_at");

CREATE INDEX "ix_user_backtest_strategies_owner_template"
ON "user_backtest_strategies"("owner_user_id", "template_code");

CREATE INDEX "ix_strategy_backtest_run_saved_strategy"
ON "strategy_backtest_runs"("saved_strategy_id");

ALTER TABLE "user_backtest_strategies"
ADD CONSTRAINT "user_backtest_strategies_owner_user_id_fkey"
FOREIGN KEY ("owner_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "strategy_backtest_runs"
ADD CONSTRAINT "strategy_backtest_runs_saved_strategy_id_fkey"
FOREIGN KEY ("saved_strategy_id") REFERENCES "user_backtest_strategies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
