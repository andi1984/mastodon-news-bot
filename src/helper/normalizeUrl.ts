// RSS feeds re-emit the same article with cosmetic URL variations -
// trailing slashes, tracking params (utm_*, fbclid, gclid), fragments,
// scheme/host case. Downstream, the follow-up dedup in feed-tooter
// compares URLs as raw strings, so each variant is treated as a brand
// new link and triggers another quote toot about content we already
// posted. Normalizing on both the storing and checking side collapses
// those variants to a single canonical form.

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_name",
  "utm_id",
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "twclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "ref",
  "ref_src",
  "ref_url",
  "share",
  "source",
]);

export function normalizeUrl(input: string | null | undefined): string {
  if (!input) return "";
  const raw = input.trim();
  if (!raw) return "";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.toLowerCase();
  }

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  const kept: [string, string][] = [];
  for (const [k, v] of url.searchParams) {
    if (!TRACKING_PARAMS.has(k.toLowerCase())) {
      kept.push([k, v]);
    }
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const rebuilt = new URLSearchParams();
  for (const [k, v] of kept) rebuilt.append(k, v);
  url.search = rebuilt.toString() ? `?${rebuilt.toString()}` : "";

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}
