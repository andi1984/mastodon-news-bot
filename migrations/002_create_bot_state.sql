-- Bot state table for tracking cooldowns, pinned toots, and other adaptive behavior
CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_bot_state_updated_at ON bot_state(updated_at);

-- Example records that will be created at runtime:
-- key: 'last_toot_at' -> value: { "timestamp": "2024-01-01T12:00:00Z" }
-- key: 'cooldown_until' -> value: { "timestamp": "2024-01-01T13:00:00Z", "reason": "breaking_news", "toot_id": "123" }
-- key: 'pinned_toot_123' -> value: { "toot_id": "123", "pinned_at": "2024-01-01T12:00:00Z" }
