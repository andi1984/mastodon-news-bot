import { describe, test, expect } from "@jest/globals";
import { normalizeUrl } from "./normalizeUrl.js";

// Why this helper exists:
//
// RSS feeds re-emit the same article with cosmetic URL variations -
// trailing slashes, tracking params (utm_*, fbclid, gclid), fragments,
// scheme/host case, duplicate query params. Raw string equality treats
// each variant as a distinct URL. Downstream this leaks past the
// `original_links` check in feed-tooter's follow-up path, so a story
// the bot already posted about gets re-tooted as a "new follow-up"
// every time the feed emits a cosmetic variant - which is the exact
// behavior observed daily for the two verbraucherzentrale URLs.
//
// These tests pin down the canonicalization rules so both the storing
// side (markStoryTooted) and the checking side (follow-up dedup) agree.

describe("normalizeUrl", () => {
  test("returns empty string for nullish / empty / whitespace input", () => {
    expect(normalizeUrl(null)).toBe("");
    expect(normalizeUrl(undefined)).toBe("");
    expect(normalizeUrl("")).toBe("");
    expect(normalizeUrl("   ")).toBe("");
  });

  test("collapses trailing slash on non-root path", () => {
    // Same article re-emitted with/without trailing slash is the
    // single most common variant we see from Wordpress-style feeds.
    expect(normalizeUrl("https://example.com/a")).toBe(
      normalizeUrl("https://example.com/a/")
    );
  });

  test("keeps root slash (cannot strip from root path)", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  test("lowercases scheme and host; preserves path case", () => {
    // Hosts are case-insensitive per RFC 3986; paths are not (many CMSs
    // rely on case-sensitive slugs). Only normalize what the spec allows.
    expect(normalizeUrl("HTTPS://Example.COM/Path/To/Article")).toBe(
      "https://example.com/Path/To/Article"
    );
  });

  test("drops tracking params (utm_*, fbclid, gclid, mc_*, ref, share)", () => {
    const clean = "https://example.com/a";
    const tracked =
      "https://example.com/a?utm_source=newsletter&utm_medium=email&fbclid=abc&gclid=xyz&mc_cid=1&ref=twitter&share=fb";
    expect(normalizeUrl(tracked)).toBe(clean);
  });

  test("preserves non-tracking query params", () => {
    // id, q, page, etc. are semantic - stripping them would mistake
    // legitimately-different pages as duplicates.
    expect(normalizeUrl("https://example.com/search?q=foo&page=2")).toBe(
      "https://example.com/search?page=2&q=foo"
    );
  });

  test("sorts query params for stable comparison", () => {
    // Two URLs differing only in param order must normalize equal.
    expect(normalizeUrl("https://example.com/a?b=2&a=1")).toBe(
      normalizeUrl("https://example.com/a?a=1&b=2")
    );
  });

  test("strips fragment", () => {
    // The fragment is client-side only and never changes the document
    // the feed is pointing at.
    expect(normalizeUrl("https://example.com/a#section-2")).toBe(
      "https://example.com/a"
    );
  });

  test("drops default ports (80 for http, 443 for https)", () => {
    expect(normalizeUrl("http://example.com:80/a")).toBe("http://example.com/a");
    expect(normalizeUrl("https://example.com:443/a")).toBe(
      "https://example.com/a"
    );
  });

  test("keeps non-default ports", () => {
    expect(normalizeUrl("https://example.com:8443/a")).toBe(
      "https://example.com:8443/a"
    );
  });

  test("is idempotent", () => {
    const variants = [
      "https://example.com/a/",
      "HTTPS://Example.com/a?utm_source=x",
      "https://example.com/a#top",
      "https://example.com:443/a/",
    ];
    for (const v of variants) {
      const once = normalizeUrl(v);
      const twice = normalizeUrl(once);
      expect(twice).toBe(once);
    }
  });

  test("falls back to lowercased trimmed input for unparseable URLs", () => {
    // Don't throw on garbage - dedup comparison still needs a key.
    expect(normalizeUrl("  not a url  ")).toBe("not a url");
    expect(normalizeUrl("javascript:alert(1)")).toBeTruthy(); // still returns something
  });

  test("the verbraucherzentrale URLs from the ongoing incident normalize to a single canonical form", () => {
    // Real-world bug repro: these are the two URLs the bot kept
    // re-tooting daily. Any of the common variants the feed might emit
    // must collapse to the same key so the follow-up dedup catches them.
    const variants = [
      "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen",
      "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen/",
      "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen?utm_source=feed",
      "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen#content",
      "HTTPS://WWW.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen",
    ];
    const normalized = variants.map(normalizeUrl);
    expect(new Set(normalized).size).toBe(1);
  });
});
