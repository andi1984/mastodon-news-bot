import "dotenv/config";
import { parentPort } from "node:worker_threads";
import createClient from "../helper/db.js";
import getInstance from "../helper/login.js";
import rssFeedItem2Toot, { FeedItem } from "../helper/rssFeedItem2Toot.js";
import feed2CW from "../helper/feed2CW.js";
import fetchImage from "../helper/fetchImage.js";
import {
  pickPrimaryArticle,
  isBreakingNews,
  ClusterArticle,
} from "../helper/similarity.js";
import { formatClusterToot, formatThreadReply } from "../helper/clusterFormatter.js";
import { scoreRegionalRelevance } from "../helper/regionalRelevance.js";
import { markStoryTooted, getStoryTootId } from "../helper/storyMatcher.js";
import { analyzeForPoll, PollSuggestion } from "../helper/engagementEnhancer.js";
import { generateHashtags } from "../helper/hashtagGenerator.js";
import { scoreFeedItem } from "../helper/feedItemScorer.js";
import {
  isInCooldown,
  setCooldown,
  getMinutesSinceLastToot,
  recordLastToot,
  recordPinnedToot,
} from "../helper/botState.js";
import { saveHashesAndFinalize } from "../helper/hashPersistence.js";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");

// Adaptive tooting settings (from settings.json)
const adaptiveSettings = (settings as any).adaptive_tooting ?? {};
const NORMAL_BATCH_SIZE = adaptiveSettings.normal_batch_size ?? 2;
const BREAKING_BATCH_SIZE = adaptiveSettings.breaking_batch_size ?? 3;
const MIN_MINUTES_BETWEEN_TOOTS = adaptiveSettings.min_minutes_between_toots ?? 30;

const FEED_PRIORITIES: Record<string, number> =
  (settings as any).feed_priorities ?? {};
const MIN_FRESHNESS_HOURS = settings.min_freshness_hours || 24;
const BREAKING_NEWS_MIN_SOURCES =
  (settings as any).breaking_news_min_sources ?? 2;
const BREAKING_NEWS_TIME_WINDOW =
  (settings as any).breaking_news_time_window_hours ?? 3;
const BREAKING_NEWS_BOOST =
  (settings as any).breaking_news_priority_boost ?? 2.0;
const STORY_THREADING_ENABLED =
  (settings as any).story_threading_enabled ?? true;
const POLL_ENABLED = (settings as any).poll_enabled ?? true;
const POLL_CHANCE = (settings as any).poll_chance ?? 0.15; // 15% of eligible posts

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ArticleRow = {
  id: string;
  data: FeedItem & { _feedKey?: string };
  pub_date: string;
  story_id: string | null;
};

type StoryInfo = {
  id: string;
  tooted: boolean;
  toot_id: string | null;
  original_links: string[];
};

