CREATE TYPE "AnalysisRecordSource" AS ENUM ('analysis_center', 'agent_chat');

ALTER TABLE "analysis_history"
ADD COLUMN "record_source" "AnalysisRecordSource" NOT NULL DEFAULT 'analysis_center';
