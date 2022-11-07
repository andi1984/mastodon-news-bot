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
    { name: "feed-grabber", interval: "1h" },
    { name: "feed-tooter", interval: "2h" },
    { name: "alive", interval: "30m" },
    // Make sure cleanup happens AFTER min_freshness_hours
    { name: "cleanup", interval: `${settings.min_freshness_hours * 3}h` },
  ],
});

bree.start();
