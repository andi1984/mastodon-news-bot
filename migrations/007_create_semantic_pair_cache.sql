-- Migration 007: Create semantic_pair_cache table
--
-- Persistent cache for Claude-computed semantic similarity scores between
-- pairs of titles. Used as fallback when Jaccard token similarity lands in
-- the uncertain zone in storyMatcher.findMatchingStory. pair_hash is an
-- order-independent key (pairKey(a,b) === pairKey(b,a)) so the same pair
-- looked up either way hits the same row.
--
-- aiCache.ts degrades silently when this table is missing — pure cost
-- optimization, not a hard dependency.

CREATE TABLE IF NOT EXISTS semantic_pair_cache (
    pair_hash TEXT PRIMARY KEY,
    score REAL NOT NULL,
    cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Future cleanup-by-age scans.
CREATE INDEX IF NOT EXISTS idx_semantic_pair_cache_cached_at
    ON semantic_pair_cache(cached_at);

COMMENT ON TABLE semantic_pair_cache IS 'Cache of Claude semantic similarity scores between title pairs. Reduces AI spend when the same uncertain match is rechecked.';
COMMENT ON COLUMN semantic_pair_cache.pair_hash IS 'Order-independent: pairKey(titleA, titleB) === pairKey(titleB, titleA). See aiCache.ts.';
