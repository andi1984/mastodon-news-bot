import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Bree from "bree";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("./data/settings.json");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log(
  `Starting Mastodon News Bot v2.0 (min freshness: ${settings.min_freshness_hours}h)`
);

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
    // Day schedule (06:00-21:59): frequent grabbing & tooting
    {
      name: "feed-grabber-day",
      path: path.join(jobsRoot, `feed-grabber.${ext}`),
      cron: "*/20 6-21 * * *",
    },
    {
      name: "feed-tooter-day",
      path: path.join(jobsRoot, `feed-tooter.${ext}`),
      cron: "*/30 6-21 * * *",
    },
    // Night schedule: minimal activity
    {
      name: "feed-grabber-night",
      path: path.join(jobsRoot, `feed-grabber.${ext}`),
      cron: "0 0,3 * * *",
    },
    {
      name: "feed-tooter-night",
      path: path.join(jobsRoot, `feed-tooter.${ext}`),
      cron: "0 1 * * *",
    },
    { name: "alive", interval: "30m" },
    // Cleanup happens AFTER min_freshness_hours
    { name: "cleanup", interval: `${settings.min_freshness_hours * 3}h` },
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
