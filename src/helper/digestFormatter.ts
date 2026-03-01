import type { mastodon } from "masto";

const MAX_TOOT_LENGTH = 500;
const HASHTAGS = "\n\n#saarlandnews #news #tageszusammenfassung";
const HEADER = "Wichtigste Nachrichten des Tages\n\n";

export function extractTitleFromStatus(status: mastodon.v1.Status): string {
  // Strip HTML tags
  let text = status.content.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  // Take text before first #hashtag
  const hashIndex = text.search(/\s#\S/);
  if (hashIndex > 0) {
    text = text.substring(0, hashIndex);
  }
  return text.trim();
}

export function extractLinkFromStatus(status: mastodon.v1.Status): string | null {
  // Prefer the preview card URL
  if (status.card?.url) {
    return status.card.url;
  }
  // Fallback: parse the last non-hashtag <a href> from content
  const hrefMatches = [...status.content.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>[^<]*<\/a>/gi)];
  // Filter out hashtag links (they typically contain /tags/ or the text starts with #)
  const nonHashtagLinks = hrefMatches.filter(
    (m) => !m[1].includes("/tags/") && !m[0].match(/>[\s]*#/)
  );
  if (nonHashtagLinks.length > 0) {
    return nonHashtagLinks[nonHashtagLinks.length - 1][1];
  }
  return null;
}

export interface DigestEntry {
  title: string;
  link: string | null;
  score: number;
}

export function formatDigestToot(entries: DigestEntry[], header?: string, hashtags?: string): string {
  if (entries.length === 0) return "";

  const effectiveHeader = header ?? HEADER;
  const effectiveHashtags = hashtags ?? HASHTAGS;
  const budgetForEntries = MAX_TOOT_LENGTH - effectiveHeader.length - effectiveHashtags.length;
  const lines: string[] = [];
  let usedLength = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const num = `${i + 1}. `;
    const linkLine = entry.link ? `${entry.link}\n` : "";

    // Calculate space needed for this entry (number + title + newline + link)
    const maxTitleLen =
      budgetForEntries - usedLength - num.length - 1 - linkLine.length;

    if (maxTitleLen < 10) break; // Not enough space for a meaningful entry

    let title = entry.title;
    if (title.length > maxTitleLen) {
      title = title.substring(0, maxTitleLen - 1) + "\u2026";
    }

    const entryLine = `${num}${title}`;
    const entryBlock = linkLine ? `${entryLine}\n${linkLine}` : `${entryLine}\n`;

    if (usedLength + entryBlock.length > budgetForEntries) break;

    lines.push(entryBlock);
    usedLength += entryBlock.length;
  }

  return effectiveHeader + lines.join("") + effectiveHashtags.trimStart();
}
