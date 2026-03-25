# Mastodon News Bot

A sophisticated, AI-enhanced news aggregation bot for Mastodon that automatically collects, clusters, and posts news from multiple RSS feeds.

**Live Example:** [@saarlandnews](https://mastodon.social/@saarlandnews) - Regional news bot for Saarland, Germany

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
git clone https://github.com/your-username/mastodon-news-bot.git
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

```json
{
  "username": "yournewsbot",
  "db_table": "news",
  "feeds": {
    "source-name": "https://example.com/feed.rss",
    "another-source": "https://news.example.org/rss"
  },
  "feed_hashtags": ["news", "localnews"],
  "feed_priorities": {
    "source-name": 0.3,
    "another-source": 0.7
  }
}
```

Lower priority values = higher priority (posted first).

3. **Set up Supabase tables:**

You'll need these tables:
- `news` - Stores fetched articles
- `stories` - Groups related articles
- `tooted_hashes` - Prevents duplicates
- `bot_state` - Tracks cooldowns, last toot time
- `ai_usage` - Tracks AI API costs

### Running

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start
```

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
git clone https://github.com/your-username/mastodon-news-bot.git
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

## License

MIT

## Author

Andreas Sander ([@andi1984](https://mastodon.social/@andi1984))

---

Built with TypeScript, Claude AI, and the fediverse spirit.
