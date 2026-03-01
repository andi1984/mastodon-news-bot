import { parentPort } from "node:worker_threads";
import createClient from "../helper/db.js";
import getInstance from "../helper/login.js";
import rssFeedItem2Toot, { FeedItem } from "../helper/rssFeedItem2Toot.js";
import feed2CW from "../helper/feed2CW.js";
import fetchImage from "../helper/fetchImage.js";

import settings from "../data/settings.json" assert { type: "json" };

const BATCH_SIZE = (settings as any).toot_batch_size ?? 3;
const FEED_PRIORITIES: Record<string, number> =
  (settings as any).feed_priorities ?? {};
const MIN_FRESHNESS_HOURS = settings.min_freshness_hours || 24;

function scoreFeedItem(
  feedKey: string | undefined,
  pubDate: string | undefined
): number {
  const priority = feedKey ? (FEED_PRIORITIES[feedKey] ?? 0.5) : 0.5;

  if (!pubDate) return priority * 0.5;

  const ageMs = Date.now() - new Date(pubDate).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  const freshness = Math.max(0, 1 - ageHours / MIN_FRESHNESS_HOURS);

  return priority * freshness;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const db = createClient();
  let query = db
    .from(settings.db_table)
    .select("id,data,pub_date")
    .is("tooted", false)
    .order("pub_date", { ascending: false })
    .limit(20);

  if (settings.min_freshness_hours) {
    const minFreshnessDate = new Date();
    minFreshnessDate.setHours(
      minFreshnessDate.getHours() - settings.min_freshness_hours
    );
    console.log(
      `Applying freshness filter for items from ${minFreshnessDate} or later.`
    );
    query = query.filter("pub_date", "gt", minFreshnessDate.toISOString());
  }

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

  // Score and rank candidates
  const scored = feeds.map(
    (row: { id: string; data: string; pub_date: string }) => {
      const article: FeedItem = JSON.parse(row.data);
      const feedKey = (article as any)._feedKey as string | undefined;
      const score = scoreFeedItem(feedKey, row.pub_date);
      return { id: row.id, article, feedKey, score };
    }
  );

  scored.sort((a: { score: number }, b: { score: number }) => b.score - a.score);
  const batch = scored.slice(0, BATCH_SIZE);

  console.log(
    `Scoring: ${scored.length} candidates, posting top ${batch.length}`
  );
  for (const item of batch) {
    console.log(
      `  feed=${item.feedKey ?? "unknown"} score=${item.score.toFixed(3)} id=${item.id}`
    );
  }

  const mastoClient = await getInstance();

  for (const item of batch) {
    try {
      const feedSpecificHashtags =
        item.feedKey && (settings as any).feed_specific_hashtags?.[item.feedKey];
      const hashtags = [
        ...settings.feed_hashtags,
        ...(feedSpecificHashtags || []),
      ];

      const tootText = rssFeedItem2Toot(item.article, hashtags);

      // Try to fetch and upload an article image
      let mediaIds: string[] | undefined;
      const enclosure = (item.article as any).enclosure;
      if (enclosure?.url) {
        try {
          const imageBlob = await fetchImage(enclosure.url);
          if (imageBlob) {
            const attachment = await mastoClient.v2.media.create({
              file: imageBlob,
              description: item.article.title || "",
            });
            mediaIds = [attachment.id];
            console.log(`Image attached: ${enclosure.url}`);
          }
        } catch (imgErr) {
          console.error(
            `Image upload failed, tooting without image: ${imgErr}`
          );
        }
      }

      await mastoClient.v1.statuses.create({
        status: tootText,
        spoilerText: feed2CW(tootText, settings),
        visibility: "public",
        language: "de",
        ...(mediaIds ? { mediaIds } : {}),
      });

      const { error: errorOnUpdate } = await db
        .from(settings.db_table)
        .update({ tooted: true })
        .match({ id: item.id });

      if (errorOnUpdate) {
        console.error(
          `Failed to mark article ${item.id} as tooted: ${errorOnUpdate.message}`
        );
      } else {
        console.log(`Tooted and marked article ${item.id} (feed=${item.feedKey})`);
      }

      // Delay between toots to avoid rate-limiting
      if (item !== batch[batch.length - 1]) {
        await sleep(5000);
      }
    } catch (e) {
      console.error(`Failed to toot article ${item.id}: ${e}`);
    }
  }

  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();
