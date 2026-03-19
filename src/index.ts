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
    // Day schedule (06:00-21:59): aggressive grabbing & tooting for breaking news
    {
      name: "feed-grabber-day",
      path: path.join(jobsRoot, `feed-grabber.${ext}`),
      cron: "*/10 6-21 * * *", // Every 10 minutes (was 20)
    },
    {
      name: "feed-tooter-day",
      path: path.join(jobsRoot, `feed-tooter.${ext}`),
      cron: "*/15 6-21 * * *", // Every 15 minutes (was 30)
    },
    // Evening schedule (22:00-23:59): moderate activity
    {
      name: "feed-grabber-evening",
      path: path.join(jobsRoot, `feed-grabber.${ext}`),
      cron: "*/30 22-23 * * *", // Every 30 minutes
    },
    {
      name: "feed-tooter-evening",
      path: path.join(jobsRoot, `feed-tooter.${ext}`),
      cron: "*/45 22-23 * * *", // Every 45 minutes
    },
    // Night schedule (00:00-05:59): reduced but still active
    {
      name: "feed-grabber-night",
      path: path.join(jobsRoot, `feed-grabber.${ext}`),
      cron: "0 0,2,4 * * *", // Every 2 hours (was only 0 and 3)
    },
    {
      name: "feed-tooter-night",
      path: path.join(jobsRoot, `feed-tooter.${ext}`),
      cron: "30 1,3,5 * * *", // Every 2 hours offset
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
  ],
});

bree.start();
