import type createClientType from "./db.js";
import { normalizeUrl } from "./normalizeUrl.js";

// After a follow-up quote-toot is posted for an already-tooted story,
// we need to record the newly-posted links so the next day's follow-up
// dedup treats them as already-seen. Without this, every time the RSS
// feed re-emits the same article (with a fresh hash, e.g. because the
// title changed cosmetically), the tooter re-posts a quote toot about
// it - which is the daily re-tooting observed for the verbraucherzentrale
// URLs.
//
// Normalization is applied on BOTH sides (existing + incoming) so:
//   - cosmetic URL variants collapse to one canonical entry
//   - legacy rows with un-normalized URLs still dedup correctly
export async function extendStoryOriginalLinks(
  db: ReturnType<typeof createClientType>,
  storyId: string,
  newLinks: string[]
): Promise<void> {
  const incoming = newLinks
    .map((l) => normalizeUrl(l))
    .filter((l): l is string => !!l);

  if (incoming.length === 0) return;

  const { data, error: selectError } = await db
    .from("stories")
    .select("original_links")
    .eq("id", storyId)
    .single();

  if (selectError) {
    console.error(
      `[extendStoryOriginalLinks] Select failed for story ${storyId}: ${selectError.message}`
    );
    return;
  }

  const existing = ((data?.original_links ?? []) as string[])
    .map((l) => normalizeUrl(l))
    .filter((l): l is string => !!l);

  const merged = new Set<string>(existing);
  const before = merged.size;
  for (const link of incoming) merged.add(link);
  if (merged.size === before) return;

  const { error: updateError } = await db
    .from("stories")
    .update({ original_links: Array.from(merged) })
    .eq("id", storyId);

  if (updateError) {
    console.error(
      `[extendStoryOriginalLinks] Update failed for story ${storyId}: ${updateError.message}`
    );
  }
}
