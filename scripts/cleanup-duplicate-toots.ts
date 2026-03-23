/**
 * Cleanup script: Find and delete duplicate toots
 *
 * Detects duplicates by:
 * 1. Exact content match (after stripping HTML)
 * 2. Same external links
 * 3. High content similarity (fuzzy matching)
 *
 * Keeps the toot with:
 * - Most interactions (likes + boosts + replies)
 * - If equal, keeps the oldest one
 *
 * Usage: npx tsx scripts/cleanup-duplicate-toots.ts [options]
 *
 * Options:
 *   --dry-run         Show what would be deleted without deleting
 *   --limit=N         Number of toots to check (default: 500)
 *   --similarity=N    Similarity threshold 0-1 for fuzzy matching (default: 0.9)
 *   --include-boosts  Include reblogged toots in check (default: exclude)
 *   --verbose         Show detailed output
 */

import "dotenv/config";
import getInstance from "../src/helper/login.js";
import type { mastodon } from "masto";

// Parse CLI arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const VERBOSE = args.includes("--verbose");
const INCLUDE_BOOSTS = args.includes("--include-boosts");
const LIMIT = parseInt(
  args.find((a) => a.startsWith("--limit="))?.split("=")[1] || "500",
  10
);
const SIMILARITY_THRESHOLD = parseFloat(
  args.find((a) => a.startsWith("--similarity="))?.split("=")[1] || "0.9"
);

// Rate limiting config
const INITIAL_RETRY_DELAY = 5000; // 5 seconds
const MAX_RETRY_DELAY = 120000; // 2 minutes
const MAX_RETRIES = 10;
const REQUEST_DELAY = 500; // Delay between requests

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Execute a function with exponential backoff retry on rate limit
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = MAX_RETRIES
): Promise<T> {
  let retries = 0;
  let delay = INITIAL_RETRY_DELAY;

  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; message?: string };
      const isRateLimit =
        error?.statusCode === 429 ||
        error?.message?.includes("429") ||
        error?.message?.includes("Too Many") ||
        error?.message?.includes("rate limit");

      if (isRateLimit && retries < maxRetries) {
        retries++;
        console.log(
          `Rate limited on ${label}, waiting ${delay / 1000}s (retry ${retries}/${maxRetries})...`
        );
        await sleep(delay);
        delay = Math.min(MAX_RETRY_DELAY, delay * 2); // Exponential backoff
      } else if (retries >= maxRetries) {
        throw new Error(
          `Max retries (${maxRetries}) exceeded for ${label}: ${error?.message}`
        );
      } else {
        throw err;
      }
    }
  }
}

/**
 * Strip HTML tags and normalize whitespace
 */
function normalizeContent(html: string | undefined | null): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n") // Preserve line breaks
    .replace(/<[^>]+>/g, "") // Strip HTML tags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim()
    .toLowerCase();
}

/**
 * Extract external URLs from HTML content
 */
function extractLinks(html: string | undefined | null): Set<string> {
  const links = new Set<string>();
  if (!html) return links;

  // Match URLs in href attributes
  const hrefMatches = html.matchAll(/href="([^"]+)"/g);
  for (const match of hrefMatches) {
    const url = match[1];
    // Skip internal Mastodon links (hashtags, mentions, instance URLs)
    if (
      !url.includes("/tags/") &&
      !url.includes("/@") &&
      !url.match(/https?:\/\/[^/]+\/?$/) // Skip bare domain links
    ) {
      // Normalize URL (remove tracking params, etc.)
      try {
        const parsed = new URL(url);
        // Remove common tracking parameters
        ["utm_source", "utm_medium", "utm_campaign", "ref", "source"].forEach(
          (p) => parsed.searchParams.delete(p)
        );
        links.add(parsed.toString());
      } catch {
        links.add(url); // Keep as-is if URL parsing fails
      }
    }
  }
  return links;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1 // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate similarity score between two strings (0-1)
 */
function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const maxLength = Math.max(a.length, b.length);
  const distance = levenshteinDistance(a, b);
  return 1 - distance / maxLength;
}

/**
 * Check if two sets have any overlapping elements
 */
function hasOverlap<T>(setA: Set<T>, setB: Set<T>): boolean {
  for (const item of setA) {
    if (setB.has(item)) return true;
  }
  return false;
}

/**
 * Calculate interaction score for a status
 */
function getInteractionScore(status: mastodon.v1.Status): number {
  return (
    (status.favouritesCount || 0) +
    (status.reblogsCount || 0) * 2 + // Weight boosts more
    (status.repliesCount || 0) * 1.5 // Weight replies
  );
}

