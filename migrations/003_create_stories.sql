-- Migration 003: Create stories table
--
-- A "story" groups related articles from multiple feeds about the same
-- topic. The first article posted becomes the Mastodon thread root; later
-- articles for the same story_id become quote-thread replies. Matching
-- happens in storyMatcher.ts (Jaccard tokens + Claude semantic fallback).
--
-- Columns added by later migrations:
--   009 → original_links TEXT[] (links of articles in the root toot)

CREATE TABLE IF NOT EXISTS stories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    article_count INTEGER NOT NULL DEFAULT 1,
    tooted BOOLEAN NOT NULL DEFAULT FALSE,
    toot_id TEXT,
    primary_title TEXT NOT NULL,
    tokens TEXT[] NOT NULL DEFAULT '{}'::TEXT[]
);

-- Recency-sorted scans for findMatchingStory's 72h window.
CREATE INDEX IF NOT EXISTS idx_stories_updated_at ON stories(updated_at DESC);
-- Fast filter for "untooted only" scans in feed-tooter.
CREATE INDEX IF NOT EXISTS idx_stories_tooted ON stories(tooted);

COMMENT ON TABLE stories IS 'Groups of related articles. Becomes a Mastodon thread root + replies. Matching via Jaccard tokens with semantic AI fallback.';
COMMENT ON COLUMN stories.tokens IS 'Frozen token set from the first article. Intentionally NOT merged on subsequent matches to prevent topic drift.';
COMMENT ON COLUMN stories.toot_id IS 'Mastodon status ID of the root toot. Set by markStoryTooted at first post; used by quote-thread replies for follow-ups.';
