import rssFeedItem2Toot, { FeedItem } from "./rssFeedItem2Toot.js";
import { ClusterArticle, isBreakingNews, pickPrimaryArticle } from "./similarity.js";

const MASTODON_CHAR_LIMIT = 500;

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

  // Build hashtags from the primary article's feed
  const specificHashtags =
    primary.feedKey && feedSpecificHashtags?.[primary.feedKey];
  const hashtags = [...feedHashtags, ...(specificHashtags || [])];
  if (breaking) hashtags.push("eilmeldung");
  const hashtagStr = hashtags.map((tag) => ` #${tag}`).join("");

  // Build title line
  const prefix = breaking ? "EILMELDUNG: " : "";
  const creatorStr = creator ? `, ${creator}` : "";
  const titleLine = `${prefix}${title}${creatorStr}${hashtagStr}`;

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

  // Build toot, truncating sources if needed to fit limit
  let toot = titleLine + sourcesHeader;
  for (const line of sourceLines) {
    if (toot.length + line.length <= MASTODON_CHAR_LIMIT) {
      toot += line;
    }
  }

  return toot;
}
