-- Migration: Add canonical_url for URL-based deduplication
--
-- The existing `hash` column hashes feedURL+title+link character-for-character.
-- When the same article comes from two feeds (different feedKey, slightly
-- different titles, or tracking params on the link) it produces two distinct
-- hashes and slips past dedup. canonical_url is a normalized form
-- (lowercased host, no www., no query, no fragment, no trailing slash) that
-- collapses these variants to a single key, enabling true URL-level dedup.
--
-- Pre-claim flow: feed-tooter inserts (hash, canonical_url) into
-- tooted_hashes BEFORE calling the Mastodon API, using ON CONFLICT on
-- canonical_url to detect "already claimed by parallel run / earlier story
-- in the same batch". On API failure, the row is deleted (release).
--
-- Backward compat: existing rows have NULL canonical_url. Multiple NULLs
-- coexist under PG's default UNIQUE-with-NULLs semantics. New writes always
-- populate canonical_url when a valid URL is available.

ALTER TABLE tooted_hashes
  ADD COLUMN IF NOT EXISTS canonical_url TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tooted_hashes_canonical_url_key'
  ) THEN
    ALTER TABLE tooted_hashes
      ADD CONSTRAINT tooted_hashes_canonical_url_key UNIQUE (canonical_url);
  END IF;
END $$;

ALTER TABLE news
  ADD COLUMN IF NOT EXISTS canonical_url TEXT;

CREATE INDEX IF NOT EXISTS idx_news_canonical_url
  ON news (canonical_url);

COMMENT ON COLUMN tooted_hashes.canonical_url IS
  'Normalized URL key (no query/fragment, no www., lowercased host, no trailing slash). Used for pre-claim dedup before posting.';
COMMENT ON COLUMN news.canonical_url IS
  'Normalized URL key (see tooted_hashes.canonical_url). Set at ingestion; consulted in feed-grabber dedup pass.';
