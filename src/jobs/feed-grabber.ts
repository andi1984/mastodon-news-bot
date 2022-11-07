import settings from "../data/settings.json";

import getFeed from "../helper/getFeed";
import createClient from "../helper/db";

import sha256 from "crypto-js/sha256";
import { asyncFilter, asyncForEach } from "../helper/async";

const { parentPort } = require("worker_threads");

// Create a single supabase client for interacting with your database
const supabase = createClient();

type DB_ITEM = {
  hash: string;
  data: string;
};

// Iterate over all feeds
(async () => {
  await asyncForEach(Object.values(settings.feeds), async (feedURL: string) => {
    const rssData: { items: any[] } = await getFeed(feedURL);

    // 1. Hash feedURL to get a unique id for the table
    const tableId = sha256(feedURL);

    const newData = await asyncFilter(
      rssData.items.map((item: any) => {
        return {
          hash: `${tableId}-${sha256(item.title)}-${sha256(item.link)}}`,
          data: JSON.stringify(item),
          pub_date: new Date(item.pubDate).toISOString(),
        };
      }),
      async (item: DB_ITEM) => {
        // Check that hash isn't already in the table
        let { data: feeds, error } = await supabase
          .from(settings.db_table)
          .select("hash")
          .in("hash", [item.hash]);

        return (!feeds || feeds.length == 0) && error == null;
      }
    );

    if (newData.length > 0) {
      console.log(`Inserting ${newData.length} new items`);
      const { data, error } = await supabase
        .from(settings.db_table)
        .insert(newData)
        .select();
      console.log({ data, error });

      return true;
    }

    return false;
  });

  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();
