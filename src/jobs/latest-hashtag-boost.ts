import { postDone, startWatchdog } from "../helper/workerLifecycle.js";
import hashtagBoost from "../helper/hashtagBoost.js";
import { asyncForEach } from "../helper/async.js";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");

(async () => {
  startWatchdog("latest-hashtag-boost");
  console.log("Starting latest hashtag boost worker");

  await asyncForEach(settings.hashtags, async (hashtag: string) => {
    await hashtagBoost(hashtag);
    return true;
  });

  // signal to parent that the job is done
  await postDone();
})().catch(async (err) => {
  // Bree worker contract: "done" must be posted on every exit path.
  console.error("[latest-hashtag-boost] Fatal error:", err);
  await postDone(1);
});
