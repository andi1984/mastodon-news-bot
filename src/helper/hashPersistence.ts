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
    .select("hash")
    .in("id", articleIds);

  if (selectError) {
    console.error(
      `[${context}] Failed to read hashes (${selectError.message}); marking tooted=true to avoid re-post`
    );
    await markTootedFallback(db, articleIds, context);
    return;
  }

  const fetchedRows = rows ?? [];
  const hashRecords = fetchedRows
    .map((r: { hash: string | null }) => r.hash)
    .filter((h): h is string => !!h)
    .map((hash) => ({ hash }));

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
