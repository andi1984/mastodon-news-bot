import hashtagBoost from "../helper/hashtagBoost";
import { asyncForEach } from "../helper/async";

import settings from "../data/settings.json";

(async () => {
  const { parentPort } = require("worker_threads");
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
