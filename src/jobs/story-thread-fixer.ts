/**
 * Story Thread Fixer Job
 *
 * Finds toots about the same topic (using fuzzy similarity matching) that should
 * have been grouped into story threads, and converts them by:
 * 1. Keeping the oldest toot as the "primary"
 * 2. Deleting duplicates
 * 3. Re-posting them as replies to the primary
 *
 * Runs twice daily (low frequency due to destructive nature and rate limits).
 * Uses conservative rate limiting with 30-minute pause on HTTP 429.
 */

import "dotenv/config";
import { parentPort } from "node:worker_threads";
import process from "node:process";
import getInstance from "../helper/login.js";
import {
  clusterToots,
  parseTootContent,
  type ClusterableToot,
  type TootCluster,
} from "../helper/tootClustering.js";
import type { mastodon } from "masto";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");

// Configuration
const TOOT_LIMIT = 100; // Check last 100 toots
// Re-threading deletes a published toot and re-posts it under another one —
// that needs the strict follow-up bar (0.55), not the looser grouping bar
// (0.40) this job used before. The loose bar plus transitive clustering is
// what produced "Update" threads full of unrelated topics.
const SIMILARITY_THRESHOLD = settings.story_follow_up_threshold ?? 0.55;
const TIME_WINDOW_HOURS = 24; // Only group toots within 24 hours of each other
const MAX_CLUSTERS_PER_RUN = 3; // Limit fixes per run to avoid rate limits
const MAX_CLUSTER_SIZE = settings.thread_fixer_max_cluster_size ?? 4;

// Rate limiting
const REQUEST_DELAY_MS = 2000; // 2 seconds between API calls
const DELETE_DELAY_MS = 3000; // 3 seconds between deletions
const RATE_LIMIT_PAUSE_MS = 30 * 60 * 1000; // 30 minutes on rate limit
const MAX_RETRIES = 3;