interface DuplicateGroup {
  canonical: mastodon.v1.Status; // The one to keep
  duplicates: mastodon.v1.Status[]; // The ones to delete
  reason: string;
}

async function main() {
  console.log("=== Duplicate Toot Cleanup ===");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Checking: ${LIMIT} toots`);
  console.log(`Similarity threshold: ${SIMILARITY_THRESHOLD}`);
  console.log(`Include boosts: ${INCLUDE_BOOSTS}`);
  console.log();

  const client = await getInstance();

  // Get account info
  const account = await withRetry(
    () => client.v1.accounts.verifyCredentials(),
    "verifyCredentials"
  );
  console.log(`Logged in as: @${account.username} (${account.id})\n`);

  // Fetch statuses
  console.log("Fetching toots...");
  const allStatuses: mastodon.v1.Status[] = [];
  let maxId: string | undefined;
  const pageSize = 40;

  while (allStatuses.length < LIMIT) {
    const statuses = await withRetry(
      () =>
        client.v1.accounts.$select(account.id).statuses.list({
          limit: pageSize,
          maxId,
          excludeReblogs: !INCLUDE_BOOSTS,
        }),
      `fetch page (offset ${allStatuses.length})`
    );

    if (statuses.length === 0) break;

    allStatuses.push(...statuses);
    maxId = statuses[statuses.length - 1].id;

    if (VERBOSE) {
      console.log(`  Fetched ${allStatuses.length} toots...`);
    }

    await sleep(REQUEST_DELAY);
  }

  console.log(`Fetched ${allStatuses.length} toots\n`);

  // Build lookup maps
  const contentMap = new Map<string, mastodon.v1.Status[]>(); // normalized content -> statuses
  const linkMap = new Map<string, mastodon.v1.Status[]>(); // link -> statuses

  for (const status of allStatuses) {
    // Group by content
    const normalizedContent = normalizeContent(status.content);
    if (normalizedContent.length > 20) {
      // Skip very short toots
      const existing = contentMap.get(normalizedContent) || [];
      existing.push(status);
      contentMap.set(normalizedContent, existing);
    }

    // Group by links
    const links = extractLinks(status.content);
    for (const link of links) {
      const existing = linkMap.get(link) || [];
      existing.push(status);
      linkMap.set(link, existing);
    }
  }

  // Find duplicates
  const duplicateGroups: DuplicateGroup[] = [];
  const processedIds = new Set<string>();

  // 1. Find exact content duplicates
  console.log("Checking for exact content duplicates...");
  for (const [content, statuses] of contentMap) {
    if (statuses.length > 1) {
      // Sort by interaction score (highest first), then by date (oldest first)
      statuses.sort((a, b) => {
        const scoreDiff = getInteractionScore(b) - getInteractionScore(a);
        if (scoreDiff !== 0) return scoreDiff;
        return (
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
      });

      const canonical = statuses[0];
      const duplicates = statuses.slice(1);

      // Mark all as processed
      statuses.forEach((s) => processedIds.add(s.id));

      duplicateGroups.push({
        canonical,
        duplicates,
        reason: "exact content match",
      });

      if (VERBOSE) {
        console.log(`  Found ${statuses.length} toots with same content:`);
        console.log(`    "${content.slice(0, 60)}..."`);
      }
    }
  }

  // 2. Find duplicate links (toots sharing the same link)
  console.log("Checking for duplicate links...");
  for (const [link, statuses] of linkMap) {
    // Filter out already processed
    const unprocessed = statuses.filter((s) => !processedIds.has(s.id));
    if (unprocessed.length > 1) {
      // Sort by interaction score, then date
      unprocessed.sort((a, b) => {
        const scoreDiff = getInteractionScore(b) - getInteractionScore(a);
        if (scoreDiff !== 0) return scoreDiff;
        return (
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
      });

      const canonical = unprocessed[0];
      const duplicates = unprocessed.slice(1);

      // Mark all as processed
      unprocessed.forEach((s) => processedIds.add(s.id));

      duplicateGroups.push({
        canonical,
        duplicates,
        reason: `same link: ${link.slice(0, 50)}...`,
      });

      if (VERBOSE) {
        console.log(`  Found ${unprocessed.length} toots with same link:`);
        console.log(`    ${link}`);
      }
    }
  }

  // 3. Find similar content (fuzzy matching) - more expensive, do last
  console.log("Checking for similar content (fuzzy matching)...");
  const unprocessedStatuses = allStatuses.filter(
    (s) => !processedIds.has(s.id)
  );

  for (let i = 0; i < unprocessedStatuses.length; i++) {
    const statusA = unprocessedStatuses[i];
    if (processedIds.has(statusA.id)) continue;

    const contentA = normalizeContent(statusA.content);
    if (contentA.length < 50) continue; // Skip short content for fuzzy matching

    const similarGroup: mastodon.v1.Status[] = [statusA];

    for (let j = i + 1; j < unprocessedStatuses.length; j++) {
      const statusB = unprocessedStatuses[j];
      if (processedIds.has(statusB.id)) continue;

      const contentB = normalizeContent(statusB.content);
      if (contentB.length < 50) continue;

      const similarity = calculateSimilarity(contentA, contentB);
      if (similarity >= SIMILARITY_THRESHOLD) {
        similarGroup.push(statusB);
        if (VERBOSE) {
          console.log(
            `  Found similar pair (${(similarity * 100).toFixed(1)}% match)`
          );
        }
      }
    }

    if (similarGroup.length > 1) {
      // Sort and pick canonical
      similarGroup.sort((a, b) => {
        const scoreDiff = getInteractionScore(b) - getInteractionScore(a);
        if (scoreDiff !== 0) return scoreDiff;
        return (
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
      });

      const canonical = similarGroup[0];
      const duplicates = similarGroup.slice(1);

      similarGroup.forEach((s) => processedIds.add(s.id));

      duplicateGroups.push({
        canonical,
        duplicates,
        reason: `similar content (${SIMILARITY_THRESHOLD * 100}%+ match)`,
      });
    }
  }

  // Summary
  const totalDuplicates = duplicateGroups.reduce(
    (sum, g) => sum + g.duplicates.length,
    0
  );

  console.log("\n=== Results ===");
  console.log(`Found ${duplicateGroups.length} groups of duplicates`);
  console.log(`Total toots to delete: ${totalDuplicates}\n`);

  if (duplicateGroups.length === 0) {
    console.log("No duplicates found!");
    return;
  }

  // Show details
  for (const group of duplicateGroups) {
    const canonicalPreview = normalizeContent(group.canonical.content).slice(
      0,
      60
    );
    console.log(`\nGroup (${group.reason}):`);
    console.log(
      `  KEEP: ${group.canonical.id} (score: ${getInteractionScore(group.canonical)}) "${canonicalPreview}..."`
    );
    for (const dup of group.duplicates) {
      const dupPreview = normalizeContent(dup.content).slice(0, 60);
      console.log(
        `  DELETE: ${dup.id} (score: ${getInteractionScore(dup)}) "${dupPreview}..."`
      );
    }
  }

  if (DRY_RUN) {
    console.log("\n=== DRY RUN - No deletions performed ===");
    console.log("Run without --dry-run to delete duplicates.");
    return;
  }

  // Delete duplicates
  console.log("\n=== Deleting duplicates ===");
  let deleted = 0;
  let failed = 0;
  let skipped = 0;
  let rateLimited = false;

  outerLoop: for (const group of duplicateGroups) {
    for (const duplicate of group.duplicates) {
      try {
        // Re-fetch to verify current interaction count (safety check)
        const fresh = await withRetry(
          () => client.v1.statuses.$select(duplicate.id).fetch(),
          `verify ${duplicate.id}`
        );

        // Only delete if absolutely no interactions
        if (getInteractionScore(fresh) > 0) {
          console.log(`Skipped (has interactions): ${duplicate.id}`);
          skipped++;
          continue;
        }

        await withRetry(
          () => client.v1.statuses.$select(duplicate.id).remove(),
          `delete ${duplicate.id}`
        );
        console.log(`Deleted: ${duplicate.id}`);
        deleted++;
        await sleep(1500); // Be nice to the server
      } catch (err: unknown) {
        const error = err as { message?: string };
        // Stop entirely on rate limit exhaustion
        if (error?.message?.includes("Max retries")) {
          console.error(`\nRate limit exhausted, stopping.`);
          rateLimited = true;
          break outerLoop;
        }
        console.error(`Failed to delete ${duplicate.id}:`, err);
        failed++;
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Deleted: ${deleted}`);
  console.log(`Skipped (has interactions): ${skipped}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total processed: ${deleted + skipped + failed}/${totalDuplicates}`);

  if (rateLimited) {
    console.log(`\nNote: Stopped early due to rate limiting.`);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