(async () => {
  const db = createClient();

  // 0. Check if we're in cooldown (after breaking news)
  const cooldownStatus = await isInCooldown();
  if (cooldownStatus.inCooldown) {
    console.log(`Skipping: in cooldown (reason: ${cooldownStatus.reason})`);
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
    return;
  }

  // 1. Fetch untooted articles with story_id
  let untootedQuery = db
    .from(settings.db_table)
    .select("id,data,pub_date,story_id")
    .is("tooted", false)
    .order("pub_date", { ascending: false })
    .limit(100);

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

  const untootedResult = await untootedQuery;

  if (untootedResult.error) {
    console.log(untootedResult.error.message);
    throw untootedResult.error;
  }

  const feeds = untootedResult.data as ArticleRow[];

  if (!feeds || feeds.length === 0) {
    console.log("ALARM: Kein Feed-Inhalt mehr da zum tooten!");
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
    return;
  }

  // 2. Get story info for all story IDs (including toot_id for threading)
  const storyIds = [
    ...new Set(feeds.filter((f) => f.story_id).map((f) => f.story_id!)),
  ];

  const storyInfoMap = new Map<string, StoryInfo>();
  if (storyIds.length > 0) {
    const { data: stories } = await db
      .from("stories")
      .select("id, tooted, toot_id, original_links")
      .in("id", storyIds);

    if (stories) {
      for (const s of stories as StoryInfo[]) {
        storyInfoMap.set(s.id, s);
      }
    }
  }

  // 3. Separate articles into: new stories, follow-ups (threading), orphans
  const newStoryArticles: ArticleRow[] = [];
  const followUpGroups = new Map<string, ArticleRow[]>(); // story_id -> articles for threading
  const orphanArticles: ArticleRow[] = [];

  for (const article of feeds) {
    if (!article.story_id) {
      orphanArticles.push(article);
      continue;
    }

    const storyInfo = storyInfoMap.get(article.story_id);
    if (!storyInfo) {
      // Story not found - treat as orphan
      orphanArticles.push(article);
      continue;
    }

    if (storyInfo.tooted && storyInfo.toot_id && STORY_THREADING_ENABLED) {
      // Story already posted - this is a follow-up for threading
      if (!followUpGroups.has(article.story_id)) {
        followUpGroups.set(article.story_id, []);
      }
      followUpGroups.get(article.story_id)!.push(article);
    } else if (storyInfo.tooted) {
      // Story tooted but threading disabled - save hash and delete immediately
      await saveHashesAndFinalize(db, [article.id], "suppress-threaded");
    } else {
      // Story not yet posted - queue for posting
      newStoryArticles.push(article);
    }
  }

  console.log(
    `Articles: ${newStoryArticles.length} new, ${followUpGroups.size} follow-up threads, ${orphanArticles.length} orphans`
  );

  // 4. Group new story articles by story_id
  const storyGroups = new Map<string, ClusterArticle[]>();

  for (const row of newStoryArticles) {
    const article: FeedItem = row.data;
    const feedKey = row.data._feedKey as string | undefined;
    const score = scoreFeedItem(feedKey, row.pub_date, FEED_PRIORITIES, MIN_FRESHNESS_HOURS);
    const clusterArticle: ClusterArticle = {
      id: row.id,
      article,
      feedKey,
      pubDate: row.pub_date,
      score,
    };

    if (row.story_id) {
      if (!storyGroups.has(row.story_id)) {
        storyGroups.set(row.story_id, []);
      }
      storyGroups.get(row.story_id)!.push(clusterArticle);
    }
  }

  // Convert orphans to ClusterArticle format
  const orphanClusters: ClusterArticle[] = orphanArticles.map((row) => ({
    id: row.id,
    article: row.data,
    feedKey: row.data._feedKey,
    pubDate: row.pub_date,
    score: scoreFeedItem(row.data._feedKey, row.pub_date, FEED_PRIORITIES, MIN_FRESHNESS_HOURS),
  }));

  // 5. Apply regional relevance scoring
  const allArticlesForScoring = [
    ...Array.from(storyGroups.values()).flat(),
    ...orphanClusters,
  ];

  if (allArticlesForScoring.length > 0) {
    const relevanceMultipliers = await scoreRegionalRelevance(
      allArticlesForScoring.map((a) => ({
        title: a.article.title ?? "",
        feedKey: a.feedKey,
      })),
      (settings as any).regional_relevance ?? {
        enabled: false,
        always_local_feeds: [],
        multipliers: { local: 1, regional: 1, national: 1, international: 1 },
      }
    );

    for (let i = 0; i < allArticlesForScoring.length; i++) {
      allArticlesForScoring[i].score *= relevanceMultipliers.get(i) ?? 1.0;
    }
  }

  // 6. Score stories and create postable list
  type ScoredStory = {
    storyId: string | null;
    articles: ClusterArticle[];
    storyScore: number;
    isBreaking: boolean;
  };
  const postableStories: ScoredStory[] = [];

  for (const [storyId, articles] of storyGroups) {
    const bestScore = Math.max(...articles.map((a) => a.score));
    const sourceBoost = 1 + (articles.length - 1) * 0.15;
    const breaking = isBreakingNews(
      articles,
      BREAKING_NEWS_TIME_WINDOW,
      BREAKING_NEWS_MIN_SOURCES
    );
    const breakingBoost = breaking ? BREAKING_NEWS_BOOST : 1.0;
    const storyScore = bestScore * sourceBoost * breakingBoost;

    postableStories.push({
      storyId,
      articles,
      storyScore,
      isBreaking: breaking,
    });
  }

  // Process orphan articles as individual stories
  for (const article of orphanClusters) {
    postableStories.push({
      storyId: null,
      articles: [article],
      storyScore: article.score,
      isBreaking: false,
    });
  }

  // 7. Sort by score and apply adaptive batch selection
  postableStories.sort((a, b) => b.storyScore - a.storyScore);

  // Separate breaking news from regular news
  const breakingStories = postableStories.filter((s) => s.isBreaking);
  const normalStories = postableStories.filter((s) => !s.isBreaking);

  let batch: typeof postableStories = [];
  let isBreakingRun = false;

  if (breakingStories.length > 0) {
    // Breaking news detected - toot immediately with larger batch
    batch = breakingStories.slice(0, BREAKING_BATCH_SIZE);
    isBreakingRun = true;
    console.log(`BREAKING NEWS detected: ${breakingStories.length} stories, posting ${batch.length}`);
  } else {
    // Normal news - check if enough time has passed
    const minutesSinceLast = await getMinutesSinceLastToot();
    console.log(`Minutes since last toot: ${minutesSinceLast.toFixed(1)}`);

    if (minutesSinceLast < MIN_MINUTES_BETWEEN_TOOTS) {
      console.log(`Skipping: only ${minutesSinceLast.toFixed(0)}min since last toot (min: ${MIN_MINUTES_BETWEEN_TOOTS})`);
      // Still process follow-up threads, but skip new stories
      batch = [];
    } else {
      // Enough time passed - post 1-2 normal stories
      batch = normalStories.slice(0, NORMAL_BATCH_SIZE);
    }
  }

  console.log(
    `Stories: ${storyGroups.size} grouped + ${orphanClusters.length} orphans → posting ${batch.length}${isBreakingRun ? " (BREAKING)" : ""}`
  );
  for (const story of batch) {
    const primary = pickPrimaryArticle(story.articles, FEED_PRIORITIES);
    const sourceCount = new Set(story.articles.map((a) => a.feedKey)).size;
    console.log(
      `  story: ${story.articles.length} articles from ${sourceCount} sources, score=${story.storyScore.toFixed(3)}, breaking=${story.isBreaking}, primary=${primary.feedKey ?? "unknown"}`
    );
  }

  const mastoClient = await getInstance();

  // 8. Post new stories
  let pollPostedThisRun = false; // Limit to one poll per run

  for (const story of batch) {
    try {
      const primary = pickPrimaryArticle(story.articles, FEED_PRIORITIES);

      // Generate content-derived hashtags from primary article
      const hashtags = await generateHashtags(
        primary.article.title || "",
        settings.feed_hashtags
      );

      const tootText = formatClusterToot(story.articles, {
        feedPriorities: FEED_PRIORITIES,
        hashtags,
        breakingNewsMinSources: BREAKING_NEWS_MIN_SOURCES,
        breakingNewsTimeWindowHours: BREAKING_NEWS_TIME_WINDOW,
      });

      // Check if this story is suitable for a poll (debatable topic)
      let pollConfig: PollSuggestion | undefined;
      if (
        POLL_ENABLED &&
        !pollPostedThisRun &&
        !story.isBreaking // Don't poll on breaking news
      ) {
        const analysis = await analyzeForPoll(
          primary.article.title || "",
          primary.feedKey
        );
        // Apply random chance AFTER confirming topic is debatable
        if (analysis.isDebatable && analysis.poll && Math.random() < POLL_CHANCE) {
          pollConfig = analysis.poll;
          console.log(`Poll suggested: "${analysis.poll.question}"`);
        }
      }

      // Try to fetch and upload an image (skip if using poll - Mastodon limitation)
      let mediaIds: string[] | undefined;
      if (!pollConfig) {
        const enclosure = (primary.article as any).enclosure;
        if (enclosure?.url) {
          try {
            const imageBlob = await fetchImage(enclosure.url);
            if (imageBlob) {
              // Build descriptive alt text: title + source for better accessibility
              const sourceName = primary.feedKey || "Nachrichtenquelle";
              const altText = `${primary.article.title || "Nachrichtenbild"} (Quelle: ${sourceName})`;
              const attachment = await mastoClient.v2.media.create({
                file: imageBlob,
                description: altText.slice(0, 1500), // Mastodon alt text limit
              });
              mediaIds = [attachment.id];
              console.log(`Image attached: ${enclosure.url}`);
            }
          } catch (imgErr) {
            console.error(`Image upload failed: ${imgErr}`);
          }
        }
      }

      // Build the final toot text (add poll question if using poll)
      const finalText = pollConfig
        ? `${tootText}\n\n${pollConfig.question}`
        : tootText;

      // Create status - different call patterns for media vs poll (TypeScript strict types)
      const baseParams = {
        status: finalText,
        spoilerText: feed2CW(tootText, settings),
        visibility: "public" as const,
        language: "de",
      };

      const tootResult = mediaIds
        ? await mastoClient.v1.statuses.create({ ...baseParams, mediaIds })
        : pollConfig
          ? await mastoClient.v1.statuses.create({
              ...baseParams,
              poll: {
                options: pollConfig.options,
                expiresIn: pollConfig.expiresInSeconds,
              },
            })
          : await mastoClient.v1.statuses.create(baseParams);

      if (pollConfig) {
        pollPostedThisRun = true;
        console.log(`Poll posted with ${pollConfig.options.length} options`);
      }

      // For breaking news: pin the toot and set cooldown
      if (story.isBreaking) {
        try {
          await mastoClient.v1.statuses.$select(tootResult.id).pin();
          await recordPinnedToot(tootResult.id);
          console.log(`Pinned breaking news toot ${tootResult.id}`);
        } catch (pinErr) {
          console.error(`Failed to pin breaking news: ${pinErr}`);
        }
      }

      // Record last toot time for rate limiting
      await recordLastToot();

      // Mark story as tooted, storing original links for deduplication in quote replies
      if (story.storyId) {
        const originalLinks = story.articles
          .map((a) => a.article.link)
          .filter((link): link is string => !!link);
        await markStoryTooted(story.storyId, tootResult.id, originalLinks);
      }

      const articleIds = story.articles.map((a) => a.id);
      await saveHashesAndFinalize(db, articleIds, "main-toot");

      const sourceCount = new Set(story.articles.map((a) => a.feedKey)).size;
      console.log(
        `Tooted: ${articleIds.length} articles from ${sourceCount} sources (primary=${primary.feedKey}${story.isBreaking ? ", BREAKING" : ""}${pollConfig ? ", WITH POLL" : ""})`
      );

      await sleep(5000);
    } catch (e) {
      console.error(`Failed to toot story: ${e}`);
    }
  }

  // Set cooldown after posting breaking news
  if (isBreakingRun && batch.length > 0) {
    await setCooldown("breaking_news");
    console.log("Cooldown activated: 1 hour pause for regular news");
  }

  // 9. Post follow-up threads (limited to 2 per run to avoid spam)
  let threadCount = 0;
  const MAX_THREADS_PER_RUN = 2;

  for (const [storyId, articleRows] of followUpGroups) {
    if (threadCount >= MAX_THREADS_PER_RUN) break;

    try {
      const storyInfo = storyInfoMap.get(storyId);
      if (!storyInfo?.toot_id) continue;

      // Convert to ClusterArticle format
      const articles: ClusterArticle[] = articleRows.map((row) => ({
        id: row.id,
        article: row.data,
        feedKey: row.data._feedKey,
        pubDate: row.pub_date,
        score: scoreFeedItem(row.data._feedKey, row.pub_date, FEED_PRIORITIES, MIN_FRESHNESS_HOURS),
      }));

      // Check if any articles have new links (not in original toot)
      const originalLinksSet = new Set(storyInfo.original_links || []);
      const newLinks = articles
        .map((a) => a.article.link)
        .filter((link): link is string => !!link && !originalLinksSet.has(link));

      if (newLinks.length === 0) {
        // All links are duplicates - no value in posting a quote
        const articleIds = articles.map((a) => a.id);
        await saveHashesAndFinalize(db, articleIds, "thread-skip-duplicate");
        console.log(
          `Skipped thread reply: ${articleIds.length} articles with duplicate links for story ${storyId.slice(0, 8)}...`
        );
        continue;
      }

      const replyText = formatThreadReply(
        articles,
        FEED_PRIORITIES,
        storyInfo.original_links || []
      );

      // Use quotedStatusId instead of inReplyToId for better visibility
      // Quote posts appear prominently and increase engagement with the original
      await mastoClient.v1.statuses.create({
        status: replyText,
        quotedStatusId: storyInfo.toot_id,
        visibility: "public",
        language: "de",
      });

      const articleIds = articles.map((a) => a.id);
      await saveHashesAndFinalize(db, articleIds, "thread-reply");

      console.log(
        `Threaded reply: ${articleIds.length} articles to story ${storyId.slice(0, 8)}...`
      );

      threadCount++;
      await sleep(3000);
    } catch (e) {
      console.error(`Failed to post thread reply: ${e}`);
      // Suppress the article to avoid retry loops (content was problematic anyway)
      const articleIds = articleRows.map((r) => r.id);
      await saveHashesAndFinalize(db, articleIds, "thread-reply-error");
    }
  }

  if (batch.length === 0 && threadCount === 0) {
    console.log("No stories or threads to post.");
  }

  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();
