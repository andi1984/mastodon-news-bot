/**
 * Cleanup script: Find and delete quote toots that:
 * 1. Quote another toot with the same link(s)
 * 2. Have no interactions (no likes, boosts, replies)
 *
 * Usage: npx tsx scripts/cleanup-duplicate-quotes.ts [--dry-run] [--pages=N]
 *
 * Options:
 *   --dry-run    Show what would be deleted without deleting
 *   --pages=N    Number of pages to fetch (40 toots/page, default 50 = 2000 toots)
 */

import "dotenv/config";
import getInstance from "../src/helper/login.js";

const DRY_RUN = process.argv.includes("--dry-run");
const MAX_PAGES = parseInt(process.argv.find(a => a.startsWith("--pages="))?.split("=")[1] || "50", 10);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let retries = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.statusCode === 429 || err?.message?.includes("429") || err?.message?.includes("Too Many")) {
        retries++;
        const waitTime = Math.min(60000, 5000 * retries); // 5s, 10s, 15s... up to 60s
        console.log(`Rate limited on ${label}, waiting ${waitTime / 1000}s (retry ${retries})...`);
        await sleep(waitTime);
      } else {
        throw err;
      }
    }
  }
}

// Extract URLs from toot content
function extractLinks(content: string | undefined | null): Set<string> {
  const links = new Set<string>();
  if (!content) return links;

  // Match URLs in href attributes (Mastodon wraps links in <a> tags)
  const hrefMatches = content.matchAll(/href="([^"]+)"/g);
  for (const match of hrefMatches) {
    const url = match[1];
    // Skip Mastodon internal links (hashtags, mentions)
    if (!url.includes("/tags/") && !url.includes("/@")) {
      links.add(url);
    }
  }
  return links;
}

// Check if two sets have any overlap
function hasOverlap(setA: Set<string>, setB: Set<string>): boolean {
  for (const item of setA) {
    if (setB.has(item)) return true;
  }
  return false;
}

async function main() {
  console.log(DRY_RUN ? "=== DRY RUN MODE ===" : "=== LIVE MODE ===");
  console.log(`Checking up to ${MAX_PAGES * 40} toots (${MAX_PAGES} pages)...\n`);

  const client = await getInstance();

  // Get account info
  const account = await withRetry(
    () => client.v1.accounts.verifyCredentials(),
    "verifyCredentials"
  );
  console.log(`Account: @${account.username} (${account.id})`);

  // Fetch recent statuses (paginate to get more)
  let toDelete: { id: string; content: string; quotedContent: string }[] = [];
  let maxId: string | undefined;
  let totalChecked = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const statuses = await withRetry(
      () => client.v1.accounts.$select(account.id).statuses.list({
        limit: 40,
        maxId,
      }),
      `page ${page + 1}`
    );

    // Small delay between pages to be nice to the server
    if (page > 0) await sleep(500);

    if (statuses.length === 0) break;

    for (const status of statuses) {
      totalChecked++;

      // Debug: check what properties exist for quotes
      const statusAny = status as any;
      if (statusAny.quote || statusAny.reblog || statusAny.quotedStatus || statusAny.quoted_status) {
        console.log(`DEBUG status ${status.id}:`, {
          hasQuote: !!statusAny.quote,
          hasQuotedStatus: !!statusAny.quotedStatus,
          hasQuoted_status: !!statusAny.quoted_status,
          hasReblog: !!statusAny.reblog,
          content: status.content?.slice(0, 100),
        });
      }

      // Check if this is a quote (try different property names)
      // The structure is: status.quote.quotedStatus (nested)
      const quoteWrapper = statusAny.quote;
      if (!quoteWrapper) continue;

      const quote = quoteWrapper.quotedStatus || quoteWrapper;
      if (!quote || !quote.content) continue;

      console.log(`Found quote: ${status.id}`);
      console.log(`  Quote content preview: ${quote.content?.slice(0, 150)}`);

      // Extract links from both posts
      const statusLinks = extractLinks(status.content);
      const quoteLinks = extractLinks(quote.content);

      console.log(`  Status links: ${[...statusLinks].join(", ") || "(none)"}`);
      console.log(`  Quote links: ${[...quoteLinks].join(", ") || "(none)"}`);

      // Skip if either has no links
      if (statusLinks.size === 0 || quoteLinks.size === 0) {
        console.log(`  -> Skipping: missing links`);
        continue;
      }

      // Check for overlapping links
      if (!hasOverlap(statusLinks, quoteLinks)) {
        console.log(`  -> Skipping: no overlap`);
        continue;
      }

      console.log(`  -> MATCH! Checking interactions...`);

      // Check for interactions
      const hasInteractions =
        status.favouritesCount > 0 ||
        status.reblogsCount > 0 ||
        status.repliesCount > 0;

      if (hasInteractions) {
        console.log(
          `SKIP (has interactions): ${status.id} - ${status.favouritesCount} likes, ${status.reblogsCount} boosts, ${status.repliesCount} replies`
        );
        continue;
      }

      // Found a candidate for deletion
      const statusPreview = (status.content || "")
        .replace(/<[^>]+>/g, "")
        .slice(0, 80);
      const quotePreview = (quote.content || "").replace(/<[^>]+>/g, "").slice(0, 80);

      toDelete.push({
        id: status.id,
        content: statusPreview,
        quotedContent: quotePreview,
      });

      console.log(`FOUND: ${status.id}`);
      console.log(`  Quote: ${statusPreview}...`);
      console.log(`  Original: ${quotePreview}...`);
      console.log(`  Shared links: ${[...statusLinks].filter((l) => quoteLinks.has(l)).join(", ")}`);
      console.log();
    }

    maxId = statuses[statuses.length - 1].id;
  }

  console.log(`\nChecked ${totalChecked} toots`);
  console.log(`Found ${toDelete.length} duplicate quotes with no interactions\n`);

  if (toDelete.length === 0) {
    console.log("Nothing to delete!");
    return;
  }

  if (DRY_RUN) {
    console.log("Dry run - no deletions performed.");
    console.log("Run without --dry-run to delete these toots.");
    return;
  }

  // Confirm before deleting
  console.log("Deleting...\n");

  let deleted = 0;
  for (const toot of toDelete) {
    try {
      await withRetry(
        () => client.v1.statuses.$select(toot.id).remove(),
        `delete ${toot.id}`
      );
      console.log(`Deleted: ${toot.id}`);
      deleted++;
      // Rate limit protection
      await sleep(1500);
    } catch (err) {
      console.error(`Failed to delete ${toot.id}: ${err}`);
    }
  }

  console.log(`\nDeleted ${deleted}/${toDelete.length} toots`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
