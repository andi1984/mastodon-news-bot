require("dotenv").config();
import settings from "./data/settings.json";

const path = require("path");

const Bree = require("bree");

console.log(
  "starting bree, min freshness hours: " + settings.min_freshness_hours
);

const bree = new Bree({
  root: path.join(__dirname, "jobs"),
  /**
   * We only need the default extension to be "ts"
   * when we are running the app with ts-node - otherwise
   * the compiled-to-js code still needs to use JS
   */
  defaultExtension: process.env.TS_NODE ? "ts" : "js",
  jobs: [
    // Day schedule (06:00–21:59): frequent grabbing & tooting
    { name: "feed-grabber-day", path: "feed-grabber", cron: "*/20 6-21 * * *" },
    { name: "feed-tooter-day", path: "feed-tooter", cron: "*/30 6-21 * * *" },
    // Night schedule: minimal activity
    { name: "feed-grabber-night", path: "feed-grabber", cron: "0 0,3 * * *" },
    { name: "feed-tooter-night", path: "feed-tooter", cron: "0 1 * * *" },
    { name: "alive", interval: "30m" },
    { name: "mention-replier", interval: "15m" },
    // Make sure cleanup happens AFTER min_freshness_hours
    { name: "cleanup", interval: `${settings.min_freshness_hours * 3}h` },
  ],
});

bree.start();
