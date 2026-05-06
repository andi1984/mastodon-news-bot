import { createRequire } from "node:module";
import type createClient from "./db.js";

const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");

// Mark the given articles tooted=true as a safe fallback when we cannot
// safely delete them. Any error from the update itself is logged (the row
// then stays in whatever state it was before), but we never throw — the
// caller has already posted the toot and we must not crash the job.
async function markTootedFallback(
  db: ReturnType<typeof createClient>,
  articleIds: string[],
  context: string
): Promise<void> {
  if (articleIds.length === 0) return;
  const { error } = await db
    .from(settings.db_table)
    .update({ tooted: true })
    .in("id", articleIds);
  if (error) {
    console.error(
      `[${context}] Fallback update(tooted=true) failed (${error.message}); row may be re-tooted on next run`
    );
  }
}

export type ClaimResult = {
  // Articles cleared to proceed: either we just inserted their canonical_url
  // into tooted_hashes (race-protected via ON CONFLICT), or they had no
  // canonical_url and are protected only by the hash dedup layer.
  proceedArticleIds: string[];
  // Articles whose canonical_url was already in tooted_hashes — another
  // process / earlier run already owns posting this URL. Caller should NOT
  // post these, and should call saveHashesAndFinalize to clean up the news
  // row so the article doesn't keep blocking the queue.
  conflictArticleIds: string[];
  // canonical_url values we INSERTED into tooted_hashes. On Mastodon API
  // failure, pass these to releaseCanonicalUrls to roll back the claim
  // (otherwise the URL would be permanently blocked from future retry).
  claimedCanonicalUrls: string[];
};

// Pre-claim: insert (hash, canonical_url) into tooted_hashes BEFORE the
// Mastodon API call so that a parallel run / a later story in the same
// batch sees the URL as taken and skips it. Combined with the in-batch
// Set in feed-tooter, this closes the in-batch and cross-process duplicate
// posting windows.
export async function claimArticles(
  db: ReturnType<typeof createClient>,
  articleIds: string[],
  context: string
): Promise<ClaimResult> {
  if (articleIds.length === 0) {
    return {
      proceedArticleIds: [],
      conflictArticleIds: [],
      claimedCanonicalUrls: [],
    };
  }

  const { data: rows, error: selectError } = await db
    .from(settings.db_table)
    .select("id, hash, canonical_url")
    .in("id", articleIds);

  if (selectError) {
    console.error(
      `[${context}] claimArticles failed to read news rows (${selectError.message}); treating as conflict to avoid duplicate posting`
    );
    return {
      proceedArticleIds: [],
      conflictArticleIds: articleIds,
      claimedCanonicalUrls: [],
    };
  }

  type NewsRow = {
    id: string;
    hash: string | null;
    canonical_url: string | null;
  };
  const newsRows = (rows ?? []) as NewsRow[];

  const articlesWithUrl = newsRows.filter(
    (r): r is NewsRow & { canonical_url: string } => !!r.canonical_url
  );
  const articlesWithoutUrl = newsRows.filter((r) => !r.canonical_url);

  if (articlesWithUrl.length === 0) {
    return {
      proceedArticleIds: articlesWithoutUrl.map((r) => r.id),
      conflictArticleIds: [],
      claimedCanonicalUrls: [],
    };
  }

  const urls = Array.from(new Set(articlesWithUrl.map((r) => r.canonical_url)));

  const { data: existing, error: precheckError } = await db
    .from("tooted_hashes")
    .select("canonical_url")
    .in("canonical_url", urls);

  if (precheckError) {
    console.error(
      `[${context}] claimArticles canonical_url precheck failed (${precheckError.message}); treating as conflict`
    );
    return {
      proceedArticleIds: [],
      conflictArticleIds: articleIds,
      claimedCanonicalUrls: [],
    };
  }

  const existingUrls = new Set(
    (existing ?? [])
      .map((r) => (r as { canonical_url: string | null }).canonical_url)
      .filter((u): u is string => !!u)
  );

  const toInsert = articlesWithUrl.filter(
    (r) => !existingUrls.has(r.canonical_url)
  );
  const conflictRows = articlesWithUrl.filter((r) =>
    existingUrls.has(r.canonical_url)
  );

  if (toInsert.length === 0) {
    return {
      proceedArticleIds: articlesWithoutUrl.map((r) => r.id),
      conflictArticleIds: conflictRows.map((r) => r.id),
      claimedCanonicalUrls: [],
    };
  }

  // ON CONFLICT (canonical_url) DO NOTHING via ignoreDuplicates: any TOCTOU
  // race between the SELECT above and this INSERT is swallowed safely. Note:
  // we cannot reliably know which subset survived the conflict, so we treat
  // ALL toInsert URLs as claimed-by-us. If a parallel run sneaked in, both
  // runs see proceed=true; the in-batch Set in feed-tooter and the second
  // process's own pre-claim form the actual barrier.
  const insertRows = toInsert.map((r) => ({
    hash: r.hash ?? `claim:${r.canonical_url}`,
    canonical_url: r.canonical_url,
  }));

  const { error: insertError } = await db
    .from("tooted_hashes")
    .upsert(insertRows, {
      onConflict: "canonical_url",
      ignoreDuplicates: true,
    });

  if (insertError) {
    console.error(
      `[${context}] claimArticles insert failed (${insertError.message}); treating as conflict`
    );
    return {
      proceedArticleIds: [],
      conflictArticleIds: articleIds,
      claimedCanonicalUrls: [],
    };
  }

  return {
    proceedArticleIds: [
      ...toInsert.map((r) => r.id),
      ...articlesWithoutUrl.map((r) => r.id),
    ],
    conflictArticleIds: conflictRows.map((r) => r.id),
    claimedCanonicalUrls: toInsert.map((r) => r.canonical_url),
  };
}

