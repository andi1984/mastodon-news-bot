-- Migration: Create tooted_hashes table
-- This table stores hashes of articles that have been tooted, preventing re-tooting
-- when RSS feeds still contain items that were already posted and deleted.

CREATE TABLE IF NOT EXISTS tooted_hashes (
    hash TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for cleanup queries (delete old hashes)
CREATE INDEX IF NOT EXISTS idx_tooted_hashes_created_at ON tooted_hashes(created_at);

-- Comment for documentation
COMMENT ON TABLE tooted_hashes IS 'Stores hashes of tooted articles to prevent re-tooting after deletion. Cleaned up after 7 days.';
