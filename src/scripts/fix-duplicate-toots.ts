/**
 * Script to retroactively fix duplicate toots that should have been stories/threads.
 *
 * Usage:
 *   npx ts-node --esm src/scripts/fix-duplicate-toots.ts [--dry-run] [--count=50]
 *
 * Options:
 *   --dry-run    Preview changes without making any modifications
 *   --count=N    Number of recent toots to analyze (default: 50)
 *   --threshold=N  Similarity threshold 0-1 (default: 0.35)
 */

import "dotenv/config";
import getInstance from "../helper/login.js";
import { tokenize, jaccardSimilarity } from "../helper/similarity.js";
import type { mastodon } from "masto";

// Rate limiting: Mastodon typically allows ~300 requests per 5 minutes
// But user mentioned 30min cooldown for their instance - we'll be conservative
const RATE_LIMIT_DELAY_MS = 6000; // 6 seconds between API calls
const BATCH_PAUSE_MS = 30 * 60 * 1000; // 30 minutes if we hit rate limit

interface TootInfo {
  id: string;
  content: string;
  plainText: string;
  createdAt: Date;
  url: string;
  favouritesCount: number;
  reblogsCount: number;
  repliesCount: number;
}

function hasInteractions(toot: TootInfo): boolean {
  return toot.favouritesCount > 0 || toot.reblogsCount > 0 || toot.repliesCount > 0;
}

interface TootCluster {
  primary: TootInfo;
  duplicates: TootInfo[];
  similarity: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(html: string): string {
  // Remove HTML tags and decode entities
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
  // Extract the main headline (first line before hashtags/links)
  const lines = text.split(/[\n\r]+/);
  const headline = lines[0] || text;
  // Remove hashtags and URLs for comparison
  return headline
    .replace(/#\w+/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
}

async function fetchRecentToots(
  client: mastodon.rest.Client,
  count: number
): Promise<TootInfo[]> {
  console.log(`Fetching ${count} recent toots...`);

  const account = await client.v1.accounts.verifyCredentials();
  console.log(`Account: @${account.acct}`);

  const statuses = await client.v1.accounts.$select(account.id).statuses.list({
    limit: Math.min(count, 40), // Mastodon max per request
    excludeReplies: true, // Only get original toots, not replies
    excludeReblogs: true,
  });

  // If we need more, paginate
  let allStatuses = [...statuses];
  while (allStatuses.length < count && statuses.length === 40) {
    await sleep(RATE_LIMIT_DELAY_MS);
    const lastId = allStatuses[allStatuses.length - 1].id;
    const moreStatuses = await client.v1.accounts.$select(account.id).statuses.list({
      limit: Math.min(count - allStatuses.length, 40),
      maxId: lastId,
      excludeReplies: true,
      excludeReblogs: true,
    });
    allStatuses = [...allStatuses, ...moreStatuses];
    if (moreStatuses.length === 0) break;
  }

  return allStatuses.slice(0, count).map((status) => ({
    id: status.id,
    content: status.content,
    plainText: stripHtml(status.content),
    createdAt: new Date(status.createdAt),
    url: status.url || `https://mastodon.social/@${account.acct}/${status.id}`,
    favouritesCount: status.favouritesCount || 0,
    reblogsCount: status.reblogsCount || 0,
    repliesCount: status.repliesCount || 0,
  }));
}

function findDuplicateClusters(
  toots: TootInfo[],
  threshold: number
): TootCluster[] {
  console.log(`\nAnalyzing ${toots.length} toots for duplicates (threshold: ${threshold})...`);

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

  // Compare all pairs
  const similarities: { i: number; j: number; score: number }[] = [];

  for (let i = 0; i < toots.length; i++) {
    const headlineI = extractHeadline(toots[i].plainText);
    const tokensI = tokenize(headlineI);

    for (let j = i + 1; j < toots.length; j++) {
      const headlineJ = extractHeadline(toots[j].plainText);
      const tokensJ = tokenize(headlineJ);

      const score = jaccardSimilarity(tokensI, tokensJ);

      if (score >= threshold) {
        // Also check time proximity (within 24 hours)
        const timeDiffHours = Math.abs(
          toots[i].createdAt.getTime() - toots[j].createdAt.getTime()
        ) / (1000 * 60 * 60);

        if (timeDiffHours <= 24) {
          union(i, j);
          similarities.push({ i, j, score });
        }
      }
    }
  }

  // Group by cluster
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
    indices.sort((a, b) => toots[a].createdAt.getTime() - toots[b].createdAt.getTime());

    // SAFETY CHECK: Skip entire cluster if ANY toot has interactions
    const clusterToots = indices.map((i) => toots[i]);
    const tootsWithInteractions = clusterToots.filter(hasInteractions);

    if (tootsWithInteractions.length > 0) {
      console.log(`  Skipping cluster - ${tootsWithInteractions.length} toot(s) have interactions:`);
      for (const t of tootsWithInteractions) {
        console.log(`    "${t.plainText.slice(0, 50)}..." (${t.favouritesCount} favs, ${t.reblogsCount} boosts, ${t.repliesCount} replies)`);
      }
      continue;
    }

    const primaryIdx = indices[0];
    const duplicateIndices = indices.slice(1);

    // Calculate average similarity within cluster
    let totalSim = 0;
    let simCount = 0;
    for (const sim of similarities) {
      if (indices.includes(sim.i) && indices.includes(sim.j)) {
        totalSim += sim.score;
        simCount++;
      }
    }

    result.push({
      primary: toots[primaryIdx],
      duplicates: duplicateIndices.map((i) => toots[i]),
      similarity: simCount > 0 ? totalSim / simCount : 0,
    });
  }

  return result;
}

async function fixCluster(
  client: mastodon.rest.Client,
  cluster: TootCluster,
  dryRun: boolean
): Promise<boolean> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`PRIMARY (keeping): ${cluster.primary.plainText.slice(0, 80)}...`);
  console.log(`  URL: ${cluster.primary.url}`);
  console.log(`  Posted: ${cluster.primary.createdAt.toISOString()}`);

  for (const dup of cluster.duplicates) {
    console.log(`\nDUPLICATE (will convert to reply):`);
    console.log(`  ${dup.plainText.slice(0, 80)}...`);
    console.log(`  URL: ${dup.url}`);
    console.log(`  Posted: ${dup.createdAt.toISOString()}`);
  }

  console.log(`\nSimilarity score: ${(cluster.similarity * 100).toFixed(1)}%`);

  if (dryRun) {
    console.log(`[DRY RUN] Would delete ${cluster.duplicates.length} toots and re-post as replies`);
    return true;
  }

  // First, re-verify that primary toot still has no interactions
  console.log(`  Re-checking primary toot for interactions...`);
  try {
    const freshPrimary = await client.v1.statuses.$select(cluster.primary.id).fetch();
    await sleep(RATE_LIMIT_DELAY_MS);

    if ((freshPrimary.favouritesCount || 0) > 0 ||
        (freshPrimary.reblogsCount || 0) > 0 ||
        (freshPrimary.repliesCount || 0) > 0) {
      console.log(`  ABORT: Primary toot now has interactions - skipping entire cluster`);
      return true; // Return true to not retry
    }
  } catch (err: any) {
    console.error(`  Failed to verify primary: ${err.message}`);
    return false;
  }

  // For each duplicate: delete and re-post as reply to primary
  for (const dup of cluster.duplicates) {
    try {
      // Re-verify this duplicate has no interactions before deleting
      console.log(`  Re-checking ${dup.id} for interactions...`);
      const freshDup = await client.v1.statuses.$select(dup.id).fetch();
      await sleep(RATE_LIMIT_DELAY_MS);

      if ((freshDup.favouritesCount || 0) > 0 ||
          (freshDup.reblogsCount || 0) > 0 ||
          (freshDup.repliesCount || 0) > 0) {
        console.log(`  Skipping ${dup.id} - now has interactions (${freshDup.favouritesCount} favs, ${freshDup.reblogsCount} boosts, ${freshDup.repliesCount} replies)`);
        continue;
      }

      // Extract links from the duplicate toot for the reply
      const linkMatch = dup.plainText.match(/https?:\/\/\S+/g);
      const links = linkMatch ? linkMatch.filter(l => !l.includes("mastodon")) : [];

      if (links.length === 0) {
        console.log(`  Skipping ${dup.id} - no news links found`);
        continue;
      }

      // Build reply text
      const replyText = `Update:\n${links.slice(0, 2).join("\n")}`;

      console.log(`  Deleting toot ${dup.id}...`);
      await client.v1.statuses.$select(dup.id).remove();
      await sleep(RATE_LIMIT_DELAY_MS);

      console.log(`  Creating reply to ${cluster.primary.id}...`);
      await client.v1.statuses.create({
        status: replyText,
        inReplyToId: cluster.primary.id,
        visibility: "public",
        language: "de",
      });
      await sleep(RATE_LIMIT_DELAY_MS);

      console.log(`  Done!`);
    } catch (err: any) {
      if (err.statusCode === 429) {
        console.error(`\nRATE LIMITED! Waiting 30 minutes...`);
        await sleep(BATCH_PAUSE_MS);
        return false; // Signal to retry
      }
      console.error(`  Error processing ${dup.id}: ${err.message}`);
    }
  }

  return true;
}

