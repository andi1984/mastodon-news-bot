/**
 * Score a feed item in `[0, priority]` based on its source priority and
 * how fresh its pubDate is.
 *
 * - `priority` looks up `feedKey` in `feedPriorities`, defaulting to 0.5.
 * - `freshness` decays linearly from 1 (just now) to 0 (>= `minFreshnessHours`).
 * - Missing pubDate → freshness = 0.5 (unknown age, treat as mid-bucket).
 * - Future pubDate → freshness = 1 (event feeds list upcoming items; without
 *   this clamp, items months out would produce unbounded scores and dominate
 *   the tooter's batch).
 */
export function scoreFeedItem(
  feedKey: string | undefined,
  pubDate: string | undefined,
  feedPriorities: Record<string, number>,
  minFreshnessHours: number,
  now: Date = new Date()
): number {
  const priority = feedKey ? (feedPriorities[feedKey] ?? 0.5) : 0.5;

  if (!pubDate) return priority * 0.5;

  const ageMs = now.getTime() - new Date(pubDate).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  const freshness =
    ageHours < 0 ? 1 : Math.max(0, 1 - ageHours / minFreshnessHours);

  return priority * freshness;
}
