import { parentPort } from "node:worker_threads";
import createClient from "../helper/db.js";
import getInstance from "../helper/login.js";
import rssFeedItem2Toot, { FeedItem } from "../helper/rssFeedItem2Toot.js";
import feed2CW from "../helper/feed2CW.js";
import fetchImage from "../helper/fetchImage.js";
import {
  clusterArticles,
  pickPrimaryArticle,
  isBreakingNews,
  ClusterArticle,
} from "../helper/similarity.js";
import { formatClusterToot } from "../helper/clusterFormatter.js";
import { scoreRegionalRelevance } from "../helper/regionalRelevance.js";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");

const BATCH_SIZE = (settings as any).toot_batch_size ?? 3;
const FEED_PRIORITIES: Record<string, number> =
  (settings as any).feed_priorities ?? {};
const MIN_FRESHNESS_HOURS = settings.min_freshness_hours || 24;
const SIMILARITY_THRESHOLD = (settings as any).similarity_threshold ?? 0.4;
const BREAKING_NEWS_MIN_SOURCES =
  (settings as any).breaking_news_min_sources ?? 3;
const BREAKING_NEWS_TIME_WINDOW =
  (settings as any).breaking_news_time_window_hours ?? 2;
const BREAKING_NEWS_BOOST =
  (settings as any).breaking_news_priority_boost ?? 2.0;

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

  // 1. Fetch untooted articles (increased limit for better clustering)
  let untootedQuery = db
    .from(settings.db_table)
    .select("id,data,pub_date")
    .is("tooted", false)
    .order("pub_date", { ascending: false })
    .limit(50);

  if (settings.min_freshness_hours) {
    const minFreshnessDate = new Date();
    minFreshnessDate.setHours(
      minFreshnessDate.getHours() - settings.min_freshness_hours
    );
    console.log(
      `Applying freshness filter for items from ${minFreshnessDate} or later.`
    );
    untootedQuery = untootedQuery.filter(
      "pub_date",
      "gt",
      minFreshnessDate.toISOString()
    );
  }

  // 2. Fetch recently-tooted articles from last 2h for suppression
  const recentCutoff = new Date();
  recentCutoff.setHours(recentCutoff.getHours() - BREAKING_NEWS_TIME_WINDOW);

  const recentTootedQuery = db
    .from(settings.db_table)
    .select("id,data,pub_date")
    .is("tooted", true)
    .filter("pub_date", "gt", recentCutoff.toISOString())
    .order("pub_date", { ascending: false })
    .limit(50);

  const [untootedResult, recentTootedResult] = await Promise.all([
    untootedQuery,
    recentTootedQuery,
  ]);

  if (untootedResult.error) {
    console.log(untootedResult.error.message);
    throw untootedResult.error;
  }

  const feeds = untootedResult.data;
  const recentTooted = recentTootedResult.data || [];

  if (!feeds || feeds.length === 0) {
    console.log("ALARM: Kein Feed-Inhalt mehr da zum tooten!");
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
    return;
  }

  // Parse all untooted articles into ClusterArticle format
  const untootedArticles: ClusterArticle[] = feeds.map(
    (row: { id: string; data: string; pub_date: string }) => {
      const article: FeedItem = JSON.parse(row.data);
      const feedKey = (article as any)._feedKey as string | undefined;
      const score = scoreFeedItem(feedKey, row.pub_date);
      return { id: row.id, article, feedKey, pubDate: row.pub_date, score };
    }
  );

  // Apply regional relevance scoring
  const relevanceMultipliers = await scoreRegionalRelevance(
    untootedArticles.map((a) => ({
      title: a.article.title ?? "",
      feedKey: a.feedKey,
    })),
    (settings as any).regional_relevance ?? { enabled: false, always_local_feeds: [], multipliers: { local: 1, regional: 1, national: 1, international: 1 } }
  );
  for (let i = 0; i < untootedArticles.length; i++) {
    untootedArticles[i].score *= relevanceMultipliers.get(i) ?? 1.0;
  }

  // Parse recently-tooted articles
  const recentTootedArticles: ClusterArticle[] = recentTooted.map(
    (row: { id: string; data: string; pub_date: string }) => {
      const article: FeedItem = JSON.parse(row.data);
      const feedKey = (article as any)._feedKey as string | undefined;
      return {
        id: row.id,
        article,
        feedKey,
        pubDate: row.pub_date,
        score: 0,
      };
    }
  );

  // 3. Cluster all articles together (untooted + recently tooted for suppression)
  const allArticles = [...untootedArticles, ...recentTootedArticles];
  const clusters = clusterArticles(allArticles, SIMILARITY_THRESHOLD);

  // Track which untooted IDs to suppress (matched with already-tooted articles)
  const tootedIds = new Set(recentTootedArticles.map((a) => a.id));
  const suppressIds = new Set<string>();

  // Separate clusters into postable vs suppressed
  type ScoredCluster = {
    articles: ClusterArticle[];
    clusterScore: number;
    isBreaking: boolean;
  };
  const postableClusters: ScoredCluster[] = [];

  for (const [, cluster] of clusters) {
    const hasTooted = cluster.some((a) => tootedIds.has(a.id));
    const untootedInCluster = cluster.filter((a) => !tootedIds.has(a.id));

    if (hasTooted) {
      // Suppress all untooted articles that match an already-tooted story
      for (const a of untootedInCluster) {
        suppressIds.add(a.id);
      }
      continue;
    }

    if (untootedInCluster.length === 0) continue;

    // 4. Score the cluster
    const bestScore = Math.max(...untootedInCluster.map((a) => a.score));
    const sourceBoost = 1 + (untootedInCluster.length - 1) * 0.15;
    const breaking = isBreakingNews(
      untootedInCluster,
      BREAKING_NEWS_TIME_WINDOW,
      BREAKING_NEWS_MIN_SOURCES
    );
    const breakingBoost = breaking ? BREAKING_NEWS_BOOST : 1.0;
    const clusterScore = bestScore * sourceBoost * breakingBoost;

    postableClusters.push({
      articles: untootedInCluster,
      clusterScore,
      isBreaking: breaking,
    });
  }

  // Mark suppressed articles as tooted
  if (suppressIds.size > 0) {
    const ids = Array.from(suppressIds);
    console.log(
      `Suppressing ${ids.length} articles that match already-tooted stories`
    );
    const { error: suppressError } = await db
      .from(settings.db_table)
      .update({ tooted: true })
      .in("id", ids);

    if (suppressError) {
      console.error(`Failed to suppress articles: ${suppressError.message}`);
    }
  }

  // 5. Sort clusters by score, pick top BATCH_SIZE
  postableClusters.sort((a, b) => b.clusterScore - a.clusterScore);
  const batch = postableClusters.slice(0, BATCH_SIZE);

  console.log(
    `Clustering: ${untootedArticles.length} untooted articles → ${postableClusters.length} clusters, posting top ${batch.length}`
  );
  for (const c of batch) {
    const primary = pickPrimaryArticle(c.articles, FEED_PRIORITIES);
    console.log(
      `  cluster: ${c.articles.length} articles, score=${c.clusterScore.toFixed(3)}, breaking=${c.isBreaking}, primary=${primary.feedKey ?? "unknown"}`
    );
  }

  if (batch.length === 0) {
    console.log("No clusters to post.");
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
    return;
  }

  const mastoClient = await getInstance();

  // 6. Post each cluster
  for (const cluster of batch) {
    try {
      const primary = pickPrimaryArticle(cluster.articles, FEED_PRIORITIES);

      const tootText = formatClusterToot(cluster.articles, {
        feedPriorities: FEED_PRIORITIES,
        feedHashtags: settings.feed_hashtags,
        feedSpecificHashtags: (settings as any).feed_specific_hashtags,
        breakingNewsMinSources: BREAKING_NEWS_MIN_SOURCES,
        breakingNewsTimeWindowHours: BREAKING_NEWS_TIME_WINDOW,
      });

      // Try to fetch and upload an image from the primary article
      let mediaIds: string[] | undefined;
      const enclosure = (primary.article as any).enclosure;
      if (enclosure?.url) {
        try {
          const imageBlob = await fetchImage(enclosure.url);
          if (imageBlob) {
            const attachment = await mastoClient.v2.media.create({
              file: imageBlob,
              description: primary.article.title || "",
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

      // 7. Mark ALL articles in the cluster as tooted
      const clusterIds = cluster.articles.map((a) => a.id);
      const { error: errorOnUpdate } = await db
        .from(settings.db_table)
        .update({ tooted: true })
        .in("id", clusterIds);

      if (errorOnUpdate) {
        console.error(
          `Failed to mark cluster articles as tooted: ${errorOnUpdate.message}`
        );
      } else {
        console.log(
          `Tooted cluster: ${clusterIds.length} articles [${clusterIds.join(", ")}] (primary=${primary.feedKey}${cluster.isBreaking ? ", BREAKING" : ""})`
        );
      }

      // Delay between toots to avoid rate-limiting
      if (cluster !== batch[batch.length - 1]) {
        await sleep(5000);
      }
    } catch (e) {
      console.error(`Failed to toot cluster: ${e}`);
    }
  }

  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();
