export type RawFeedItem = {
  title?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  [key: string]: any;
};

export type FilteredFeedItem = {
  item: RawFeedItem;
  pubDate: Date;
};

export type FilterResult = {
  accepted: FilteredFeedItem[];
  filteredCount: number;
};

/**
 * Parse a date from RSS feed item, falling back to current date if invalid.
 */
export function parseFeedItemDate(item: RawFeedItem): Date {
  const rawDate = item.pubDate ?? item.isoDate;
  if (!rawDate) return new Date();

  const parsed = new Date(rawDate);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Filter feed items by age, rejecting items older than maxAgeHours.
 */
export function filterFeedItemsByAge(
  items: RawFeedItem[],
  maxAgeHours: number,
  now: Date = new Date()
): FilterResult {
  const cutoffDate = new Date(now);
  cutoffDate.setHours(cutoffDate.getHours() - maxAgeHours);

  const accepted: FilteredFeedItem[] = [];
  let filteredCount = 0;

  for (const item of items) {
    const pubDate = parseFeedItemDate(item);

    if (pubDate < cutoffDate) {
      filteredCount++;
      continue;
    }

    accepted.push({ item, pubDate });
  }

  return { accepted, filteredCount };
}
