import "dotenv/config";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Bree from "bree";
import { createRequire } from "node:module";
import { checkHealth } from "./helper/db.js";

const require = createRequire(import.meta.url);
const settings = require("./data/settings.json");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log(
  `Starting Mastodon News Bot v2.0 (min freshness: ${settings.min_freshness_hours}h)`,
);

// Verify Supabase connection on startup
checkHealth().then((healthy) => {
  if (healthy) {
    console.log("Supabase connection: OK");
  } else {
    console.error(
      "WARNING: Supabase connection failed - check SUPABASE_URL/KEY",
    );
  }
});

const jobsRoot = path.join(__dirname, "jobs");

/**
 * Use .ts extension when running with tsx, .js when running compiled code.
 * tsx sets no special env var, so we detect by checking if we're in src/ vs dist/
 */
const ext = __dirname.includes("/src") ? "ts" : "js";

/**
 * Per-job kill switches: settings.jobs_enabled maps a job key to false to
 * drop it from the schedule entirely (no worker spawns at all — worker churn
 * is this bot's main memory pressure). Missing keys default to enabled.
 * The day/night grabber variants share the "feed-grabber" key.
 */
const jobsEnabled: Record<string, boolean> =
  (settings as any).jobs_enabled ?? {};
const jobKey = (name: string) => name.replace(/-(day|night)$/, "");
const filterEnabledJobs = <T extends { name: string }>(jobs: T[]): T[] =>
  jobs.filter((job) => {
    if (jobsEnabled[jobKey(job.name)] === false) {
      console.log(`[jobs] ${job.name} disabled via settings.jobs_enabled`);
      return false;
    }
    return true;
  });

const bree = new Bree({
  root: jobsRoot,
  defaultExtension: ext,
  // Kill any worker that hasn't sent "done" within 5 minutes (prevents zombie threads).
  closeWorkerAfterMs: 300_000,
  // Cap each worker's V8 heap to force more aggressive GC and prevent runaway
  // memory growth from frequent worker thread churn.
  worker: {
    resourceLimits: {
      maxOldGenerationSizeMb: 512,
      maxYoungGenerationSizeMb: 128,
    },
  },
  jobs: filterEnabledJobs([
    // Feed grabber runs frequently to catch breaking news
    // Day (06:00-21:59): every 15 minutes
    {
      name: "feed-grabber-day",
      path: path.join(jobsRoot, `feed-grabber.${ext}`),
      cron: "*/15 6-21 * * *",
    },
    // Evening/night: every 30 minutes
    {
      name: "feed-grabber-night",
      path: path.join(jobsRoot, `feed-grabber.${ext}`),
      cron: "*/30 22-23,0-5 * * *",
    },
    // Adaptive tooter - runs every 20 min, decides itself whether to post
    // Smart logic handles:
    // - Breaking news: posts immediately, pins, sets 1h cooldown
    // - Normal news: waits 30+ min between posts, max 2 items
    // - Cooldown: skips run entirely after breaking news
    {
      name: "feed-tooter",
      path: path.join(jobsRoot, `feed-tooter.${ext}`),
      cron: "*/20 * * * *", // Every 20 minutes, all day
    },
    { name: "alive", interval: "30m" },
    // Aggressive cleanup: every 6 hours (was 72h)
    { name: "cleanup", cron: "0 0,6,12,18 * * *" },
    // Daily digest at 22:00
    {
      name: "daily-digest",
      path: path.join(jobsRoot, `daily-digest.${ext}`),
      cron: "0 22 * * *",
    },
    // Weekly digest every Sunday at 20:00
    {
      name: "weekly-digest",
      path: path.join(jobsRoot, `weekly-digest.${ext}`),
      cron: "0 20 * * 0",
    },
    // Mention replier - check and respond every 10 minutes (reduced from 5m to
    // halve worker thread churn; most runs find nothing to do).
    {
      name: "mention-replier",
      path: path.join(jobsRoot, `mention-replier.${ext}`),
      interval: "10m",
    },
    // Duplicate toot cleanup - every 31 minutes
    {
      name: "cleanup-duplicates",
      path: path.join(jobsRoot, `cleanup-duplicates.${ext}`),
      interval: "31m",
    },
    // Story thread fixer - twice daily (fuzzy matching, converts similar toots to threads)
    // Runs at 03:00 and 15:00 to avoid peak hours
    {
      name: "story-thread-fixer",
      path: path.join(jobsRoot, `story-thread-fixer.${ext}`),
      cron: "0 3,15 * * *",
    },
  ]),
});

/**
 * Worker spawns since boot. The growth this process has shown in production is
 * proportional to *spawns*, not to wall-clock time or to what a job does, so
 * the spawn counter is what turns the memory line into a measurement:
 * `Δrss / Δspawns` is the per-spawn leak, readable straight from the logs.
 */
let workerSpawns = 0;
bree.on("worker created", () => {
  workerSpawns++;
});

bree.start();

/**
 * Memory telemetry, every 10 minutes.
 *
 * Railway's memory graph counts the whole container cgroup (including
 * filesystem cache), so a climbing graph alone can't tell a process leak from
 * cache growth. Logging every view side by side can:
 * - rss/anon climbing, heap flat -> native leak (not V8 — heap dumps won't show it)
 * - heapUsed/heapTotal climbing   -> ordinary JS retention
 * - rss flat, cgroup "file" climbing -> page cache, not a leak
 * - threads climbing              -> worker threads that never actually exit
 * - rss climbing with spawns flat -> time-based, so not worker churn
 *
 * `version` is logged because it is NOT implied by the repo: Nixpacks resolves
 * `.nvmrc` by major version only, so the runtime can differ from the pin (see
 * docs/operations.md).
 */
function logMemoryStats() {
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  const m = process.memoryUsage();

  const procField = (file: string, key: string) => {
    try {
      const src = readFileSync(file, "utf8");
      return Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(src)?.[1] ?? 0);
    } catch {
      return 0; // /proc unavailable (local dev, macOS)
    }
  };

  let cgroup = "";
  try {
    const current = Number(
      readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim(),
    );
    const stat = readFileSync("/sys/fs/cgroup/memory.stat", "utf8");
    const field = (key: string) =>
      Number(stat.match(new RegExp(`^${key} (\\d+)`, "m"))?.[1] ?? 0);
    cgroup =
      ` cgroupCurrent=${mb(current)}MB anon=${mb(field("anon"))}MB` +
      ` file=${mb(field("file"))}MB kernel=${mb(field("kernel"))}MB`;
  } catch {
    // cgroup v2 files unavailable (local dev, macOS, cgroup v1)
  }

  console.log(
    `[memory] version=${process.version} rss=${mb(m.rss)}MB` +
      ` hwm=${Math.round(procField("/proc/self/status", "VmHWM") / 1024)}MB` +
      ` heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB` +
      ` external=${mb(m.external)}MB arrayBuffers=${mb(m.arrayBuffers)}MB` +
      ` threads=${procField("/proc/self/status", "Threads")}` +
      ` spawns=${workerSpawns} workersAlive=${bree.workers.size}${cgroup}`,
  );
}

logMemoryStats();
setInterval(logMemoryStats, 10 * 60 * 1000);
