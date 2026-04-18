/**
 * Read-only diagnostic for the two verbraucherzentrale-saarland URLs that
 * keep getting re-tooted. Prints:
 *   - rows in `news` whose data.link matches either URL
 *   - rows in `tooted_hashes` whose hash matches either URL's computed hash
 *
 * Usage:
 *   npm run inspect-duplicate-urls
 *   npx tsx src/scripts/inspect-duplicate-urls.ts
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
  tooted: boolean | null;
  pub_date: string | null;
  created_at: string | null;
  data: { title?: string; link?: string; [k: string]: any } | null;
};

async function findTitlesFromFeed(): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  console.log(`\nFetching live feed: ${FEED_URL}`);
  const rss = await getFeed(FEED_URL);
  if (!rss) {
    console.log("  (feed fetch failed; will fall back to DB titles where possible)");
    return titles;
  }
  for (const item of rss.items ?? []) {
    if (item.link && TARGET_URLS.includes(item.link)) {
      titles.set(item.link, item.title ?? "");
    }
  }
  for (const url of TARGET_URLS) {
    const marker = titles.has(url) ? "present" : "missing";
    console.log(`  ${marker}: ${url}`);
    if (titles.has(url)) console.log(`    title: "${titles.get(url)}"`);
  }
  return titles;
}

async function findNewsRows(
  db: ReturnType<typeof createClient>
): Promise<NewsRow[]> {
  // JSONB `data->>'link'` lookup via Supabase .filter
  const rows: NewsRow[] = [];
  for (const url of TARGET_URLS) {
    const { data, error } = await db
      .from("news")
      .select("id, hash, tooted, pub_date, created_at, data")
      .filter("data->>link", "eq", url);
    if (error) {
      console.error(`news lookup error for ${url}: ${error.message}`);
      continue;
    }
    rows.push(...((data ?? []) as NewsRow[]));
  }
  return rows;
}

async function findTootedHashes(
  db: ReturnType<typeof createClient>,
  hashes: string[]
): Promise<string[]> {
  if (hashes.length === 0) return [];
  const { data, error } = await db
    .from("tooted_hashes")
    .select("hash")
    .in("hash", hashes);
  if (error) {
    console.error(`tooted_hashes lookup error: ${error.message}`);
    return [];
  }
  return (data ?? []).map((r: { hash: string }) => r.hash);
}

function computeHash(title: string, link: string): string {
  return `${sha256(FEED_URL)}-${sha256(title)}-${sha256(link)}`;
}

(async () => {
  console.log("=".repeat(70));
  console.log("INSPECT: verbraucherzentrale duplicate URLs");
  console.log("=".repeat(70));

  const db = createClient();

  // 1. Try to get current titles from the live feed
  const liveTitles = await findTitlesFromFeed();

  // 2. Look up any rows currently in `news` for these links
  console.log("\nLooking up `news` rows by data->>link ...");
  const newsRows = await findNewsRows(db);
  if (newsRows.length === 0) {
    console.log("  No matching rows in `news`.");
  } else {
    for (const row of newsRows) {
      console.log(`  id=${row.id}`);
      console.log(`    hash       = ${row.hash ?? "NULL"}`);
      console.log(`    tooted     = ${row.tooted}`);
      console.log(`    pub_date   = ${row.pub_date}`);
      console.log(`    created_at = ${row.created_at}`);
      console.log(`    title      = "${row.data?.title ?? ""}"`);
      console.log(`    link       = ${row.data?.link ?? ""}`);
    }
  }

  // 3. Compute expected hashes from (a) live feed titles, (b) DB titles,
  //    (c) each other when only one source is available.
  console.log("\nComputing expected hashes for each URL ...");
  const hashesByUrl = new Map<string, string[]>();
  for (const url of TARGET_URLS) {
    const candidates: { source: string; title: string }[] = [];
    const live = liveTitles.get(url);
    if (live) candidates.push({ source: "live-feed", title: live });
    for (const row of newsRows) {
      if (row.data?.link === url && row.data?.title) {
        candidates.push({ source: `news[${row.id}]`, title: row.data.title });
      }
    }
    if (candidates.length === 0) {
      console.log(`  ${url}: no title available from feed or DB`);
      continue;
    }
    const seen = new Set<string>();
    const hashes: string[] = [];
    for (const c of candidates) {
      const h = computeHash(c.title, url);
      if (seen.has(h)) continue;
      seen.add(h);
      hashes.push(h);
      console.log(`  ${url}`);
      console.log(`    from ${c.source}: title="${c.title}"`);
      console.log(`    → hash = ${h}`);
    }
    hashesByUrl.set(url, hashes);
  }

  // 4. Check which of the computed hashes are already in tooted_hashes
  const allHashes = Array.from(hashesByUrl.values()).flat();
  console.log(`\nChecking ${allHashes.length} hash(es) against tooted_hashes ...`);
  const foundHashes = new Set(await findTootedHashes(db, allHashes));
  for (const [url, hashes] of hashesByUrl) {
    const present = hashes.filter((h) => foundHashes.has(h));
    const missing = hashes.filter((h) => !foundHashes.has(h));
    console.log(`  ${url}`);
    console.log(`    present in tooted_hashes: ${present.length}/${hashes.length}`);
    if (missing.length > 0) {
      console.log(`    MISSING:`);
      for (const h of missing) console.log(`      ${h}`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("Interpretation:");
  console.log("  - If any expected hash is MISSING from tooted_hashes AND the URL");
  console.log("    is still present in the live feed, it will be re-ingested on");
  console.log("    the next grabber run.");
  console.log("  - Running the backfill script will fix this.");
  console.log("=".repeat(70));

  process.exit(0);
})().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
