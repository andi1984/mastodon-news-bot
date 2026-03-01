/**
 * One-time cleanup script to delete all auto-reply toots
 * that the bot sent in response to mentions.
 *
 * Usage:
 *   NODE_OPTIONS="--loader ts-node/esm" npx ts-node scripts/cleanup-auto-replies.ts
 *
 * Or after building:
 *   node dist/scripts/cleanup-auto-replies.js
 *
 * Requires .env with API_INSTANCE and ACCESS_TOKEN
 */
import "dotenv/config";
import { createRestAPIClient } from "masto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const settings = require("../src/data/settings.json");

const AUTO_REPLY_TEXT = settings.auto_reply_text;

(async () => {
  const client = createRestAPIClient({
    url: process.env.API_INSTANCE as string,
    accessToken: process.env.ACCESS_TOKEN as string,
  });

  // Get bot's own account
  const me = await client.v1.accounts.verifyCredentials();
  console.log(`Logged in as @${me.acct} (id: ${me.id})`);

  let deleted = 0;
  let checked = 0;

  // Paginate through bot's own statuses
  for await (const statuses of client.v1.accounts.$select(me.id).statuses.list({
    limit: 40,
    excludeReblogs: true,
  })) {
    for (const status of statuses) {
      checked++;

      // Check if this is an auto-reply (contains the auto_reply_text and is a reply)
      const plainText = status.content.replace(/<[^>]*>/g, ""); // strip HTML
      if (status.inReplyToId && plainText.includes(AUTO_REPLY_TEXT)) {
        console.log(
          `Deleting auto-reply (id: ${status.id}, created: ${status.createdAt}): ${plainText.substring(0, 80)}...`
        );
        await client.v1.statuses.$select(status.id).remove();
        deleted++;

        // Small delay to avoid rate limiting
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  console.log(`\nDone. Checked ${checked} statuses, deleted ${deleted} auto-replies.`);
})();
