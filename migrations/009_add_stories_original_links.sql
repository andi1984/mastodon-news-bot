-- Migration 004: Add original_links to stories
--
-- The column is referenced by code that shipped via PRs #9, #10, #12 but
-- was never added to the schema. Production logs show repeated
--   [findStoryByUrl] select failed: column stories.original_links does not exist
-- The same column is also required by:
--   - markStoryTooted (storyMatcher.ts) — update payload includes
--     original_links; without the column, the whole update fails atomically,
--     so stories NEVER flip to tooted=true. feed-tooter then re-tooots the
--     same story on every run, which is a major source of the duplicate
--     posts that motivated the URL-pre-claim fix.
--   - extendStoryOriginalLinks (storyLinks.ts) — appends new links after
--     each follow-up thread reply; fails silently without the column.
--   - feed-tooter follow-up loop — selects original_links to build the
--     thread-dedup exclusion set; whole select fails, threading goes silent.
--
-- DEFAULT '{}' fills existing rows with empty arrays (PG 11+ does this
-- without a full table rewrite), so legacy rows remain queryable.

ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS original_links TEXT[] DEFAULT '{}'::TEXT[];

COMMENT ON COLUMN stories.original_links IS
  'Normalized URLs of articles included in the root toot. Set at markStoryTooted (first post); appended via extendStoryOriginalLinks after each follow-up reply. Consulted by findStoryByUrl (URL-based story rematch) and the feed-tooter follow-up loop for thread dedup.';
