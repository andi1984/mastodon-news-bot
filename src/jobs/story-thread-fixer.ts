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
import { tokenize, jaccardSimilarity } from "../helper/similarity.js";
import type { mastodon } from "masto";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");

// Configuration
const TOOT_LIMIT = 100; // Check last 100 toots
const SIMILARITY_THRESHOLD = settings.story_similarity_threshold ?? 0.35;
const TIME_WINDOW_HOURS = 24; // Only group toots within 24 hours of each other
const MAX_CLUSTERS_PER_RUN = 3; // Limit fixes per run to avoid rate limits

// Rate limiting
const REQUEST_DELAY_MS = 2000; // 2 seconds between API calls
const DELETE_DELAY_MS = 3000; // 3 seconds between deletions
const RATE_LIMIT_PAUSE_MS = 30 * 60 * 1000; // 30 minutes on rate limit
const MAX_RETRIES = 3;

interface TootInfo {
  id: string;
  content: string;
  plainText: string;
  headline: string;
  tokens: Set<string>;
  createdAt: Date;
  url: string;
  hasInteractions: boolean;
  links: string[];
}

interface TootCluster {
  primary: TootInfo;
  duplicates: TootInfo[];
  avgSimilarity: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHeadline(text: string): string {
  const lines = text.split(/[\n\r]+/);
  const headline = lines[0] || text;
  return headline
    .replace(/#\w+/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
}

function extractLinks(text: string): string[] {
  const matches = text.match(/https?:\/\/\S+/g) || [];
  // Filter out mastodon URLs (status links, not news links)
  return matches.filter(
    (url) =>
      !url.includes("mastodon") &&
      !url.includes("social.") &&
      !url.includes("/@")
  );
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
    const plainText = stripHtml(status.content);
    const headline = extractHeadline(plainText);
    return {
      id: status.id,
      content: status.content,
      plainText,
      headline,
      tokens: tokenize(headline),
      createdAt: new Date(status.createdAt),
      url: status.url || "",
      hasInteractions:
        (status.favouritesCount || 0) > 0 ||
        (status.reblogsCount || 0) > 0 ||
        (status.repliesCount || 0) > 0,
      links: extractLinks(plainText),
    };
  });
}

function findSimilarClusters(toots: TootInfo[]): TootCluster[] {
  console.log(
    `[story-thread-fixer] Analyzing ${toots.length} toots for similar topics...`
  );

  // Union-Find for clustering
  const parent: number[] = toots.map((_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Track similarities for reporting
  const similarities: { i: number; j: number; score: number }[] = [];

  // Compare all pairs
  for (let i = 0; i < toots.length; i++) {
    for (let j = i + 1; j < toots.length; j++) {
      // Check time proximity
      const timeDiffHours =
        Math.abs(
          toots[i].createdAt.getTime() - toots[j].createdAt.getTime()
        ) /
        (1000 * 60 * 60);

      if (timeDiffHours > TIME_WINDOW_HOURS) continue;

      // Check similarity
      const score = jaccardSimilarity(toots[i].tokens, toots[j].tokens);

      if (score >= SIMILARITY_THRESHOLD) {
        union(i, j);
        similarities.push({ i, j, score });
      }
    }
  }

  // Group by cluster root
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < toots.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) {
      clusters.set(root, []);
    }
    clusters.get(root)!.push(i);
  }

  // Convert to TootCluster format (only clusters with 2+ toots)
  const result: TootCluster[] = [];

  for (const [, indices] of clusters) {
    if (indices.length < 2) continue;

    // Sort by creation time (oldest first = primary)
    indices.sort(
      (a, b) => toots[a].createdAt.getTime() - toots[b].createdAt.getTime()
    );

    const primaryIdx = indices[0];
    const duplicateIndices = indices.slice(1);

    // Skip if primary has no interactions but duplicates do (keep the one with engagement)
    const primaryToot = toots[primaryIdx];
    const duplicatesToots = duplicateIndices.map((i) => toots[i]);

    // SAFETY: Skip entire cluster if ANY toot (including primary) has interactions
    const allClusterToots = [primaryToot, ...duplicatesToots];
    const tootsWithInteractions = allClusterToots.filter((t) => t.hasInteractions);

    if (tootsWithInteractions.length > 0) {
      console.log(
        `[story-thread-fixer] Skipping cluster "${primaryToot.headline.slice(0, 40)}..." - ${tootsWithInteractions.length} toot(s) have interactions`
      );
      continue;
    }

    // Calculate average similarity
    let totalSim = 0;
    let simCount = 0;
    for (const sim of similarities) {
      if (indices.includes(sim.i) && indices.includes(sim.j)) {
        totalSim += sim.score;
        simCount++;
      }
    }

    result.push({
      primary: primaryToot,
      duplicates: duplicatesToots,
      avgSimilarity: simCount > 0 ? totalSim / simCount : 0,
    });
  }

  // Sort by similarity (fix most similar first)
  result.sort((a, b) => b.avgSimilarity - a.avgSimilarity);

  return result;
}

async function fixCluster(
  client: mastodon.rest.Client,
  cluster: TootCluster
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

      // Build reply text with new links
      const replyText = `Update:\n${newLinks.slice(0, 2).join("\n")}`;

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
