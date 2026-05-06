-- Migration 006: Create regional_cache table
--
-- Persistent cache for regional relevance classifications (local / regional
-- / national / international) so re-classifying the same article title
-- across runs doesn't keep hitting Claude. Lookup by title_hash =
-- sha256(normalized_title); upsert path uses ON CONFLICT (title_hash).
--
-- aiCache.ts degrades silently when this table is missing, so the cache is
-- a pure cost optimization — the bot still works without it.

CREATE TABLE IF NOT EXISTS regional_cache (
    title_hash TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Future cleanup-by-age scans (none today, but cheap to have).
CREATE INDEX IF NOT EXISTS idx_regional_cache_cached_at
    ON regional_cache(cached_at);

COMMENT ON TABLE regional_cache IS 'Cache of Claude-classified regional categories per article title. Reduces AI spend on re-runs.';
COMMENT ON COLUMN regional_cache.category IS 'One of: local, regional, national, international. Type intentionally TEXT (not enum) so adding a category is a settings change, not a schema migration.';
