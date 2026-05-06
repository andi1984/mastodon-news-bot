-- Migration 005: Create ai_usage table for Claude cost tracking
--
-- Used by costTracker.ts. logAiUsage inserts one row per Claude call with
-- input/output token counts and computed USD cost. hasAiBudgetForSource
-- queries today's total to enforce the daily spend limit
-- (DEFAULT_DAILY_LIMIT_USD or AI_DAILY_COST_LIMIT_USD env override).
--
-- date_bucket carries a DEFAULT so logAiUsage doesn't need to set it
-- explicitly (the insert payload only sets source + token counts + cost).
--
-- Optional companion: a SQL function get_today_ai_cost() can be added
-- separately as a faster path; costTracker falls back to a manual SUM
-- query if the RPC isn't available, so it's not required.

CREATE TABLE IF NOT EXISTS ai_usage (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    date_bucket DATE NOT NULL DEFAULT CURRENT_DATE,
    source TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0
);

-- Hot path: "what did we spend today?"
CREATE INDEX IF NOT EXISTS idx_ai_usage_date_bucket ON ai_usage(date_bucket);
-- Retention cleanup scans by created_at < cutoff.
CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON ai_usage(created_at);
-- Per-source breakdowns for diagnostics.
CREATE INDEX IF NOT EXISTS idx_ai_usage_source ON ai_usage(source);

COMMENT ON TABLE ai_usage IS 'Per-call Claude API cost log. Cleaned up after ai_usage_retention_days (settings.json, default 14).';
COMMENT ON COLUMN ai_usage.source IS 'AI feature that made the call (semantic_similarity, regional_relevance, hashtag_generation, poll_analysis, question_answerer).';
