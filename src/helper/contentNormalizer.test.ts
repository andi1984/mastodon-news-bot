import { describe, test, expect } from "@jest/globals";
import { normalizeTootContent } from "./contentNormalizer.js";

describe("normalizeTootContent", () => {
  test("returns empty string for null/undefined/empty", () => {
    expect(normalizeTootContent(null)).toBe("");
    expect(normalizeTootContent(undefined)).toBe("");
    expect(normalizeTootContent("")).toBe("");
  });

  test("strips HTML tags", () => {
    const html = "<p>Hello <strong>world</strong></p>";
    expect(normalizeTootContent(html)).toBe("hello world");
  });

  test("converts <br> to whitespace", () => {
    const html = "<p>Line one<br>Line two<br/>Line three</p>";
    expect(normalizeTootContent(html)).toBe("line one line two line three");
  });

  test("decodes common HTML entities", () => {
    const html = "<p>Rock &amp; Roll &quot;90s&quot; &lt;3 &#39;yes&#39;</p>";
    expect(normalizeTootContent(html)).toBe('rock & roll "90s" <3 \'yes\'');
  });

  test("collapses whitespace and trims", () => {
    const html = "   <p>  lots   of\n\nspaces  </p>   ";
    expect(normalizeTootContent(html)).toBe("lots of spaces");
  });

  test("lowercases output", () => {
    const html = "<p>Saarland NEWS Tag</p>";
    expect(normalizeTootContent(html)).toBe("saarland news tag");
  });

  test("strips hashtags with ASCII words", () => {
    const html = "<p>Musik im Advent #News #Saarlandnews #Advent</p>";
    expect(normalizeTootContent(html)).toBe("musik im advent");
  });

  test("strips hashtags containing German umlauts", () => {
    const html = "<p>Egerländer Klänge #Veranstaltung #EgerländerMusik #Grüße</p>";
    expect(normalizeTootContent(html)).toBe("egerländer klänge");
  });

  test("strips hashtag markup as rendered by Mastodon", () => {
    const html =
      '<p>Musik im Advent</p><p><a href="https://dibbelabb.es/tags/News" class="mention hashtag" rel="tag">#<span>News</span></a> <a href="https://dibbelabb.es/tags/AdventMusik" class="mention hashtag" rel="tag">#<span>AdventMusik</span></a></p>';
    // Mastodon wraps hashtags in anchors with a span; after HTML strip the
    // leftover is "#News #AdventMusik" which the hashtag rule then removes.
    expect(normalizeTootContent(html)).toBe("musik im advent");
  });

  test("two toots differing only by AI-generated hashtags normalize identically", () => {
    // This is the regression that caused 9 reposts in 2 days: same article,
    // different AI hashtags. The duplicate detector must collapse them.
    const tootA =
      '<p>Musik im Advent (Eriot7)</p><p><a href="https://udt3000.org/event/musik-im-advent-2/">https://udt3000.org/event/musik-im-advent-2/</a></p><p>#News #Saarlandnews #AdventMusik</p>';
    const tootB =
      '<p>Musik im Advent (Eriot7)</p><p><a href="https://udt3000.org/event/musik-im-advent-2/">https://udt3000.org/event/musik-im-advent-2/</a></p><p>#News #Saarlandnews #AdventsMusik #KulturelleVeranstaltungen</p>';

    expect(normalizeTootContent(tootA)).toBe(normalizeTootContent(tootB));
  });

  test("two toots with different titles do NOT collapse", () => {
    const tootA = "<p>Egerländer Klänge #News #Saarlandnews</p>";
    const tootB = "<p>Musik im Advent #News #Saarlandnews</p>";
    expect(normalizeTootContent(tootA)).not.toBe(normalizeTootContent(tootB));
  });

  test("hashtag rule does not eat the '#' in a regular sentence without word chars", () => {
    // '# hello' has a space after, so the word-char class doesn't match → '#' stays
    const html = "<p>Score: 10 # of attempts</p>";
    expect(normalizeTootContent(html)).toBe("score: 10 # of attempts");
  });
});
