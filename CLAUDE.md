# Mastodon News Bot - Project Notes

A regional news bot for Saarland, Germany. Aggregates RSS feeds, groups
related articles into "stories", and posts them as toots/threads on Mastodon.

## Tech Stack

- **Runtime:** Node.js ≥20.6, TypeScript (ESM), `tsx` for dev
- **Scheduler:** [Bree](https://github.com/breejs/bree) — runs jobs in worker threads
- **Mastodon client:** [`masto`](https://www.npmjs.com/package/masto)
- **Database:** Supabase (Postgres) via `@supabase/supabase-js`
- **AI:** `@anthropic-ai/sdk` (Claude) for semantic matching, polls, Q&A
- **Feeds:** `rss-parser`
- **Tests:** Jest with ESM (`--experimental-vm-modules`)

## Environment Variables

**IMPORTANT:** All standalone scripts and jobs must import dotenv at the top:
```typescript
import "dotenv/config";
```

This loads environment variables from `.env` file:
- `API_INSTANCE` - Mastodon instance URL
- `ACCESS_TOKEN` - Mastodon API token
- `SUPABASE_URL` - Database URL
- `SUPABASE_KEY` - Database key
- `CLAUDE_API_KEY` - For AI features (semantic matching, polls, etc.)

## Project Structure

- `src/index.ts` - Bree entry point; defines all cron schedules
- `src/jobs/` - Bree cron jobs (run via worker threads)
- `src/scripts/` - Manual CLI scripts (e.g. `fix-duplicate-toots.ts`)
- `src/helper/` - Shared utilities (each `.ts` has a co-located `.test.ts`)
- `src/data/settings.json` - Runtime configuration (feeds, thresholds, hashtags, CW mapping)
- `src/data/settings.example.json` - Template for new contributors
- `src/types/settings.ts` - TypeScript types for settings.json
- `scripts/` (root) - One-off maintenance scripts and the `create-env.cjs` helper used by `npm start`
- `migrations/` - SQL migrations applied manually to Supabase

Note the two `scripts/` directories: prefer `src/scripts/` for anything that
should ship with the bot; root `scripts/` is for ad-hoc cleanup.

## Database Tables

- `tooted_hashes` — hash → timestamp; prevents re-posting articles whose RSS items reappear after deletion. Retention via `tooted_hash_retention_days` in settings.
- `bot_state` — key/JSONB store for cooldowns, pinned toots, last-toot timestamps (used by the adaptive tooter).
- `news` (configurable via `db_table` in settings) — main article/story store.

## Cron Schedule (defined in `src/index.ts`)

- `feed-grabber` — every 15 min daytime (06–21), every 30 min night
- `feed-tooter` — every 20 min, all day; decides itself whether to post (breaking vs. normal vs. cooldown)
- `cleanup` — every 6 h
- `cleanup-duplicates` — every 31 min
- `mention-replier` — every 5 min
- `story-thread-fixer` — 03:00 and 15:00 (fuzzy-matches existing toots into threads)
- `daily-digest` — 22:00; `weekly-digest` — Sunday 20:00
- `alive` — 30 min heartbeat

## Key Patterns

### Story Architecture
- Articles from multiple feeds about the same topic are grouped into "stories"
- Stories become threads on Mastodon (main toot + replies)
- Matching uses Jaccard token similarity with AI fallback for uncertain cases
- All thresholds live in `src/data/settings.json` (`similarity_threshold`, `story_similarity_threshold`, `semantic_similarity.*`) — do not hardcode them

### Adaptive Tooter
- Single `feed-tooter` job runs every 20 min and self-decides via `bot_state`:
  - Breaking news → posts immediately, pins, sets cooldown
  - Normal news → respects `min_minutes_between_toots`, batch limit `normal_batch_size`
  - Cooldown active → skips the run entirely
- Tunables under `adaptive_tooting` in settings.json

### Rate Limiting
- Mastodon API: ~300 requests per 5 minutes
- Use delays between API calls (2-6 seconds)
- On HTTP 429: wait 30 minutes before retrying

## Common Commands

```bash
npm run dev          # Run bot locally (tsx)
npm run build        # Compile TypeScript + copy settings.json to dist/
npm test             # Run Jest tests (ESM mode)
npm run test:coverage
npm run typecheck    # tsc --noEmit
npm run fix-story-toots -- --dry-run  # Preview duplicate fixes
npm run story-thread-fixer            # Run thread fixer job manually
npm run daily-digest                  # Run digest manually
npm run manage-feeds                  # Add/list/remove feeds in settings.json
```

## Conventions

- **Commits:** Conventional Commits enforced via commitlint + husky. Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Subject must not be Title-Case / UPPER-CASE / PascalCase.
- **Tests:** Co-locate `*.test.ts` next to the implementation in `src/helper/`. Jobs and scripts are excluded from coverage.
- **ESM imports:** Use `.js` extensions in relative imports even in `.ts` source (e.g. `import { foo } from "./bar.js"`); Jest is configured to remap them.
- **Settings over constants:** Anything tunable (thresholds, retention, batch sizes, hashtags, feeds, CW mapping) belongs in `settings.json`, not in code.

## Do's and Dont's

Here are things the bot should follow or avoid.

Do's:

- Make toots engaging for others to click on and interact with

Dont's:

- Never post toots about the same topic multiple times as a major toot. toot
differnt links about the same topic as threads under the first major toot. Never
too the same URL more than once. EVER! ONLY ONCE ALWAYS!
