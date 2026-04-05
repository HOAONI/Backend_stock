ALTER TABLE "admin_user_profiles"
ADD COLUMN "strategy_risk_profile" VARCHAR(32) NOT NULL DEFAULT 'balanced',
ADD COLUMN "strategy_analysis_strategy" VARCHAR(32) NOT NULL DEFAULT 'auto',
ADD COLUMN "strategy_max_single_trade_amount" DOUBLE PRECISION;
