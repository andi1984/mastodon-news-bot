import { createRequire } from "node:module";
import type createClientType from "./db.js";

const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");

/**
 * Delete all articles where tooted=true, but first persist their hashes to
 * the `tooted_hashes` dedup table. Articles can land in tooted=true state
 * via feed-tooter's fallback path when its inline hash upsert fails —
 * deleting without persisting the hash would let the same RSS item be
 * re-ingested and re-tooted on the next grabber run.
 *
 * Returns the number of rows that were deleted. If the upsert to
 * tooted_hashes fails we still return the count (we don't fail the cleanup
 * run), but the failure is logged via console.error.
 */
export async function cleanupTootedArticles(
  supabase: ReturnType<typeof createClientType>
): Promise<number> {
  const { data, error } = await supabase
    .from(settings.db_table)
    .delete()
    .eq("tooted", true)
    .select("id, hash");

  if (error) {
    console.error(`Cleanup tooted articles: ${error.message}`);
    return 0;
  }

  const rows = (data ?? []) as { id: string; hash: string | null }[];
  const hashRecords = rows
    .map((r) => r.hash)
    .filter((h): h is string => !!h)
    .map((hash) => ({ hash }));

  if (hashRecords.length > 0) {
    const { error: hashErr } = await supabase
      .from("tooted_hashes")
      .upsert(hashRecords, { onConflict: "hash" });
    if (hashErr) {
      console.error(`Cleanup tooted: failed to persist hashes: ${hashErr.message}`);
    }
  }

  return rows.length;
}
