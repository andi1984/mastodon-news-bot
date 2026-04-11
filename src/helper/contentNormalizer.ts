/**
 * Normalize a Mastodon status HTML body so repeat-content detection
 * compares semantic bytes, not presentation noise.
 *
 * Hashtags are stripped because the bot's hashtag generator is AI-assisted
 * and non-deterministic: the same article re-tooted gets different tags each
 * run, which would otherwise split a duplicate group.
 */
export function normalizeTootContent(html: string | undefined | null): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/#[\wäöüÄÖÜß]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
