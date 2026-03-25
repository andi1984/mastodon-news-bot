# Mastodon News Bot

A sophisticated, AI-enhanced news aggregation bot for Mastodon that automatically collects, clusters, and posts news from multiple RSS feeds.

**Live Example:** [@saarlandnews@dibbelabb.es](https://dibbelabb.es/@saarlandnews) - Regional news bot for Saarland, Germany

## Features

### Core Functionality

- **Multi-source RSS Aggregation** - Pulls news from 15+ configurable RSS feeds
- **Story Clustering** - Automatically groups related articles from different sources into unified "stories"
- **Thread Management** - Posts follow-up articles as quote replies to the original story
- **Breaking News Detection** - Identifies breaking news (multiple sources covering the same topic quickly), auto-pins, and sets cooldowns
- **Regional Relevance Scoring** - Prioritizes local news over national/international content
- **Adaptive Posting** - Smart rate limiting with configurable intervals and batch sizes

### AI-Powered Features (Claude API)

- **Semantic Story Matching** - Uses AI to catch story matches that token-based similarity misses
- **Poll Generation** - Automatically suggests polls for debatable topics (e.g., local political decisions)
- **Smart Hashtag Generation** - Content-derived hashtags beyond static feed tags
- **Interactive Q&A** - Responds to mentions with relevant news searches

### Content Management

- **Daily & Weekly Digests** - Automated summaries of top stories
- **Content Warnings** - Auto-applies CW for sensitive topics (accidents, violence, etc.)
- **Duplicate Prevention** - Hash-based tracking prevents re-posting
- **Automatic Cleanup** - Old articles and stories are purged to prevent DB bloat

## Architecture

```
src/
├── index.ts              # Main entry, Bree job scheduler
├── jobs/                 # Scheduled jobs (cron/interval)
│   ├── feed-grabber.ts   # Fetches RSS feeds, stores to DB
│   ├── feed-tooter.ts    # Posts stories to Mastodon
│   ├── daily-digest.ts   # Daily summary post
│   ├── weekly-digest.ts  # Weekly summary post
│   ├── mention-replier.ts # Q&A via mentions
│   ├── cleanup.ts        # Database cleanup
│   └── story-thread-fixer.ts # Repairs orphaned threads
├── helper/               # Shared utilities
│   ├── storyMatcher.ts   # Story clustering logic
│   ├── similarity.ts     # Jaccard + semantic matching
│   ├── hashtagGenerator.ts # AI hashtag suggestions
│   ├── engagementEnhancer.ts # Poll analysis
│   ├── regionalRelevance.ts # Local news scoring
│   ├── db.ts             # Supabase client
│   └── login.ts          # Mastodon authentication
├── scripts/              # Manual maintenance scripts
└── data/
    └── settings.json     # All configuration
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20+ (ESM) |
| Language | TypeScript |
| Job Scheduler | [Bree](https://github.com/breejs/bree) |
| Database | [Supabase](https://supabase.com) (PostgreSQL) |
| Mastodon Client | [masto.js](https://github.com/neet/masto.js) |
| AI | Claude API (Haiku for cost efficiency) |
| RSS Parsing | [rss-parser](https://github.com/rbren/rss-parser) |

## Getting Started

### Prerequisites

- Node.js 20.6.0+
- A Mastodon account with API access
- Supabase project (free tier works)
- Claude API key (optional, for AI features)

### Installation

```bash
git clone https://github.com/andi1984/mastodon-news-bot.git
cd mastodon-news-bot
npm install
```

### Configuration

1. **Create `.env` file:**

```env
API_INSTANCE=https://mastodon.social
ACCESS_TOKEN=your_mastodon_access_token
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_supabase_anon_key
CLAUDE_API_KEY=your_claude_api_key  # Optional
```

2. **Configure feeds in `src/data/settings.json`:**

```bash
cp src/data/settings.example.json src/data/settings.json
```

Edit with your feeds and preferences. See [Configuration Reference](#configuration-reference) for all options. Lower priority values = higher priority (posted first).

3. **Set up Supabase tables** - See [Database Setup](#database-setup) below.

### Running

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start
```

## Database Setup

The bot uses Supabase (PostgreSQL) for persistence. Create a free project at [supabase.com](https://supabase.com) and run these migrations in the SQL Editor.

### Tables Overview

| Table | Purpose |
|-------|---------|
| `news` | Stores fetched RSS articles pending posting |
| `stories` | Groups related articles from different sources |
| `tooted_hashes` | Tracks posted article hashes to prevent duplicates |
| `bot_state` | Key-value store for cooldowns, pin tracking, rate limiting |
| `ai_usage` | Tracks Claude API costs for budget management |

### Migration: Core Tables

Run these in order (stories must exist before news due to foreign key):

```sql
-- 1. Stories table (groups related articles)
CREATE TABLE public.stories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  article_count integer DEFAULT 1,
  tooted boolean DEFAULT false,
  toot_id text,
  primary_title text NOT NULL,
  tokens text[] DEFAULT '{}'::text[],
  original_links text[] DEFAULT '{}'::text[],
  CONSTRAINT stories_pkey PRIMARY KEY (id)
);

-- 2. News articles table
CREATE TABLE public.news (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  uuid uuid DEFAULT uuid_generate_v4(),
  created_at timestamp with time zone DEFAULT now(),
  tooted boolean DEFAULT false,
  data jsonb,
  hash text UNIQUE,
  pub_date timestamp without time zone,
  story_id uuid,
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('german'::regconfig,
      coalesce((data ->> 'title'::text), ''::text) || ' ' ||
      coalesce((data ->> 'content'::text), ''::text)
    )
  ) STORED,
  CONSTRAINT news_pkey PRIMARY KEY (id),
  CONSTRAINT news_story_id_fkey FOREIGN KEY (story_id) REFERENCES public.stories(id)
);

-- Index for full-text search
CREATE INDEX idx_news_fts ON news USING gin(fts);

-- 3. Tooted hashes (duplicate prevention)
CREATE TABLE public.tooted_hashes (
  hash text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT tooted_hashes_pkey PRIMARY KEY (hash)
);

-- 4. Bot state (key-value store)
CREATE TABLE public.bot_state (
  key text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT bot_state_pkey PRIMARY KEY (key)
);

-- 5. AI usage tracking
CREATE TABLE public.ai_usage (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  date_bucket date DEFAULT CURRENT_DATE,
  source text NOT NULL,
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  cost_usd numeric NOT NULL,
  CONSTRAINT ai_usage_pkey PRIMARY KEY (id)
);
```

> **Note:** The `fts` column enables PostgreSQL full-text search in German. This powers the Q&A mention feature.

### Migration: Helper Function

```sql
-- Function to get today's AI cost (used by budget checker)
CREATE OR REPLACE FUNCTION get_today_ai_cost()
RETURNS DECIMAL AS $$
  SELECT COALESCE(SUM(cost_usd), 0)
  FROM ai_usage
  WHERE date_bucket = CURRENT_DATE;
$$ LANGUAGE SQL STABLE;
```

### Migration: Row Level Security (Optional)

If using RLS, enable it for all tables:

```sql
-- Enable RLS
ALTER TABLE news ENABLE ROW LEVEL SECURITY;
ALTER TABLE stories ENABLE ROW LEVEL SECURITY;
ALTER TABLE tooted_hashes ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (for the bot)
CREATE POLICY "Service role full access" ON news
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON stories
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON tooted_hashes
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON bot_state
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON ai_usage
  FOR ALL USING (auth.role() = 'service_role');
```

> **Note:** If using RLS, use the `service_role` key (not the `anon` key) in your `.env` file for `SUPABASE_KEY`.

### Schema Reference

#### `news` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGINT | Primary key (auto-increment) |
| `uuid` | UUID | Secondary unique identifier |
| `hash` | TEXT | Unique hash of feed URL + title + link |
| `data` | JSONB | Full RSS item data including `_feedKey` |
| `pub_date` | TIMESTAMP | Article publication date |
| `tooted` | BOOLEAN | Whether article has been posted |
| `story_id` | UUID | Foreign key to `stories` table |
| `fts` | TSVECTOR | Full-text search index (German) |
| `created_at` | TIMESTAMPTZ | When article was fetched |

#### `stories` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `primary_title` | TEXT | Title of the main article |
| `tokens` | TEXT[] | Tokenized words for similarity matching |
| `article_count` | INTEGER | Number of articles in this story |
| `tooted` | BOOLEAN | Whether story has been posted |
| `toot_id` | TEXT | Mastodon status ID (for threading) |
| `original_links` | TEXT[] | Links already posted (prevents duplicates in threads) |
| `created_at` | TIMESTAMPTZ | When story was created |
| `updated_at` | TIMESTAMPTZ | Last update (new article added) |

#### `bot_state` Table

| Column | Type | Description |
|--------|------|-------------|
| `key` | TEXT | Primary key (state identifier) |
| `value` | JSONB | State data |
| `created_at` | TIMESTAMPTZ | When state was created |
| `updated_at` | TIMESTAMPTZ | Last update |

**Common keys:**

| Key | Value Structure | Purpose |
|-----|-----------------|---------|
| `cooldown_until` | `{timestamp, reason, toot_id?}` | Post-breaking-news cooldown |
| `last_toot_at` | `{timestamp}` | Rate limiting between posts |
| `pinned_toot_<id>` | `{toot_id, pinned_at}` | Track pinned toots for auto-unpin |

#### `ai_usage` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGINT | Primary key (auto-increment) |
| `source` | TEXT | Feature using AI (`poll_analysis`, `semantic_similarity`, `hashtag_generation`) |
| `input_tokens` | INTEGER | Tokens sent to Claude |
| `output_tokens` | INTEGER | Tokens received from Claude |
| `cost_usd` | NUMERIC | Calculated cost in USD |
| `date_bucket` | DATE | Date for daily aggregation |
| `created_at` | TIMESTAMPTZ | Timestamp of API call |

### Verifying Setup

After running migrations, verify with:

```sql
-- Check all tables exist
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('news', 'stories', 'tooted_hashes', 'bot_state', 'ai_usage');

-- Test the function
SELECT get_today_ai_cost();
```

The bot also performs a health check on startup - check logs for "Supabase connection: OK".

## Configuration Reference

### Key Settings (`settings.json`)

| Setting | Description | Default |
|---------|-------------|---------|
| `min_freshness_hours` | Max age of articles to post | 24 |
| `story_similarity_threshold` | Jaccard score to match stories | 0.35 |
| `breaking_news_min_sources` | Sources needed for breaking news | 2 |
| `poll_enabled` | Enable AI poll suggestions | true |
| `poll_chance` | Probability of adding polls | 0.15 |
| `qa_enabled` | Enable mention Q&A | true |

### Adaptive Tooting

```json
"adaptive_tooting": {
  "normal_batch_size": 2,       // Max stories per normal run
  "breaking_batch_size": 3,     // Max stories for breaking news
  "min_minutes_between_toots": 30,
  "cooldown_hours": 1,          // Pause after breaking news
  "pin_duration_hours": 48
}
```

### Regional Relevance

Prioritize local news with multipliers:

```json
"regional_relevance": {
  "enabled": true,
  "always_local_feeds": ["local-paper", "police"],
  "multipliers": {
    "local": 1.5,
    "regional": 1.2,
    "national": 1.0,
    "international": 0.6
  }
}
```

## Scripts

```bash
npm run dev              # Development with tsx
npm run build            # Compile TypeScript
npm test                 # Run Jest tests
npm run typecheck        # Type checking only

# Manual jobs
npm run daily-digest     # Post daily summary
npm run weekly-digest    # Post weekly summary
npm run manage-feeds     # Add/remove RSS feeds
npm run cleanup-duplicates  # Manual duplicate cleanup
```

## How It Works

### Story Lifecycle

1. **Grabbing** - `feed-grabber` fetches RSS feeds every 15-30 minutes
2. **Matching** - Articles are matched to existing stories using:
   - Jaccard token similarity (fast, free)
   - AI semantic matching (for uncertain cases)
3. **Scoring** - Stories are scored by:
   - Feed priority
   - Article freshness
   - Regional relevance
   - Number of sources
4. **Posting** - `feed-tooter` posts top stories, respecting rate limits
5. **Threading** - Follow-up articles become quote replies
6. **Cleanup** - Old data is automatically purged

### AI Budget Management

AI features use Claude Haiku for cost efficiency. The bot tracks daily usage and disables AI features when the budget is exceeded:

```typescript
// From costTracker.ts
const DAILY_BUDGET_USD = 0.50;  // Configurable
```

## Contributing

Contributions are welcome! This bot is designed to be adaptable for any regional news aggregation use case.

### Development Setup

```bash
git clone https://github.com/andi1984/mastodon-news-bot.git
cd mastodon-news-bot
npm install
cp .env.example .env  # Edit with your credentials
npm run dev
```

### Code Style

- TypeScript strict mode
- ESM modules
- Prettier for formatting

### Testing

```bash
npm test                    # Run all tests
npm test -- --watch         # Watch mode
npm test -- similarity      # Run specific test file
```

## Customization Ideas

- **Different regions** - Change feeds and location keywords in settings
- **Different topics** - Use topic-focused RSS feeds (sports, tech, etc.)
- **Different languages** - Adjust stopwords in `similarity.ts`, prompts in AI helpers
- **Webhook integration** - Add Discord/Slack notifications for breaking news

## Author

Andreas Sander ([@andi1984@dibbelabb.es](https://dibbelabb.es/@andi1984))

---

Built with TypeScript, Claude AI, and the fediverse spirit.
