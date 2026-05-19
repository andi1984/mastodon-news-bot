import "dotenv/config";
import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");

import getFeed from "../helper/getFeed.js";
import {
  filterFeedItemsByAge,
  filterFeedItemsByKeywords,
} from "../helper/feedItemFilter.js";
import createClient from "../helper/db.js";
import { sha256 } from "../helper/hash.js";
import { normalizeUrl } from "../helper/normalizeUrl.js";
import {
  processNewArticles,
  ArticleForMatching,
} from "../helper/storyMatcher.js";

// Filter out articles older than this (in hours) - prevents ingesting stale feed items
const MAX_ARTICLE_AGE_HOURS = settings.min_freshness_hours || 24;

// Single supabase client (singleton) with retry/timeout built in
const supabase = createClient();

// Process feeds in parallel batches - increased for faster processing
const BATCH_SIZE = 8;

type CandidateRow = {
  hash: string;
  canonical_url: string | null;
  data: any;
  pub_date: string;
};

/**
 * Fetch a single feed and return candidate rows (not yet filtered for duplicates).
 */
async function fetchFeedCandidates(
  feedKey: string,
  feedURL: string
): Promise<CandidateRow[]> {
  try {
    const rssData = await getFeed(feedURL);

    if (!rssData) {
      return [];
    }

    // Hash feedURL once for this feed
    const tableId = sha256(feedURL);

    // Filter out old articles
    const { accepted, filteredCount } = filterFeedItemsByAge(
      rssData.items,
      MAX_ARTICLE_AGE_HOURS
    );

    if (filteredCount > 0) {
      console.log(`[${feedKey}] Filtered out ${filteredCount} articles older than ${MAX_ARTICLE_AGE_HOURS}h`);
    }

    const kwFilter = settings.keyword_filter;
    let freshItems = accepted;
    if (
      kwFilter?.enabled &&
      kwFilter.keywords?.length > 0 &&
      !kwFilter.exempt_feeds?.includes(feedKey)
    ) {
      const kwResult = filterFeedItemsByKeywords(accepted, kwFilter.keywords);
      if (kwResult.filteredCount > 0) {
        console.log(`[${feedKey}] Filtered out ${kwResult.filteredCount} articles not matching keywords`);
      }
      freshItems = kwResult.accepted;
    }

    return freshItems.map(({ item, pubDate }) => ({
      hash: `${tableId}-${sha256(item.title ?? "")}-${sha256(item.link ?? "")}`,
      canonical_url: normalizeUrl(item.link) || null,
      data: { ...item, _feedKey: feedKey },
      pub_date: pubDate.toISOString(),
    }));
  } catch (err) {
    console.error(`[${feedKey}] Unexpected error: ${err}`);
    return [];
  }
}

/**
 * Fetch multiple feeds in parallel and return all candidate rows.
 */
async function fetchFeedBatch(
  feedEntries: [string, string][]
): Promise<CandidateRow[]> {
  const results = await Promise.all(
    feedEntries.map(([feedKey, feedURL]) => fetchFeedCandidates(feedKey, feedURL))
  );
  return results.flat();
}

