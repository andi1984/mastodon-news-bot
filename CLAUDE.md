# Mastodon News Bot - Project Notes

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

- `src/jobs/` - Bree cron jobs (run via worker threads)
- `src/scripts/` - Manual CLI scripts
- `src/helper/` - Shared utilities
- `src/data/settings.json` - Configuration (feeds, thresholds, hashtags)

## Key Patterns

### Story Architecture
- Articles from multiple feeds about the same topic are grouped into "stories"
- Stories become threads on Mastodon (main toot + replies)
- Matching uses Jaccard token similarity (threshold: 0.35) with AI fallback for uncertain cases

### Rate Limiting
- Mastodon API: ~300 requests per 5 minutes
- Use delays between API calls (2-6 seconds)
- On HTTP 429: wait 30 minutes before retrying

## Common Commands

```bash
npm run dev          # Run bot locally
npm run build        # Compile TypeScript
npm test             # Run tests
npm run fix-story-toots -- --dry-run  # Preview duplicate fixes
npm run story-thread-fixer            # Run thread fixer job manually
```
