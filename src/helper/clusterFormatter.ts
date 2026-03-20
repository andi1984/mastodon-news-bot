import rssFeedItem2Toot, { FeedItem } from "./rssFeedItem2Toot.js";
import { ClusterArticle, isBreakingNews, pickPrimaryArticle } from "./similarity.js";
import { getTopicEmoji } from "./engagementEnhancer.js";

const MASTODON_CHAR_LIMIT = 500;

/**
 * Convert hashtag to CamelCase for accessibility.
 * Screen readers can't parse lowercase hashtags properly.
 * e.g., "saarlandnews" → "SaarlandNews"
 */
function toCamelCaseHashtag(tag: string): string {
  // If already has uppercase letters, assume it's intentional
  if (/[A-Z]/.test(tag)) return tag;
  // Split on common separators and capitalize each word
  return tag
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

export type ClusterFormatOptions = {
  feedPriorities: Record<string, number>;
  feedHashtags: string[];
  feedSpecificHashtags?: Record<string, string[]>;
  breakingNewsMinSources?: number;
  breakingNewsTimeWindowHours?: number;
};

export function formatClusterToot(
  cluster: ClusterArticle[],
  options: ClusterFormatOptions
): string {
  const {
    feedPriorities,
    feedHashtags,
    feedSpecificHashtags,
    breakingNewsMinSources = 3,
    breakingNewsTimeWindowHours = 2,
  } = options;

  // Single-source cluster: delegate to existing formatter
  if (cluster.length === 1) {
    const item = cluster[0];
    const specificHashtags =
      item.feedKey && feedSpecificHashtags?.[item.feedKey];
    const hashtags = [...feedHashtags, ...(specificHashtags || [])];
    return rssFeedItem2Toot(item.article, hashtags);
  }

  const primary = pickPrimaryArticle(cluster, feedPriorities);
  const breaking = isBreakingNews(
    cluster,
    breakingNewsTimeWindowHours,
    breakingNewsMinSources
  );

  const creator = primary.article.creator || primary.article["dc:creator"];
  const title = primary.article.title || "";

  // Build hashtags from the primary article's feed (CamelCase for accessibility)
  const specificHashtags =
    primary.feedKey && feedSpecificHashtags?.[primary.feedKey];
  const hashtags = [...feedHashtags, ...(specificHashtags || [])];
  if (breaking) hashtags.push("Eilmeldung");
  const hashtagStr = hashtags
    .map((tag) => `#${toCamelCaseHashtag(tag)}`)
    .join(" ");

  // Build title line (hashtags moved to footer for better readability)
  const emoji = getTopicEmoji(title);
  const emojiPrefix = emoji ? `${emoji} ` : "";
  const breakingPrefix = breaking ? "EILMELDUNG: " : "";
  const creatorStr = creator ? ` (${creator})` : "";
  const titleLine = `${emojiPrefix}${breakingPrefix}${title}${creatorStr}`;

  // Build sources block
  const sources = cluster.map((a) => {
    const feedName = a.feedKey || "unbekannt";
    return { feedName, link: a.article.link || "" };
  });

  // Deduplicate by feedKey (keep first per feed)
  const seenFeeds = new Set<string>();
  const uniqueSources = sources.filter((s) => {
    if (seenFeeds.has(s.feedName)) return false;
    seenFeeds.add(s.feedName);
    return true;
  });

  const sourcesHeader = "\n\nQuellen:";
  const sourceLines = uniqueSources.map((s) => `\n${s.feedName}: ${s.link}`);

  // Hashtags in footer (best practice for accessibility/readability)
  const hashtagFooter = `\n\n${hashtagStr}`;

  // Build toot: title + sources + hashtags footer
  let toot = titleLine + sourcesHeader;
  for (const line of sourceLines) {
    if (toot.length + line.length + hashtagFooter.length <= MASTODON_CHAR_LIMIT) {
      toot += line;
    }
  }
  toot += hashtagFooter;

  return toot;
}