interface TootInfo extends ClusterableToot {
  content: string;
  headline: string;
  url: string;
  links: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRecentToots(
  client: mastodon.rest.Client
): Promise<TootInfo[]> {
  console.log(`[story-thread-fixer] Fetching last ${TOOT_LIMIT} toots...`);

  const account = await client.v1.accounts.verifyCredentials();
  const allStatuses: mastodon.v1.Status[] = [];

  try {
    for await (const statuses of client.v1.accounts
      .$select(account.id)
      .statuses.list({
        limit: 40,
        excludeReblogs: true,
        excludeReplies: true, // Only original toots
      })) {
      allStatuses.push(...statuses);
      if (allStatuses.length >= TOOT_LIMIT) break;
      await sleep(REQUEST_DELAY_MS);
    }
  } catch (err: any) {
    if (err.statusCode === 429) {
      console.log(
        `[story-thread-fixer] Rate limited while fetching, got ${allStatuses.length} toots`
      );
    } else {
      throw err;
    }
  }

  return allStatuses.slice(0, TOOT_LIMIT).map((status) => {
    const parsed = parseTootContent(status.content);
    return {
      id: status.id,
      content: status.content,
      plainText: parsed.plainText,
      headline: parsed.headline,
      tokens: parsed.tokens,
      createdAt: new Date(status.createdAt),
      url: status.url || "",
      hasInteractions:
        (status.favouritesCount || 0) > 0 ||
        (status.reblogsCount || 0) > 0 ||
        (status.repliesCount || 0) > 0,
      links: parsed.links,
    };
  });
}

function findSimilarClusters(toots: TootInfo[]): TootCluster<TootInfo>[] {
  console.log(
    `[story-thread-fixer] Analyzing ${toots.length} toots for similar topics...`
  );

  return clusterToots(toots, {
    threshold: SIMILARITY_THRESHOLD,
    timeWindowHours: TIME_WINDOW_HOURS,
    maxClusterSize: MAX_CLUSTER_SIZE,
  });
}

async function fixCluster(
  client: mastodon.rest.Client,
  cluster: TootCluster<TootInfo>
): Promise<{ deleted: number; replied: number; failed: number }> {
  let deleted = 0;
  let replied = 0;
  let failed = 0;

  console.log(
    `[story-thread-fixer] Fixing cluster: "${cluster.primary.headline.slice(0, 50)}..."`
  );
  console.log(
    `  Primary: ${cluster.primary.id} (${cluster.primary.createdAt.toISOString()})`
  );
  console.log(`  Duplicates: ${cluster.duplicates.length}`);
  console.log(`  Similarity: ${(cluster.avgSimilarity * 100).toFixed(1)}%`);

  // SAFETY: Re-verify primary has no interactions before proceeding
  try {
    console.log(`  Re-checking primary toot for interactions...`);
    const freshPrimary = await client.v1.statuses.$select(cluster.primary.id).fetch();
    await sleep(REQUEST_DELAY_MS);

    if ((freshPrimary.favouritesCount || 0) > 0 ||
        (freshPrimary.reblogsCount || 0) > 0 ||
        (freshPrimary.repliesCount || 0) > 0) {
      console.log(`  ABORT: Primary toot now has interactions - skipping entire cluster`);
      return { deleted: 0, replied: 0, failed: 0 };
    }
  } catch (err: any) {
    console.error(`  Failed to verify primary: ${err.message}`);
    failed++;
    return { deleted, replied, failed };
  }

  for (const dup of cluster.duplicates) {
    try {
      // SAFETY: Re-verify this duplicate has no interactions before deleting
      console.log(`  Re-checking ${dup.id} for interactions...`);
      const freshDup = await client.v1.statuses.$select(dup.id).fetch();
      await sleep(REQUEST_DELAY_MS);

      if ((freshDup.favouritesCount || 0) > 0 ||
          (freshDup.reblogsCount || 0) > 0 ||
          (freshDup.repliesCount || 0) > 0) {
        console.log(`  Skipping ${dup.id} - now has interactions`);
        continue;
      }

      // Extract unique links not in primary
      const primaryLinks = new Set(cluster.primary.links);
      const newLinks = dup.links.filter((link) => !primaryLinks.has(link));

      if (newLinks.length === 0) {
        // No new links - just delete without re-posting
        console.log(`  Deleting ${dup.id} (no new links)...`);
        await client.v1.statuses.$select(dup.id).remove();
        deleted++;
        await sleep(DELETE_DELAY_MS);
        continue;
      }

      // Build reply text with headline context and new links (same prefix as
      // feed-tooter follow-ups, so tootClustering's isUpdatePost catches both)
      const replyText = `🔗 Update: ${dup.headline.slice(0, 200)}\n${newLinks.slice(0, 2).join("\n")}`;

      // Delete the duplicate
      console.log(`  Deleting ${dup.id}...`);
      await client.v1.statuses.$select(dup.id).remove();
      deleted++;
      await sleep(DELETE_DELAY_MS);

      // Re-post as reply
      console.log(`  Creating reply to ${cluster.primary.id}...`);
      await client.v1.statuses.create({
        status: replyText,
        inReplyToId: cluster.primary.id,
        visibility: "public",
        language: "de",
      });
      replied++;
      await sleep(REQUEST_DELAY_MS);
    } catch (err: any) {
      if (err.statusCode === 429) {
        console.log(
          `[story-thread-fixer] Rate limited! Waiting ${RATE_LIMIT_PAUSE_MS / 60000} minutes...`
        );
        await sleep(RATE_LIMIT_PAUSE_MS);
        // Retry this one
        try {
          await client.v1.statuses.$select(dup.id).remove();
          deleted++;
        } catch {
          failed++;
        }
      } else {
        console.error(`  Failed to process ${dup.id}: ${err.message}`);
        failed++;
      }
    }
  }

  return { deleted, replied, failed };
}

(async () => {
  console.log("[story-thread-fixer] Starting story thread fixer job...");
  console.log(`  Similarity threshold: ${SIMILARITY_THRESHOLD}`);
  console.log(`  Time window: ${TIME_WINDOW_HOURS} hours`);
  console.log(`  Max clusters per run: ${MAX_CLUSTERS_PER_RUN}`);

  try {
    const client = await getInstance();

    // Fetch recent toots
    const toots = await fetchRecentToots(client);

    if (toots.length === 0) {
      console.log("[story-thread-fixer] No toots to analyze");
      if (parentPort) parentPort.postMessage("done");
      else process.exit(0);
      return;
    }

    // Find similar clusters
    const clusters = findSimilarClusters(toots);

    if (clusters.length === 0) {
      console.log(
        "[story-thread-fixer] No similar toot clusters found - all good!"
      );
      if (parentPort) parentPort.postMessage("done");
      else process.exit(0);
      return;
    }

    console.log(
      `[story-thread-fixer] Found ${clusters.length} clusters to fix`
    );

    // Process limited number of clusters per run
    const clustersToFix = clusters.slice(0, MAX_CLUSTERS_PER_RUN);
    let totalDeleted = 0;
    let totalReplied = 0;
    let totalFailed = 0;

    for (let i = 0; i < clustersToFix.length; i++) {
      console.log(
        `\n[story-thread-fixer] Processing cluster ${i + 1}/${clustersToFix.length}...`
      );

      let success = false;
      let retries = 0;

      while (!success && retries < MAX_RETRIES) {
        try {
          const result = await fixCluster(client, clustersToFix[i]);
          totalDeleted += result.deleted;
          totalReplied += result.replied;
          totalFailed += result.failed;
          success = true;
        } catch (err: any) {
          retries++;
          console.error(
            `[story-thread-fixer] Cluster failed (retry ${retries}/${MAX_RETRIES}): ${err.message}`
          );
          if (retries < MAX_RETRIES) {
            await sleep(RATE_LIMIT_PAUSE_MS / 6); // 5 min between retries
          }
        }
      }
    }

    console.log("\n[story-thread-fixer] Complete:");
    console.log(`  Clusters processed: ${clustersToFix.length}`);
    console.log(`  Toots deleted: ${totalDeleted}`);
    console.log(`  Replies created: ${totalReplied}`);
    console.log(`  Failed: ${totalFailed}`);
    if (clusters.length > MAX_CLUSTERS_PER_RUN) {
      console.log(
        `  Remaining clusters: ${clusters.length - MAX_CLUSTERS_PER_RUN} (will process in next run)`
      );
    }

    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
  } catch (err) {
    console.error("[story-thread-fixer] Fatal error:", err);
    if (parentPort) parentPort.postMessage("done");
    else process.exit(1);
  }
})();
