import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");

import getFeed from "../helper/getFeed.js";
import createClient from "../helper/db.js";
import { processNewArticles, ArticleForMatching } from "../helper/storyMatcher.js";

import CryptoJS from "crypto-js";
import { asyncForEach } from "../helper/async.js";

// Create a single supabase client for interacting with your database
const supabase = createClient();

// Iterate over all feeds
(async () => {
  await asyncForEach(Object.entries(settings.feeds) as [string, string][], async ([feedKey, feedURL]: [string, string]) => {
    const rssData = await getFeed(feedURL);

    if (!rssData) {
      return false;
    }

    // 1. Hash feedURL to get a unique id for the table
    const tableId = CryptoJS.SHA256(feedURL);

    const candidates = rssData.items.map((item: any) => {
      const rawDate = item.pubDate ?? item.isoDate;
      const parsed = rawDate ? new Date(rawDate) : new Date();
      const pubDate = isNaN(parsed.getTime()) ? new Date() : parsed;
      return {
        hash: `${tableId}-${CryptoJS.SHA256(item.title)}-${CryptoJS.SHA256(item.link)}`,
        data: { ...item, _feedKey: feedKey },
        pub_date: pubDate.toISOString(),
      };
    });

    if (candidates.length === 0) return false;

    // Batch-check which hashes already exist (single query instead of N)
    const { data: existing, error } = await supabase
      .from(settings.db_table)
      .select("hash")
      .in("hash", candidates.map(c => c.hash));

    if (error) {
      console.error(error.message);
      return false;
    }

    const existingSet = new Set((existing ?? []).map((e: { hash: string }) => e.hash));
    const newData = candidates.filter(c => !existingSet.has(c.hash));

    if (newData.length > 0) {
      console.log(`Inserting ${newData.length} new items`);
      const { data: inserted, error: insertError } = await supabase
        .from(settings.db_table)
        .insert(newData)
        .select("id, data, pub_date");

      if (insertError) {
        console.error(insertError.message);
        return false;
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

      return true;
    }

    return false;
  });

  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();
