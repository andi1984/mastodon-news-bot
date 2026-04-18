/**
 * One-shot remediation: persist dedup hashes for two specific
 * verbraucherzentrale-saarland URLs that the bot keeps re-tooting, and
 * purge any in-flight copies from the `news` table.
 *
 * Steps (in order):
 *   1. Fetch the live feed and collect every title that has ever been
 *      associated with each URL (live feed + any existing news rows).
 *   2. Compute the dedup hash for each (title, link) pair using the
 *      current feed-grabber scheme: sha256(feedURL) + "-" + sha256(title)
 *      + "-" + sha256(link).
 *   3. Upsert every computed hash into `tooted_hashes`.
 *   4. Delete any `news` rows whose data.link matches either URL.
 *
 * Usage:
 *   npm run backfill-dedup-hashes -- --dry-run
 *   npm run backfill-dedup-hashes
 *   npx tsx src/scripts/backfill-dedup-hashes.ts [--dry-run]
 */

import "dotenv/config";
import createClient from "../helper/db.js";
import { sha256 } from "../helper/hash.js";
import getFeed from "../helper/getFeed.js";

const FEED_URL = "https://www.verbraucherzentrale-saarland.de/wissen/feed";

const TARGET_URLS = [
  "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen",
  "https://www.verbraucherzentrale-saarland.de/wissen/geld-versicherungen/achtung-kreditfalle-betrug-mit-gefaelschten-postidentanfragen-118944",
];

type NewsRow = {
  id: string;
  hash: string | null;
  data: { title?: string; link?: string } | null;
};

function computeHash(title: string, link: string): string {
  return `${sha256(FEED_URL)}-${sha256(title)}-${sha256(link)}`;
}

async function collectTitles(
  db: ReturnType<typeof createClient>
): Promise<{ titlesByUrl: Map<string, Set<string>>; newsRows: NewsRow[] }> {
  const titlesByUrl = new Map<string, Set<string>>();
  for (const url of TARGET_URLS) titlesByUrl.set(url, new Set());

  // From the live feed
  const rss = await getFeed(FEED_URL);
  if (rss) {
    for (const item of rss.items ?? []) {
      if (item.link && titlesByUrl.has(item.link) && item.title) {
        titlesByUrl.get(item.link)!.add(item.title);
      }
    }
  } else {
    console.warn("Live feed fetch returned null; relying on DB titles only.");
  }

  // From any existing news rows
  const newsRows: NewsRow[] = [];
  for (const url of TARGET_URLS) {
    const { data, error } = await db
      .from("news")
      .select("id, hash, data")
      .filter("data->>link", "eq", url);
    if (error) {
      console.error(`news lookup error for ${url}: ${error.message}`);
      continue;
    }
    for (const row of (data ?? []) as NewsRow[]) {
      newsRows.push(row);
      const title = row.data?.title;
      if (title) titlesByUrl.get(url)!.add(title);
    }
  }

  return { titlesByUrl, newsRows };
}

(async () => {
  const dryRun = process.argv.includes("--dry-run");

  console.log("=".repeat(70));
  console.log("BACKFILL: verbraucherzentrale dedup hashes");
  console.log("=".repeat(70));
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Feed: ${FEED_URL}`);
  console.log(`URLs:`);
  for (const u of TARGET_URLS) console.log(`  ${u}`);

  const db = createClient();
  const { titlesByUrl, newsRows } = await collectTitles(db);

  // Compute hashes for every (title, link) pair we know about. Include
  // stored hashes verbatim so we catch any variant the grabber actually
  // computed historically.
  console.log("\nCollected titles per URL:");
  const hashRecords: { hash: string }[] = [];
  const seen = new Set<string>();
  for (const [url, titles] of titlesByUrl) {
    if (titles.size === 0) {
      console.log(`  ${url}: NO TITLES FOUND (will still purge news rows if any)`);
      continue;
    }
    console.log(`  ${url}`);
    for (const title of titles) {
      const h = computeHash(title, url);
      console.log(`    title "${title}"`);
      console.log(`      → hash ${h}`);
      if (!seen.has(h)) {
        seen.add(h);
        hashRecords.push({ hash: h });
      }
    }
  }

  // Also include any non-null hashes we found on `news` rows directly.
  for (const row of newsRows) {
    if (row.hash && !seen.has(row.hash)) {
      seen.add(row.hash);
      hashRecords.push({ hash: row.hash });
      console.log(`  (from news row ${row.id}) stored hash ${row.hash}`);
    }
  }

  console.log(
    `\nTotal unique hashes to upsert into tooted_hashes: ${hashRecords.length}`
  );
  console.log(`news rows to purge: ${newsRows.length}`);

  if (dryRun) {
    console.log("\n[DRY RUN] No changes made.");
    process.exit(0);
  }

  // 1. Upsert hashes FIRST. If this fails, bail before deleting anything.
  if (hashRecords.length > 0) {
    const { error } = await db
      .from("tooted_hashes")
      .upsert(hashRecords, { onConflict: "hash" });
    if (error) {
      console.error(`Upsert to tooted_hashes failed: ${error.message}`);
      console.error("Aborting before delete to avoid dedup-record leak.");
      process.exit(1);
    }
    console.log(`Upserted ${hashRecords.length} hash(es) into tooted_hashes.`);
  }

  // 2. Purge any `news` rows for these links.
  if (newsRows.length > 0) {
    const ids = newsRows.map((r) => r.id);
    const { error } = await db.from("news").delete().in("id", ids);
    if (error) {
      console.error(`Delete from news failed: ${error.message}`);
      process.exit(1);
    }
    console.log(`Deleted ${ids.length} row(s) from news.`);
  }

  console.log("\nBackfill complete.");
  process.exit(0);
})().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
