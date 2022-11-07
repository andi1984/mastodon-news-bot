import createClient from "../helper/db";
import getInstance from "../helper/login";
import rssFeedItem2Toot, { FeedItem } from "../helper/rssFeedItem2Toot";

import settings from "../data/settings.json";

const { parentPort } = require("worker_threads");

(async () => {
  // Connect to DB
  const db = createClient();
  let query = db
    .from(settings.db_table)
    .select("id,data")
    .is("tooted", false)
    .order("pub_date", { ascending: false })
    .limit(1);

  // Optional filter for feed items within certain freshness interval (hours)
  if (!!settings.min_freshness_hours) {
    // https://github.com/supabase/supabase/discussions/3734#discussioncomment-1579562
    const minFreshnessDate = new Date();
    minFreshnessDate.setHours(
      minFreshnessDate.getHours() - settings.min_freshness_hours
    );
    console.log(
      `Applying freshness filter for items being from ${minFreshnessDate} or earlier.`
    );
    query = query.filter("pub_date", "gt", minFreshnessDate.toISOString());
  }

  // Get an article that hasn't been tooted yet.
  let { data: feeds, error } = await query;

  if (error) {
    console.log(error.message);
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
      .match({ id })
      .select();

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