// Release: undo a pre-claim when the Mastodon post failed. Without this,
// a transient network blip would permanently block re-posting that URL.
export async function releaseCanonicalUrls(
  db: ReturnType<typeof createClient>,
  canonicalUrls: string[],
  context: string
): Promise<void> {
  if (canonicalUrls.length === 0) return;
  const { error } = await db
    .from("tooted_hashes")
    .delete()
    .in("canonical_url", canonicalUrls);
  if (error) {
    console.error(
      `[${context}] releaseCanonicalUrls failed (${error.message}); URL(s) may be permanently blocked from re-toot`
    );
  }
}

// Persist hashes to tooted_hashes, then delete articles. If any step fails,
// the article is marked tooted=true instead of deleted — this leaves a
// record for cleanup.ts to re-try the hash save later, and prevents the
// same item from being re-ingested and re-tooted on the next grabber run.
//
// Special case: if EVERY row has a null/empty hash, we skip the delete
// entirely. A null hash means we have no dedup token to put into
// tooted_hashes, so deleting the news row would let the RSS item be
// re-ingested and re-tooted. We mark tooted=true instead and let cleanup
// surface the anomaly to operators.
export async function saveHashesAndFinalize(
  db: ReturnType<typeof createClient>,
  articleIds: string[],
  context: string
): Promise<void> {
  if (articleIds.length === 0) return;

  const { data: rows, error: selectError } = await db
    .from(settings.db_table)
    .select("hash, canonical_url")
    .in("id", articleIds);

  if (selectError) {
    console.error(
      `[${context}] Failed to read hashes (${selectError.message}); marking tooted=true to avoid re-post`
    );
    await markTootedFallback(db, articleIds, context);
    return;
  }

  type Row = { hash: string | null; canonical_url: string | null };
  const fetchedRows = (rows ?? []) as Row[];
  const hashRecords = fetchedRows
    .filter((r) => !!r.hash)
    .map((r) => ({
      hash: r.hash as string,
      canonical_url: r.canonical_url ?? null,
    }));

  // If we have rows but NONE have a usable hash, bail out safely rather
  // than delete-without-dedup. This catches an ingestion bug where articles
  // landed without a hash computed.
  if (fetchedRows.length > 0 && hashRecords.length === 0) {
    console.error(
      `[${context}] All ${fetchedRows.length} row(s) have null/empty hash; skipping delete and marking tooted=true`
    );
    await markTootedFallback(db, articleIds, context);
    return;
  }

  if (hashRecords.length > 0) {
    const { error: hashError } = await db
      .from("tooted_hashes")
      .upsert(hashRecords, { onConflict: "hash" });
    if (hashError) {
      console.error(
        `[${context}] Failed to save tooted_hashes (${hashError.message}); marking tooted=true to avoid re-post`
      );
      await markTootedFallback(db, articleIds, context);
      return;
    }
  }

  const { error: deleteError } = await db
    .from(settings.db_table)
    .delete()
    .in("id", articleIds);

  if (deleteError) {
    console.error(
      `[${context}] Failed to delete after hash save (${deleteError.message}); marking tooted=true`
    );
    await markTootedFallback(db, articleIds, context);
  }
}

export default saveHashesAndFinalize;
