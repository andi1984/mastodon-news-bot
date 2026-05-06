# Database Migrations

SQL migrations for the Supabase Postgres database backing this bot. Apply them
manually in the Supabase SQL Editor (no migration runner is bundled).

## Apply order

Run in numeric order on a fresh database:

| #   | File                                  | Purpose                                                        |
| --- | ------------------------------------- | -------------------------------------------------------------- |
| 001 | `create_tooted_hashes.sql`            | Dedup-key store for already-posted articles.                   |
| 002 | `create_bot_state.sql`                | Cooldowns, pinned-toot tracking, last-toot timestamps.         |
| 003 | `create_stories.sql`                  | Story records (groups of related articles → Mastodon threads). |
| 004 | `create_news.sql`                     | Article queue (with German full-text search column).           |
| 005 | `create_ai_usage.sql`                 | Claude API cost log for daily-budget enforcement.              |
| 006 | `create_regional_cache.sql`           | Cached regional-relevance classifications.                     |
| 007 | `create_semantic_pair_cache.sql`      | Cached semantic-similarity scores between title pairs.         |
| 008 | `add_canonical_url.sql`               | Adds `canonical_url` to `news` + `tooted_hashes` for URL-based dedup. |
| 009 | `add_stories_original_links.sql`      | Adds `stories.original_links` for thread-reply dedup.          |

All statements use `IF NOT EXISTS` (or guarded `DO` blocks for constraints), so
re-applying a migration on an already-applied database is a safe no-op.

## Notes

- The default article table is `news`; if you set `db_table` to something else
  in `src/data/settings.json`, replace `news` accordingly when you apply
  migration 004 (and any later migration that references it).
- `regional_cache` and `semantic_pair_cache` are pure cost-saving caches —
  `aiCache.ts` degrades silently if those tables don't exist.
- The `get_today_ai_cost` RPC referenced by `costTracker.getTodaysCost` is
  optional; the helper falls back to a manual `SUM(cost_usd)` query when the
  RPC isn't installed.
