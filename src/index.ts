import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Bree from "bree";
import { createRequire } from "node:module";
import { checkHealth } from "./helper/db.js";

const require = createRequire(import.meta.url);
const settings = require("./data/settings.json");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log(
  `Starting Mastodon News Bot v2.0 (min freshness: ${settings.min_freshness_hours}h)`
);

// Verify Supabase connection on startup
checkHealth().then((healthy) => {
  if (healthy) {
    console.log("Supabase connection: OK");
  } else {
    console.error("WARNING: Supabase connection failed - check SUPABASE_URL/KEY");
  }
});

const jobsRoot = path.join(__dirname, "jobs");

/**
 * Use .ts extension when running with tsx, .js when running compiled code.
 * tsx sets no special env var, so we detect by checking if we're in src/ vs dist/
 */
const ext = __dirname.includes("/src") ? "ts" : "js";

const bree = new Bree({
  root: jobsRoot,
  defaultExtension: ext,
  jobs: [
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
    // Mention replier - check and respond every 5 minutes
    {
      name: "mention-replier",
      path: path.join(jobsRoot, `mention-replier.${ext}`),
      interval: "5m",
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
  ],
});

bree.start();