async function main(): Promise<void> {
  // Parse arguments
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  let count = 50;
  let threshold = 0.35;

  for (const arg of args) {
    if (arg.startsWith("--count=")) {
      count = parseInt(arg.split("=")[1], 10);
    }
    if (arg.startsWith("--threshold=")) {
      threshold = parseFloat(arg.split("=")[1]);
    }
  }

  console.log("=".repeat(60));
  console.log("FIX DUPLICATE TOOTS SCRIPT");
  console.log("=".repeat(60));
  console.log(`Mode: ${dryRun ? "DRY RUN (no changes)" : "LIVE (will modify toots)"}`);
  console.log(`Analyzing: ${count} recent toots`);
  console.log(`Similarity threshold: ${threshold}`);
  console.log("");

  if (!dryRun) {
    console.log("WARNING: This will DELETE toots and re-post them as replies!");
    console.log("Press Ctrl+C within 5 seconds to cancel...\n");
    await sleep(5000);
  }

  const client = await getInstance();

  // Fetch recent toots
  const toots = await fetchRecentToots(client, count);
  console.log(`Fetched ${toots.length} toots`);

  // Find duplicate clusters
  const clusters = findDuplicateClusters(toots, threshold);

  if (clusters.length === 0) {
    console.log("\nNo duplicate clusters found! All toots appear to be unique.");
    return;
  }

  console.log(`\nFound ${clusters.length} clusters of duplicate toots:`);

  let totalDuplicates = 0;
  for (const cluster of clusters) {
    totalDuplicates += cluster.duplicates.length;
  }
  console.log(`Total toots to convert to replies: ${totalDuplicates}`);

  // Process each cluster
  for (let i = 0; i < clusters.length; i++) {
    console.log(`\n\nProcessing cluster ${i + 1}/${clusters.length}...`);

    let success = false;
    let retries = 0;

    while (!success && retries < 3) {
      success = await fixCluster(client, clusters[i], dryRun);
      if (!success) {
        retries++;
        console.log(`Retry ${retries}/3...`);
      }
    }

    if (!success) {
      console.error(`Failed to process cluster after 3 retries, skipping`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("COMPLETE");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
