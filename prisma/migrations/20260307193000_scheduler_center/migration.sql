ALTER TYPE "AnalysisTaskStatus" ADD VALUE IF NOT EXISTS 'cancelled';

ALTER TABLE "analysis_tasks"
  ADD COLUMN "root_task_id" VARCHAR(64),
  ADD COLUMN "retry_of_task_id" VARCHAR(64),
  ADD COLUMN "attempt_no" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "run_after" TIMESTAMP(3),
  ADD COLUMN "cancelled_at" TIMESTAMP(3);

UPDATE "analysis_tasks"
SET "root_task_id" = "task_id"
WHERE "root_task_id" IS NULL;

CREATE INDEX "ix_analysis_tasks_status_priority_created"
ON "analysis_tasks"("status", "priority", "created_at");

CREATE INDEX "ix_analysis_tasks_run_after_status"
ON "analysis_tasks"("run_after", "status");

CREATE INDEX "ix_analysis_tasks_root_attempt"
ON "analysis_tasks"("root_task_id", "attempt_no");

CREATE TABLE "scheduler_worker_heartbeats" (
  "id" SERIAL NOT NULL,
  "worker_name" VARCHAR(64) NOT NULL,
  "worker_mode" VARCHAR(16) NOT NULL,
  "last_seen_at" TIMESTAMP(3) NOT NULL,
  "last_task_id" VARCHAR(64),
  "last_error" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "scheduler_worker_heartbeats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "scheduler_worker_heartbeats_worker_name_key"
ON "scheduler_worker_heartbeats"("worker_name");
