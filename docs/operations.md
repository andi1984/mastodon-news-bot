# Operations

Deployment and runtime notes for the Mastodon News Bot.

## Running in production

```bash
npm run build   # tsc + copy settings.json to dist/data/
npm start       # writes .env via scripts/create-env.cjs, then node ./dist/index.js
```

The bot is a single long-running Node process. Bree schedules every job as a
short-lived **worker thread** inside that process (see `src/index.ts`), so all
job memory and CPU show up under one PID.

## Node version: why ≥24

The bot spawns roughly 400 worker threads per day (feed-grabber ~80,
feed-tooter 72, mention-replier 144, alive 48, cleanup-duplicates ~46, the
rest ~10). Each worker loads the full dependency graph (supabase, masto,
rss-parser, Anthropic SDK), runs once, and exits.

Measured behavior (June 2026, synthetic churn test — workers importing the
real dependency graph, terminated on `"done"`, parent RSS sampled):

| Node    | Leaked RSS per worker | Pattern                |
| ------- | --------------------- | ---------------------- |
| 20.9    | ~40 KB                | linear, never plateaus |
| 22.9    | ~17 KB                | slow drift             |
| 24.16   | ~0                    | flat after warm-up     |

Notes from the investigation:

- The parent's JS heap stays flat in all cases — the growth is **native
  memory inside the main process**, left behind per spawned worker by older
  Node versions. App code was audited and is clean (all jobs signal `"done"`,
  Bree 9.2.9 clears its timers and worker maps).
- `MALLOC_ARENA_MAX=2` does **not** help, so it is not glibc arena
  fragmentation — upgrading Node is the fix, not malloc tuning.
- Independently, `@supabase/supabase-js` ≥2.106 throws inside
  `createClient()` without native `WebSocket` (Node ≥22), so Node 20 cannot
  run the bot at all anymore.

On Node 20 the leak amounted to roughly 16 MB/day — the "RAM grows linearly
every day" symptom.

### Re-verifying after a Node upgrade

Watch the process RSS for a day or two (e.g. `ps -o rss= -p <pid>` in a cron,
or your process manager's metrics). Expect a warm-up climb for the first few
hours, then flat. If it still climbs linearly, re-run a churn test: spawn a
few hundred workers that import the dependency graph and sample
`process.memoryUsage().rss` in the parent every ~50 runs.

## Memory guardrails already in place

- `closeWorkerAfterMs: 300_000` — any worker still alive after 5 min is
  terminated (zombie protection).
- Per-worker V8 heap caps: `maxOldGenerationSizeMb: 512`,
  `maxYoungGenerationSizeMb: 128`.
- Keep worker churn in mind when adding jobs: a new 5-minute job adds ~288
  worker spawns/day. Prefer widening an existing job's scope over adding a
  high-frequency job.

## Recommended safety net

Run under a supervisor with a memory ceiling and auto-restart, e.g. systemd:

```ini
[Service]
ExecStart=/usr/bin/npm start
Restart=always
MemoryMax=1G
```

or pm2: `pm2 start npm --name news-bot -- start --max-memory-restart 800M`.

## External rate limits

- Mastodon API: ~300 requests / 5 min per account. Jobs sleep 2–6 s between
  calls; on HTTP 429 back off 30 min.
- Claude spend is budget-capped per day via the `ai_usage` table
  (`src/helper/costTracker.ts`); low-priority features (polls) shed first.
