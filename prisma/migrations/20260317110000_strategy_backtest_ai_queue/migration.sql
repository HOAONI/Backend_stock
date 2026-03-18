ALTER TABLE "strategy_backtest_run_groups"
ADD COLUMN "ai_interpretation_status" VARCHAR(16) NOT NULL DEFAULT 'pending',
ADD COLUMN "ai_interpretation_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "ai_interpretation_requested_at" TIMESTAMP(3),
ADD COLUMN "ai_interpretation_started_at" TIMESTAMP(3),
ADD COLUMN "ai_interpretation_completed_at" TIMESTAMP(3),
ADD COLUMN "ai_interpretation_next_retry_at" TIMESTAMP(3),
ADD COLUMN "ai_interpretation_error_message" TEXT;

UPDATE "strategy_backtest_run_groups"
SET "ai_interpretation_requested_at" = COALESCE("ai_interpretation_requested_at", "created_at");

UPDATE "strategy_backtest_run_groups" AS g
SET
  "ai_interpretation_status" = 'completed',
  "ai_interpretation_requested_at" = COALESCE(g."ai_interpretation_requested_at", g."created_at"),
  "ai_interpretation_completed_at" = COALESCE(g."ai_interpretation_completed_at", g."created_at"),
  "ai_interpretation_next_retry_at" = NULL,
  "ai_interpretation_error_message" = NULL
WHERE EXISTS (
  SELECT 1
  FROM "strategy_backtest_runs" AS r
  WHERE r."run_group_id" = g."id"
)
AND NOT EXISTS (
  SELECT 1
  FROM "strategy_backtest_runs" AS r
  WHERE r."run_group_id" = g."id"
    AND COALESCE(r."metrics_json"->'ai_interpretation'->>'status', '') NOT IN ('ready', 'failed', 'unavailable')
);

CREATE INDEX "ix_strategy_backtest_group_ai_status_retry_created"
ON "strategy_backtest_run_groups"("ai_interpretation_status", "ai_interpretation_next_retry_at", "created_at");
