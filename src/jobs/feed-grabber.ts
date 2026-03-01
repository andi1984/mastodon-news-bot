import { parentPort } from "node:worker_threads";
import settings from "../data/settings.json" assert { type: "json" };

import getFeed from "../helper/getFeed.js";
import createClient from "../helper/db.js";

import CryptoJS from "crypto-js";
import { asyncForEach } from "../helper/async.js";

// Create a single supabase client for interacting with your database
const supabase = createClient();

// Iterate over all feeds
(async () => {
  await asyncForEach(Object.entries(settings.feeds), async ([feedKey, feedURL]: [string, string]) => {
    const rssData: { items: any[] } = await getFeed(feedURL);

    // 1. Hash feedURL to get a unique id for the table
    const tableId = CryptoJS.SHA256(feedURL);

    const candidates = rssData.items.map((item: any) => {
      const rawDate = item.pubDate ?? item.isoDate;
      const parsed = rawDate ? new Date(rawDate) : new Date();
      const pubDate = isNaN(parsed.getTime()) ? new Date() : parsed;
      return {
        hash: `${tableId}-${CryptoJS.SHA256(item.title)}-${CryptoJS.SHA256(item.link)}`,
        data: JSON.stringify({ ...item, _feedKey: feedKey }),
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
      const { error: insertError } = await supabase
        .from(settings.db_table)
        .insert(newData);

      if (insertError) {
        console.error(insertError.message);
      }

      return true;
    }

    return false;
  });

  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();
