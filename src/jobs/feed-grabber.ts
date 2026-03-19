import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");

import getFeed from "../helper/getFeed.js";
import createClient from "../helper/db.js";
import { sha256 } from "../helper/hash.js";
import {
  processNewArticles,
  ArticleForMatching,
} from "../helper/storyMatcher.js";

// Single supabase client (singleton) with retry/timeout built in
const supabase = createClient();

// Process feeds in parallel batches - increased for faster processing
const BATCH_SIZE = 8;

async function processFeedBatch(
  feedEntries: [string, string][]
): Promise<void> {
  await Promise.all(
    feedEntries.map(async ([feedKey, feedURL]) => {
      try {
        const rssData = await getFeed(feedURL);

        if (!rssData) {
          return;
        }

        // Hash feedURL once for this feed
        const tableId = sha256(feedURL);

        const candidates = rssData.items.map((item: any) => {
          const rawDate = item.pubDate ?? item.isoDate;
          const parsed = rawDate ? new Date(rawDate) : new Date();
          const pubDate = isNaN(parsed.getTime()) ? new Date() : parsed;
          return {
            hash: `${tableId}-${sha256(item.title)}-${sha256(item.link)}`,
            data: { ...item, _feedKey: feedKey },
            pub_date: pubDate.toISOString(),
          };
        });

        if (candidates.length === 0) return;

        // Batch-check which hashes already exist (single query instead of N)
        const { data: existing, error } = await supabase
          .from(settings.db_table)
          .select("hash")
          .in(
            "hash",
            candidates.map((c) => c.hash)
          );

        if (error) {
          console.error(`[${feedKey}] ${error.message}`);
          return;
        }

        const existingSet = new Set(
          (existing ?? []).map((e: { hash: string }) => e.hash)
        );
        const newData = candidates.filter((c) => !existingSet.has(c.hash));

        if (newData.length > 0) {
          console.log(`[${feedKey}] Inserting ${newData.length} new items`);
          const { data: inserted, error: insertError } = await supabase
            .from(settings.db_table)
            .insert(newData)
            .select("id, data, pub_date");

          if (insertError) {
            console.error(`[${feedKey}] ${insertError.message}`);
            return;
          }

          // Process newly inserted articles for story assignment
          if (inserted && inserted.length > 0) {
            const articlesForMatching: ArticleForMatching[] = inserted.map(
              (row: { id: string; data: any; pub_date: string }) => ({
                id: row.id,
                title: row.data.title || "",
                contentSnippet: row.data.contentSnippet,
                pubDate: row.pub_date,
                feedKey: row.data._feedKey,
              })
            );
            await processNewArticles(articlesForMatching, settings.db_table);
          }
        }
      } catch (err) {
        console.error(`[${feedKey}] Unexpected error: ${err}`);
      }
    })
  );
}

(async () => {
  const feedEntries = Object.entries(settings.feeds) as [string, string][];
  console.log(`Processing ${feedEntries.length} feeds...`);

  // Process feeds in parallel batches
  for (let i = 0; i < feedEntries.length; i += BATCH_SIZE) {
    const batch = feedEntries.slice(i, i + BATCH_SIZE);
    await processFeedBatch(batch);
  }

  console.log("Feed grabber complete");

  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();
