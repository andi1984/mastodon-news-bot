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
real dependency graph, terminated on `"done"`, parent RSS sampled; the
24.10.0 row was added July 2026):

| Node    | Leaked RSS per worker | Pattern                |
| ------- | --------------------- | ---------------------- |
| 20.9    | ~40 KB                | linear, never plateaus |
| 22.9    | ~17 KB                | slow drift             |
| 24.10   | ~0                    | flat after warm-up     |
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

### The leak class is gone on 24.10.0 — don't chase Node versions further

A July 2026 re-investigation churn-tested the exact production binary
(v24.10.0) with the real dependency graph and Bree's exact lifecycle,
including a force-kill variant (700 consecutive `terminate()`s of workers
holding sockets and timers): parent RSS flat in both, identical to 24.16.
A release-by-release review of v24.11.0–v24.16.0 found no worker_threads
memory fix in that window — whatever made 24.16 measure ~0 was already in
24.10.0. If the container still grows linearly on ≥24.10, the cause is not
the Node worker-churn leak; look at hung workers and in-worker workloads
(next section).

### Why `.nvmrc` pins exactly 24.15.0

v24.16.0 introduced a fetch memory-leak regression (nodejs/node#63708 /
#63574): buffers pinned in V8 eternal handles after `AbortSignal.timeout`
aborts. Measured August 2026 with the issue's repro shape (10 MB
FormData+Blob POST aborted by `AbortSignal.timeout`, 60 iterations,
`--expose-gc`):

| Node    | RSS growth                     |
| ------- | ------------------------------ |
| 24.15.0 | plateaus ~430 MB, recovers     |
| 24.16.0 | linear, ~10 MB/abort (= one full body retained per abort) |
| 24.17.0 | linear, ~10 MB/abort — **not fixed** |

The bot hits that exact shape: masto implements its `timeout` option via
`AbortSignal.timeout` on every request (`src/helper/login.ts`), and media
uploads are FormData+Blob POSTs. The leak is per-isolate, so worker exits
reclaim it — but a floating `.nvmrc` of `24` let deploys drift onto broken
point releases. Before moving the pin, re-run the FormData churn repro on
the target version and confirm the plateau. `getFeed.ts`/`fetchImage.ts`
avoid `AbortSignal.timeout` entirely (own `AbortController` with a
`TimeoutError` abort reason) as defense in depth.

### Re-verifying after a Node upgrade

Watch the process RSS for a day or two (e.g. `ps -o rss= -p <pid>` in a cron,
or your process manager's metrics). Expect a warm-up climb for the first few
hours, then flat. If it still climbs linearly, re-run a churn test: spawn a
few hundred workers that import the dependency graph and sample
`process.memoryUsage().rss` in the parent every ~50 runs.

## Hung workers: every await must stay below the 300s kill window

`closeWorkerAfterMs: 300_000` is a safety net, not an exit path. A worker
that never posts `"done"` sits for the full 5 minutes holding its complete
dependency-graph heap (supabase + masto + Anthropic SDK + rss-parser, easily
50–100 MB) plus live TLS sockets before being force-killed — and overlapping
hung workers are what raise the container's memory baseline. Measured August
2026: a single 3-worker overlap burst ratchets the parent RSS up by ~35 MB
and it only partially recovers over the following runs, so recurring overlap
events produce exactly the "linear growth over runtime" symptom without any
true leak. Every network await and retry budget in a job must therefore be
bounded **well below 300 s**. Current budgets:

| Dependency  | Bound                                        | Where                        |
| ----------- | -------------------------------------------- | ---------------------------- |
| Supabase    | 30 s/request **incl. body read**, 3 attempts | `src/helper/db.ts`           |
| Mastodon    | 30 s/request                                 | `src/helper/login.ts`        |
| Anthropic   | 60 s/request, 1 retry (30 s for semantic matching — it can run twice per article in feed-grabber's loop) | the five AI helpers |
| RSS feeds   | 15 s/fetch incl. body (native fetch, aborts for real) | `src/helper/getFeed.ts` |
| Images      | 15 s total incl. body                        | `src/helper/fetchImage.ts`   |
| 429 backoff | ≤35 s (cleanup-duplicates), ≤45 s (fixer)    | the respective jobs          |

Work-loop bounds (a loop of bounded awaits still needs its own cap):

| Loop                                   | Bound                                    |
| -------------------------------------- | ---------------------------------------- |
| feed-grabber story matching            | deadlines anchored at job start: matching until +120 s, loop until +180 s (`storyMatcher.ts`); overflow articles stay unassigned, are held back by feed-tooter's 35 min orphan grace period, and are re-matched by the next grabber run |
| daily/weekly digest gathering          | 5 / 15 pages AND a 150 s gather budget — the digest always posts with whatever was collected |
| daily/weekly digest context fetches    | top 15 by raw engagement (favs+boosts only — reply counts are self-inflated by the thread-fixer), 1 s apart |
| cleanup orphan-ref scan                | 5000 rows/run, reads and writes chunked at 500 ids per request |
| cleanup token pruning                  | 1000 rows selected, 200 updates/run      |
| cleanup unpin                          | 10 pins/run                              |

Never `sleep()` out a rate limit inside a worker: stop the run cleanly
(post `"done"`) and let the next scheduled run resume — Mastodon's
rate-limit window (~5 min) is always shorter than any job's schedule gap.

### The per-job watchdog

Every job arms `startWatchdog(name)` from `src/helper/workerLifecycle.ts` as
its first statement: an unref'd 240 s timer that logs a loud, flushed
`[watchdog] <job> still running` line naming the job. It deliberately does
**not** post `"done"` itself — that would make Bree terminate a healthy slow
run wherever it happens to be (e.g. between a URL claim and the toot that
redeems it); the 300 s `closeWorkerAfterMs` stays the single kill switch.
If the watchdog line ever appears in production logs, some await in that job
has slipped past its bound — treat it as a bug, not noise. The watchdog is a
no-op outside a worker thread, so manual `npm run <job>` invocations are
unaffected.

### Job completion must go through `postDone()`

Bree calls `worker.terminate()` the moment a job posts `"done"`, and worker
stdout/stderr travel to the parent asynchronously — everything still queued
at terminate() time is silently discarded. Measured: with a raw
`parentPort.postMessage("done")`, 5 of 10,000 worker log lines survived;
with `postDone()` (flush + 150 ms drain before signalling), 10,000 of
10,000. All jobs therefore end every exit path with
`await postDone()` from `src/helper/workerLifecycle.ts` — never a raw
`postMessage("done")` — otherwise production job logs effectively don't
exist, which is also why earlier leak investigations were flying blind.

## Per-job kill switches

`settings.json` has a `jobs_enabled` map (day/night grabber variants share
the `feed-grabber` key). Setting a job to `false` removes it from the Bree
schedule at startup — zero worker spawns, which is the lever that actually
reduces churn-driven memory pressure. Missing keys default to enabled.
Highest-churn jobs, if memory pressure ever forces triage:
`mention-replier` (144 spawns/day), `feed-grabber` (~80), `feed-tooter`
(72), `alive` (48), `cleanup-duplicates` (~46).

### Reading the hourly memory telemetry

`src/index.ts` logs a `[memory]` line every hour. To classify growth on the
Railway graph (which counts the whole cgroup, including page cache):

- `rss`/`anon` climbing → real process leak (heap or native).
- `rss` flat, `file` climbing → kernel page cache, not a leak.
- `workersAlive` frequently > 0 between runs → hung workers; check for a
  job awaiting something unbounded (see table above).

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