(async () => {
  const feedEntries = Object.entries(settings.feeds) as [string, string][];
  console.log(`Processing ${feedEntries.length} feeds...`);

  // Phase 1: Fetch all feeds in parallel batches and collect candidates
  const allCandidates: CandidateRow[] = [];
  for (let i = 0; i < feedEntries.length; i += BATCH_SIZE) {
    const batch = feedEntries.slice(i, i + BATCH_SIZE);
    const batchCandidates = await fetchFeedBatch(batch);
    allCandidates.push(...batchCandidates);
  }

  if (allCandidates.length === 0) {
    console.log("No candidates from any feed");
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
    return;
  }

  console.log(`Collected ${allCandidates.length} candidates from all feeds`);

  // Phase 2: Filter out duplicates (check against news + tooted_hashes by
  // BOTH hash and canonical_url). hash catches exact title+link repeats;
  // canonical_url catches the same article syndicated across feeds with
  // different titles or tracking params on the link.
  const candidateHashes = allCandidates.map((c) => c.hash);
  const candidateCanonicalUrls = Array.from(
    new Set(
      allCandidates
        .map((c) => c.canonical_url)
        .filter((u): u is string => !!u)
    )
  );

  const QUERY_CHUNK_SIZE = 500;
  const existingHashes = new Set<string>();
  const existingCanonicalUrls = new Set<string>();

  for (let i = 0; i < candidateHashes.length; i += QUERY_CHUNK_SIZE) {
    const chunk = candidateHashes.slice(i, i + QUERY_CHUNK_SIZE);

    const [newsResult, tootedResult] = await Promise.all([
      supabase.from(settings.db_table).select("hash").in("hash", chunk),
      supabase.from("tooted_hashes").select("hash").in("hash", chunk),
    ]);

    if (newsResult.error) {
      console.error(`Hash check error: ${newsResult.error.message}`);
    }

    for (const row of newsResult.data ?? []) {
      existingHashes.add((row as { hash: string }).hash);
    }
    for (const row of tootedResult.data ?? []) {
      existingHashes.add((row as { hash: string }).hash);
    }
  }

  for (let i = 0; i < candidateCanonicalUrls.length; i += QUERY_CHUNK_SIZE) {
    const chunk = candidateCanonicalUrls.slice(i, i + QUERY_CHUNK_SIZE);

    const [newsResult, tootedResult] = await Promise.all([
      supabase
        .from(settings.db_table)
        .select("canonical_url")
        .in("canonical_url", chunk),
      supabase
        .from("tooted_hashes")
        .select("canonical_url")
        .in("canonical_url", chunk),
    ]);

    if (newsResult.error) {
      console.error(`canonical_url check error: ${newsResult.error.message}`);
    }

    for (const row of newsResult.data ?? []) {
      const v = (row as { canonical_url: string | null }).canonical_url;
      if (v) existingCanonicalUrls.add(v);
    }
    for (const row of tootedResult.data ?? []) {
      const v = (row as { canonical_url: string | null }).canonical_url;
      if (v) existingCanonicalUrls.add(v);
    }
  }

  const filteredCandidates = allCandidates.filter(
    (c) =>
      !existingHashes.has(c.hash) &&
      !(c.canonical_url && existingCanonicalUrls.has(c.canonical_url))
  );

  // Dedupe within batch (same hash OR same canonical_url can appear if
  // multiple feeds carry the same article with slight title differences).
  const seenHashes = new Set<string>();
  const seenCanonicalUrls = new Set<string>();
  const newCandidates = filteredCandidates.filter((c) => {
    if (seenHashes.has(c.hash)) return false;
    if (c.canonical_url && seenCanonicalUrls.has(c.canonical_url)) return false;
    seenHashes.add(c.hash);
    if (c.canonical_url) seenCanonicalUrls.add(c.canonical_url);
    return true;
  });

  if (newCandidates.length === 0) {
    console.log("No new items to insert");
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
    return;
  }

  // Group by feedKey for logging
  const feedCounts = new Map<string, number>();
  for (const c of newCandidates) {
    const feedKey = c.data._feedKey as string;
    feedCounts.set(feedKey, (feedCounts.get(feedKey) ?? 0) + 1);
  }
  for (const [feedKey, count] of feedCounts) {
    console.log(`[${feedKey}] ${count} new items`);
  }

  // Phase 3: Insert all new candidates in a single batch
  // Use upsert with ignoreDuplicates to handle race conditions gracefully
  const { data: inserted, error: insertError } = await supabase
    .from(settings.db_table)
    .upsert(newCandidates, { onConflict: "hash", ignoreDuplicates: true })
    .select("id, data, pub_date");

  if (insertError) {
    console.error(`Insert error: ${insertError.message}`);
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
    return;
  }

  console.log(`Inserted ${inserted?.length ?? 0} new articles`);

  // Phase 4: Process ALL newly inserted articles for story assignment in a single batch
  // This ensures cross-feed story matching works correctly
  if (inserted && inserted.length > 0) {
    const articlesForMatching: ArticleForMatching[] = inserted.map(
      (row: { id: string; data: any; pub_date: string }) => ({
        id: row.id,
        title: row.data.title || "",
        contentSnippet: row.data.contentSnippet,
        pubDate: row.pub_date,
        feedKey: row.data._feedKey,
        link: row.data.link,
      })
    );
    await processNewArticles(articlesForMatching, settings.db_table);
  }

  console.log("Feed grabber complete");

  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();
