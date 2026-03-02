import { parentPort } from "node:worker_threads";
import getInstance from "../helper/login.js";
import { handleMentions } from "../helper/mentionHandler.js";
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const settings = _require("../data/settings.json");

(async () => {
  try {
    const mastoClient = await getInstance();
    await handleMentions(mastoClient, settings);
  } catch (e) {
    console.error(`mention-replier error: ${e}`);
  } finally {
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
  }
})();
