import type { Item } from "rss-parser";
import { getTopicEmoji } from "./engagementEnhancer.js";

type AdditionalFeedItems = {
    'dc:creator': string;
}

export type FeedItem = Item & AdditionalFeedItems;

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

const rssFeedItem2Toot = (item: FeedItem, hashtags?: string[]) => {

    const creator = item.creator || item['dc:creator'];
    const title = item.title || "";
    const link = item.link;

    // Topic emoji prefix (subtle, one emoji max)
    const emoji = getTopicEmoji(title);
    const emojiPrefix = emoji ? `${emoji} ` : "";

    // Title with optional creator attribution
    const titleLine = `${emojiPrefix}${title}${creator ? ` (${creator})` : ''}`;

    // Hashtags in footer with CamelCase for accessibility
    const hashtagStr = hashtags?.length
        ? `\n\n${hashtags.map(tag => `#${toCamelCaseHashtag(tag)}`).join(' ')}`
        : '';

    return `${titleLine}\n\n${link}${hashtagStr}`;
}

export default rssFeedItem2Toot;