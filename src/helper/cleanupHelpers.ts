import { createRequire } from "node:module";
import type createClientType from "./db.js";

const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");

type Row = { id: string; hash: string | null };

// Upsert hashes to tooted_hashes first, then delete the rows. If the upsert
// errors, the rows are NOT deleted so they can be retried on the next
// cleanup tick — deleting without a persisted hash would let the RSS item
// be re-ingested and re-tooted.
//
// Rows with null/empty hash are never deleted (see callers for how they're
// handled) — deleting them would also leak a dedup record.
async function upsertHashesThenDelete(
  supabase: ReturnType<typeof createClientType>,
  rowsWithHash: Row[],
  context: string
): Promise<number> {
  if (rowsWithHash.length === 0) return 0;

  const hashRecords = rowsWithHash.map((r) => ({ hash: r.hash as string }));
  const { error: hashErr } = await supabase
    .from("tooted_hashes")
    .upsert(hashRecords, { onConflict: "hash" });

  if (hashErr) {
    console.error(
      `[${context}] Failed to persist hashes (${hashErr.message}); skipping delete to avoid re-ingestion`
    );
    return 0;
  }

  const ids = rowsWithHash.map((r) => r.id);
  const { error: delErr } = await supabase
    .from(settings.db_table)
    .delete()
    .in("id", ids);

  if (delErr) {
    console.error(`[${context}] Delete after hash save failed: ${delErr.message}`);
    return 0;
  }

  return ids.length;
}

// Delete articles where tooted=true, persisting their hashes to
// tooted_hashes first. Safe order: SELECT → UPSERT → DELETE. On upsert
// error, rows are left in place (tooted=true) to be retried next cleanup
// cycle. Rows with null/empty hash are left in place and logged — the
// ingestion bug that produced them is historical and needs operator
// inspection; deleting would leak a dedup record.
export async function cleanupTootedArticles(
  supabase: ReturnType<typeof createClientType>
): Promise<number> {
  const { data, error } = await supabase
    .from(settings.db_table)
    .select("id, hash")
    .eq("tooted", true);

  if (error) {
    console.error(`Cleanup tooted articles: ${error.message}`);
    return 0;
  }

  const rows = (data ?? []) as Row[];
  const withHash = rows.filter((r): r is Row & { hash: string } => !!r.hash);
  const nullHashCount = rows.length - withHash.length;

  if (nullHashCount > 0) {
    console.error(
      `[cleanup-tooted] ${nullHashCount} row(s) with null/empty hash left in place for inspection`
    );
  }

  return upsertHashesThenDelete(supabase, withHash, "cleanup-tooted");
}

// Delete untooted articles whose pub_date or created_at is older than
// retentionHours. Safe order: SELECT → UPSERT to tooted_hashes → DELETE.
// On upsert error, rows are left untouched and retried next cleanup cycle
// (tooter's freshness filter keeps them from being posted).
//
// Rows with null/empty hash are marked tooted=true instead of deleted, so
// the tooter ignores them and the next cleanupTootedArticles cycle surfaces
// them as anomalies. Never delete a null-hash row — without a dedup token
// the RSS item will be re-ingested on the next grabber run.
export async function cleanupStaleArticles(
  supabase: ReturnType<typeof createClientType>,
  retentionHours: number
): Promise<number> {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - retentionHours);
  const cutoffIso = cutoff.toISOString();

  const { data, error } = await supabase
    .from(settings.db_table)
    .select("id, hash")
    .eq("tooted", false)
    .or(`pub_date.lt.${cutoffIso},created_at.lt.${cutoffIso}`);

  if (error) {
    console.error(`Cleanup stale articles: ${error.message}`);
    return 0;
  }

  const rows = (data ?? []) as Row[];
  const withHash = rows.filter((r): r is Row & { hash: string } => !!r.hash);
  const nullHashIds = rows.filter((r) => !r.hash).map((r) => r.id);

  let nullHashMarked = 0;
  if (nullHashIds.length > 0) {
    const { error: markErr } = await supabase
      .from(settings.db_table)
      .update({ tooted: true })
      .in("id", nullHashIds);
    if (markErr) {
      console.error(
        `[cleanup-stale] Failed to mark ${nullHashIds.length} null-hash row(s) tooted=true: ${markErr.message}`
      );
    } else {
      nullHashMarked = nullHashIds.length;
      console.error(
        `[cleanup-stale] Marked ${nullHashIds.length} null-hash row(s) tooted=true for anomaly review`
      );
    }
  }

  const deleted = await upsertHashesThenDelete(supabase, withHash, "cleanup-stale");
  return deleted + nullHashMarked;
}
