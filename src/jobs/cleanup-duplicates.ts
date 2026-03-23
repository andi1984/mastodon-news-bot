/**
 * Cleanup job: Find and delete duplicate toots
 *
 * Safety guards for idempotency:
 * 1. Only deletes exact content duplicates (no fuzzy matching in automated mode)
 * 2. Requires minimum age (5 minutes) to avoid race conditions with feed-tooter
 * 3. Skips toots with any interactions (likes, boosts, replies)
 * 4. Keeps the oldest toot in each duplicate group
 * 5. Logs all deletions for audit
 *
 * Runs every 31 minutes via Bree scheduler
 */

import "dotenv/config";
import { parentPort } from "node:worker_threads";
import process from "node:process";
import getInstance from "../helper/login.js";
import type { mastodon } from "masto";

// Configuration
const LIMIT = 200; // Check last 200 toots
const MIN_AGE_MINUTES = 5; // Only consider toots older than 5 minutes
const REQUEST_DELAY = 500; // Delay between API requests
const DELETE_DELAY = 1500; // Delay between deletions

// Rate limiting
const INITIAL_RETRY_DELAY = 5000;
const MAX_RETRY_DELAY = 120000;
const MAX_RETRIES = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Execute with exponential backoff retry on rate limit
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
          `[cleanup-duplicates] Rate limited on ${label}, waiting ${delay / 1000}s (retry ${retries}/${maxRetries})...`
        );
        await sleep(delay);
        delay = Math.min(MAX_RETRY_DELAY, delay * 2);
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
 * Strip HTML and normalize content for comparison
 */
function normalizeContent(html: string | undefined | null): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Check if a toot is old enough to be considered for cleanup
 */
function isOldEnough(status: mastodon.v1.Status): boolean {
  const createdAt = new Date(status.createdAt);
  const minAge = new Date(Date.now() - MIN_AGE_MINUTES * 60 * 1000);
  return createdAt < minAge;
}

/**
 * Check if a toot has any interactions (should be preserved)
 */
function hasInteractions(status: mastodon.v1.Status): boolean {
  return (
    (status.favouritesCount || 0) > 0 ||
    (status.reblogsCount || 0) > 0 ||
    (status.repliesCount || 0) > 0
  );
}

interface DuplicateGroup {
  keep: mastodon.v1.Status;
  remove: mastodon.v1.Status[];
}

async function findAndCleanDuplicates(): Promise<{
  checked: number;
  groups: number;
  deleted: number;
  skipped: number;
  failed: number;
}> {
  const client = await getInstance();

  // Get account info
  const account = await withRetry(
    () => client.v1.accounts.verifyCredentials(),
    "verifyCredentials"
  );

  // Fetch recent statuses using async iterator
  const allStatuses: mastodon.v1.Status[] = [];
  const pageSize = 40;

  try {
    for await (const statuses of client.v1.accounts.$select(account.id).statuses.list({
      limit: pageSize,
      excludeReblogs: true, // Never include boosts
    })) {
      allStatuses.push(...statuses);

      if (allStatuses.length >= LIMIT) break;

      await sleep(REQUEST_DELAY);
    }
  } catch (err: unknown) {
    const error = err as { statusCode?: number; message?: string };
    if (error?.statusCode === 429 || error?.message?.includes("429")) {
      console.log(`[cleanup-duplicates] Rate limited while fetching, proceeding with ${allStatuses.length} toots`);
    } else {
      throw err;
    }
  }

  // Group by normalized content
  const contentMap = new Map<string, mastodon.v1.Status[]>();

  for (const status of allStatuses) {
    // Skip replies (different context)
    if (status.inReplyToId) continue;

    // Skip recent toots (avoid race conditions)
    if (!isOldEnough(status)) continue;

    const normalized = normalizeContent(status.content);
    // Skip very short content (likely different context)
    if (normalized.length < 30) continue;

    const existing = contentMap.get(normalized) || [];
    existing.push(status);
    contentMap.set(normalized, existing);
  }

  // Find duplicate groups
  const duplicateGroups: DuplicateGroup[] = [];

  for (const [, statuses] of contentMap) {
    if (statuses.length <= 1) continue;

    // Sort by date (oldest first - we keep the oldest)
    statuses.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    const keep = statuses[0];
    const remove = statuses.slice(1).filter((s) => !hasInteractions(s));

    if (remove.length > 0) {
      duplicateGroups.push({ keep, remove });
    }
  }

  // Delete duplicates
  let deleted = 0;
  let skipped = 0;
  let failed = 0;

  outerLoop: for (const group of duplicateGroups) {
    const preview = normalizeContent(group.keep.content).slice(0, 50);
    console.log(
      `[cleanup-duplicates] Group: "${preview}..." (keeping ${group.keep.id}, removing ${group.remove.length})`
    );

    for (const duplicate of group.remove) {
      // Double-check: re-verify no interactions before deletion
      try {
        const fresh = await withRetry(
          () => client.v1.statuses.$select(duplicate.id).fetch(),
          `verify ${duplicate.id}`
        );

        if (hasInteractions(fresh)) {
          console.log(
            `[cleanup-duplicates] Skipping ${duplicate.id} - gained interactions`
          );
          skipped++;
          continue;
        }

        await withRetry(
          () => client.v1.statuses.$select(duplicate.id).remove(),
          `delete ${duplicate.id}`
        );

        console.log(`[cleanup-duplicates] Deleted: ${duplicate.id}`);
        deleted++;

        await sleep(DELETE_DELAY);
      } catch (err: unknown) {
        const error = err as { message?: string };
        // Stop entirely on rate limit exhaustion
        if (error?.message?.includes("Max retries")) {
          console.error(`[cleanup-duplicates] Rate limit exhausted, stopping.`);
          break outerLoop;
        }
        console.error(`[cleanup-duplicates] Failed to delete ${duplicate.id}:`, err);
        failed++;
      }
    }
  }

  return {
    checked: allStatuses.length,
    groups: duplicateGroups.length,
    deleted,
    skipped,
    failed,
  };
}

(async () => {
  console.log("[cleanup-duplicates] Starting duplicate toot cleanup...");

  try {
    const stats = await findAndCleanDuplicates();

    console.log(`[cleanup-duplicates] Complete:`);
    console.log(`  Checked: ${stats.checked} toots`);
    console.log(`  Found: ${stats.groups} duplicate groups`);
    console.log(`  Deleted: ${stats.deleted}`);
    console.log(`  Skipped (has interactions): ${stats.skipped}`);
    console.log(`  Failed: ${stats.failed}`);

    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
  } catch (err) {
    console.error("[cleanup-duplicates] Fatal error:", err);
    // Exit with error code on failure (including rate limit exhaustion)
    if (parentPort) parentPort.postMessage("done");
    else process.exit(1);
  }
})();
