import type createClientType from "./db.js";
import { normalizeUrl } from "./normalizeUrl.js";
import type { StoryRecord } from "./storyMatcher.js";

// URL-based short-circuit for findMatchingStory.
//
// The time-windowed token match in findMatchingStory (72h) misses stories
// that were tooted weeks ago when the RSS feed re-emits the same article
// with a cosmetic hash drift. That re-ingestion path produces a brand-new
// story and a fresh full toot - the daily re-toot the user keeps seeing.
//
// This helper scans recent stories' original_links (normalized on BOTH
// sides so legacy un-normalized entries still match) and returns the
// matching story regardless of age, token drift, or cosmetic URL variation
// in the incoming link. Ordered newest-first so a recent row beats an
// older duplicate if one ever exists.
const STORY_SCAN_LIMIT = 500;

export async function findStoryByUrl(
  db: ReturnType<typeof createClientType>,
  link: string | null | undefined
): Promise<StoryRecord | null> {
  const normalized = normalizeUrl(link ?? "");
  if (!normalized) return null;

  const { data, error } = await db
    .from("stories")
    .select("*")
    .not("original_links", "is", null)
    .order("updated_at", { ascending: false })
    .limit(STORY_SCAN_LIMIT);

  if (error) {
    console.error(`[findStoryByUrl] select failed: ${error.message}`);
    return null;
  }

  if (!data || data.length === 0) return null;

  for (const story of data as StoryRecord[]) {
    const links = story.original_links ?? [];
    for (const raw of links) {
      if (normalizeUrl(raw) === normalized) {
        return story;
      }
    }
  }

  return null;
}
