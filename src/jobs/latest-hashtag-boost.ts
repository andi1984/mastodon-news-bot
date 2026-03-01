import { parentPort } from "node:worker_threads";
import hashtagBoost from "../helper/hashtagBoost.js";
import { asyncForEach } from "../helper/async.js";

import settings from "../data/settings.json" assert { type: "json" };

(async () => {
  console.log("Starting latest hashtag boost worker");
  console.log("foo");

  await asyncForEach(settings.hashtags, async (hashtag: string) => {
    await hashtagBoost(hashtag);
    return true;
  });

  // signal to parent that the job is done
  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();
