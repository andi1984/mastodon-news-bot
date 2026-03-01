import { parentPort } from "node:worker_threads";
import getInstance from "../helper/login.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");

(async () => {
  try {
    const mastoClient = await getInstance();

    const notifications = await mastoClient.v1.notifications.list({
      types: ["mention"],
    });

    for (const notification of notifications) {
      const status = notification.status;

      if (!status) {
        await mastoClient.v1.notifications.$select(notification.id).dismiss();
        continue;
      }

      // Skip own mentions (loop prevention)
      if (status.account.acct === settings.username) {
        await mastoClient.v1.notifications.$select(notification.id).dismiss();
        continue;
      }

      // Skip standalone mentions (not replies)
      if (!status.inReplyToId) {
        await mastoClient.v1.notifications.$select(notification.id).dismiss();
        continue;
      }

      // Reply to the mention
      await mastoClient.v1.statuses.create({
        status: `@${status.account.acct} ${settings.auto_reply_text}`,
        inReplyToId: status.id,
        visibility: "unlisted",
        language: "de",
      });

      await mastoClient.v1.notifications.$select(notification.id).dismiss();
    }
  } catch (e) {
    console.error(`mention-replier error: ${e}`);
  } finally {
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
  }
})();
