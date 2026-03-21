ALTER TABLE "analysis_tasks"
  ADD COLUMN "schedule_id" VARCHAR(64);

CREATE TABLE "analysis_schedules" (
  "id" SERIAL NOT NULL,
  "schedule_id" VARCHAR(64) NOT NULL,
  "owner_user_id" INTEGER NOT NULL,
  "stock_code" VARCHAR(16) NOT NULL,
  "report_type" VARCHAR(16) NOT NULL DEFAULT 'detailed',
  "requested_execution_mode" VARCHAR(16) NOT NULL DEFAULT 'auto',
  "interval_minutes" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "next_run_at" TIMESTAMP(3) NOT NULL,
  "last_triggered_at" TIMESTAMP(3),
  "last_task_id" VARCHAR(64),
  "last_task_status" VARCHAR(16),
  "last_task_message" VARCHAR(500),
  "last_completed_at" TIMESTAMP(3),
  "last_skipped_at" TIMESTAMP(3),
  "last_skipped_reason" VARCHAR(200),
  "paused_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "analysis_schedules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "analysis_schedules_schedule_id_key"
ON "analysis_schedules"("schedule_id");

CREATE UNIQUE INDEX "uix_analysis_schedules_owner_stock_interval_mode"
ON "analysis_schedules"("owner_user_id", "stock_code", "interval_minutes", "requested_execution_mode");

CREATE INDEX "ix_analysis_schedules_owner_enabled_next_run"
ON "analysis_schedules"("owner_user_id", "enabled", "next_run_at");

CREATE INDEX "ix_analysis_schedules_enabled_next_run"
ON "analysis_schedules"("enabled", "next_run_at");

CREATE INDEX "ix_analysis_tasks_schedule_created"
ON "analysis_tasks"("schedule_id", "created_at");

ALTER TABLE "analysis_schedules"
  ADD CONSTRAINT "analysis_schedules_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "analysis_tasks"
  ADD CONSTRAINT "analysis_tasks_schedule_id_fkey"
  FOREIGN KEY ("schedule_id") REFERENCES "analysis_schedules"("schedule_id") ON DELETE SET NULL ON UPDATE CASCADE;
