import createClient from "./db.js";
import { sha256 } from "./hash.js";

/**
 * Persistent cache for AI classification results.
 *
 * Designed to cut Claude spend on calls that re-classify the same article
 * or re-compare the same title pair across runs.  All helpers degrade to a
 * no-op when the DB is unavailable (missing env vars, missing tables), so
 * they are safe to call before the migration has been applied.
 */

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function titleHash(title: string): string {
  return sha256(normalizeTitle(title));
}

/**
 * Order-independent hash for a pair of titles. `pairKey(a, b)` equals
 * `pairKey(b, a)` so a pair stored in either direction is found.
 */
function pairKey(titleA: string, titleB: string): string {
  const ha = titleHash(titleA);
  const hb = titleHash(titleB);
  return ha <= hb ? `${ha}:${hb}` : `${hb}:${ha}`;
}

function isDbConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
}

// -----------------------------------------------------------------------
// Regional relevance cache
// -----------------------------------------------------------------------

export type RelevanceCategory = "local" | "regional" | "national" | "international";

/**
 * Look up cached regional categories for a list of titles.
 * Returns a map keyed by the original title (not hash).
 */
export async function getCachedRegionalCategories(
  titles: string[]
): Promise<Map<string, RelevanceCategory>> {
  const result = new Map<string, RelevanceCategory>();
  if (titles.length === 0 || !isDbConfigured()) return result;

  try {
    const db = createClient();
    const hashToTitle = new Map<string, string>();
    for (const t of titles) hashToTitle.set(titleHash(t), t);

    const { data, error } = await db
      .from("regional_cache")
      .select("title_hash, category")
      .in("title_hash", Array.from(hashToTitle.keys()));

    if (error || !data) return result;

    for (const row of data as { title_hash: string; category: string }[]) {
      const title = hashToTitle.get(row.title_hash);
      if (title) result.set(title, row.category as RelevanceCategory);
    }
  } catch {
    // Degrade silently - cache is best-effort
  }
  return result;
}

export async function setCachedRegionalCategories(
  entries: { title: string; category: RelevanceCategory }[]
): Promise<void> {
  if (entries.length === 0 || !isDbConfigured()) return;

  try {
    const db = createClient();
    const rows = entries.map((e) => ({
      title_hash: titleHash(e.title),
      category: e.category,
      cached_at: new Date().toISOString(),
    }));
    await db.from("regional_cache").upsert(rows, { onConflict: "title_hash" });
  } catch {
    // Degrade silently
  }
}

// -----------------------------------------------------------------------
// Semantic similarity pair cache
// -----------------------------------------------------------------------

export async function getCachedSemanticScores(
  pairs: { titleA: string; titleB: string }[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (pairs.length === 0 || !isDbConfigured()) return result;

  try {
    const db = createClient();
    const keys = pairs.map((p) => pairKey(p.titleA, p.titleB));
    const { data, error } = await db
      .from("semantic_pair_cache")
      .select("pair_hash, score")
      .in("pair_hash", keys);

    if (error || !data) return result;

    for (const row of data as { pair_hash: string; score: number }[]) {
      result.set(row.pair_hash, Number(row.score));
    }
  } catch {
    // Degrade silently
  }
  return result;
}

export async function setCachedSemanticScores(
  entries: { titleA: string; titleB: string; score: number }[]
): Promise<void> {
  if (entries.length === 0 || !isDbConfigured()) return;

  try {
    const db = createClient();
    const rows = entries.map((e) => ({
      pair_hash: pairKey(e.titleA, e.titleB),
      score: e.score,
      cached_at: new Date().toISOString(),
    }));
    await db.from("semantic_pair_cache").upsert(rows, { onConflict: "pair_hash" });
  } catch {
    // Degrade silently
  }
}

export { pairKey as _pairKeyForTesting };
