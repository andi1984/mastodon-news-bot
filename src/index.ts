import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Bree from "bree";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("./data/settings.json");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log(
  "starting bree, min freshness hours: " + settings.min_freshness_hours
);

const jobsRoot = path.join(__dirname, "jobs");
/**
 * We only need the default extension to be "ts"
 * when we are running the app with ts-node - otherwise
 * the compiled-to-js code still needs to use JS
 */
const ext = process.env.TS_NODE ? "ts" : "js";

const bree = new Bree({
  root: jobsRoot,
  defaultExtension: ext,
  jobs: [
    // Day schedule (06:00–21:59): frequent grabbing & tooting
    { name: "feed-grabber-day", path: path.join(jobsRoot, `feed-grabber.${ext}`), cron: "*/20 6-21 * * *" },
    { name: "feed-tooter-day", path: path.join(jobsRoot, `feed-tooter.${ext}`), cron: "*/30 6-21 * * *" },
    // Night schedule: minimal activity
    { name: "feed-grabber-night", path: path.join(jobsRoot, `feed-grabber.${ext}`), cron: "0 0,3 * * *" },
    { name: "feed-tooter-night", path: path.join(jobsRoot, `feed-tooter.${ext}`), cron: "0 1 * * *" },
    { name: "alive", interval: "30m" },
    { name: "mention-replier", interval: "15m" },
    // Make sure cleanup happens AFTER min_freshness_hours
    { name: "cleanup", interval: `${settings.min_freshness_hours * 3}h` },
  ],
});

bree.start();
