import { postDone, startWatchdog } from "../helper/workerLifecycle.js";
import getInstance from "../helper/login.js";
import { handleMentions } from "../helper/mentionHandler.js";
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const settings = _require("../data/settings.json");

(async () => {
  startWatchdog("mention-replier");
  try {
    const mastoClient = await getInstance();
    await handleMentions(mastoClient, settings);
  } catch (e) {
    console.error(`mention-replier error: ${e}`);
  } finally {
    await postDone();
  }
})();
