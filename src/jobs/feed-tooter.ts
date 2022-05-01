import createClient from "../helper/db";
import getInstance from "../helper/login";
import rssFeedItem2Toot, { FeedItem } from "../helper/rssFeedItem2Toot";

import settings from "../data/settings.json";

const { parentPort } = require("worker_threads");

(async () => {
  // Connect to DB
  const db = createClient();

  // Get an article that hasn't been tooted yet.
  let { data: feeds, error } = await db
    .from(settings.db_table)
    .select("id,data")
    .is("tooted", false)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    throw error;
  }

  if (!feeds || feeds.length === 0) {
    console.log("ALARM: Kein Feed-Inhalt mehr da zum tooten!");
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);

    return;
  }

  const { id, data }: { id: string; data: string } = feeds[0];

  try {
    const article: FeedItem = JSON.parse(data);

    // Connect to Mastodon
    const mastoClient = await getInstance();

    // TODO: "Intelligently" computing the hashtags?
    const tootText = rssFeedItem2Toot(article, settings.feed_hashtags);

    // Toot the article
    await mastoClient.statuses.create({ status: tootText });

    // Mark the article as tooted in the db
    const { data: updatedData, error: errorOnUpdate } = await db
      .from(settings.db_table)
      .update({ tooted: true })
      .match({ id });

    if (errorOnUpdate) {
      throw errorOnUpdate;
    }

    console.log("Data updated", updatedData);
  } catch (e) {
    throw new Error(`Something went wrong: ${e}`);
  } finally {
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
  }
})();
