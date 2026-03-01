import type { mastodon } from "masto";
import {
  extractTitleFromStatus,
  extractLinkFromStatus,
  formatDigestToot,
  DigestEntry,
} from "./digestFormatter.js";

function createMockStatus(
  overrides: Partial<{
    content: string;
    card: { url: string } | null;
  }> = {}
): mastodon.v1.Status {
  return {
    content: overrides.content ?? "<p>Test article title #news</p>",
    card: overrides.card ?? null,
  } as mastodon.v1.Status;
}

describe("extractTitleFromStatus", () => {
  test("strips HTML tags and takes text before first hashtag", () => {
    const status = createMockStatus({
      content: "<p>Saarbrücken: Neue Brücke eröffnet #saarlandnews #news</p>",
    });
    expect(extractTitleFromStatus(status)).toBe("Saarbrücken: Neue Brücke eröffnet");
  });

  test("decodes HTML entities", () => {
    const status = createMockStatus({
      content: "<p>Firma A &amp; B: Gewinn &gt; 1 Mio &euro; #news</p>",
    });
    expect(extractTitleFromStatus(status)).toBe("Firma A & B: Gewinn > 1 Mio &euro;");
  });

  test("returns full text when no hashtag present", () => {
    const status = createMockStatus({
      content: "<p>Breaking: Major event in Saarland</p>",
    });
    expect(extractTitleFromStatus(status)).toBe("Breaking: Major event in Saarland");
  });

  test("handles <br> tags as spaces", () => {
    const status = createMockStatus({
      content: "<p>Title here<br/>More text #news</p>",
    });
    expect(extractTitleFromStatus(status)).toBe("Title here More text");
  });

  test("handles content with creator attribution via links", () => {
    const status = createMockStatus({
      content:
        '<p>Wichtiges Update zur Lage <a href="https://example.com/article">example.com/article</a> #saarlandnews</p>',
    });
    expect(extractTitleFromStatus(status)).toBe(
      "Wichtiges Update zur Lage example.com/article"
    );
  });
});

describe("extractLinkFromStatus", () => {
  test("returns card URL when available", () => {
    const status = createMockStatus({
      content: "<p>Some text</p>",
      card: { url: "https://example.com/article" },
    });
    expect(extractLinkFromStatus(status)).toBe("https://example.com/article");
  });

  test("falls back to last non-hashtag link from content", () => {
    const status = createMockStatus({
      content:
        '<p>Headline <a href="https://example.com/story">link</a> <a href="https://mastodon.example/tags/news">#news</a></p>',
      card: null,
    });
    expect(extractLinkFromStatus(status)).toBe("https://example.com/story");
  });

  test("returns null when no card and no links", () => {
    const status = createMockStatus({
      content: "<p>Just text, no links</p>",
      card: null,
    });
    expect(extractLinkFromStatus(status)).toBeNull();
  });

  test("returns null when only hashtag links present", () => {
    const status = createMockStatus({
      content:
        '<p>Text <a href="https://mastodon.example/tags/news">#news</a></p>',
      card: null,
    });
    expect(extractLinkFromStatus(status)).toBeNull();
  });
});

describe("formatDigestToot", () => {
  test("formats a basic digest with entries", () => {
    const entries: DigestEntry[] = [
      { title: "Top Story", link: "https://example.com/1", score: 10 },
      { title: "Second Story", link: "https://example.com/2", score: 5 },
    ];
    const result = formatDigestToot(entries);

    expect(result).toContain("Wichtigste Nachrichten des Tages");
    expect(result).toContain("1. Top Story");
    expect(result).not.toContain("(10)");
    expect(result).toContain("https://example.com/1");
    expect(result).toContain("2. Second Story");
    expect(result).not.toContain("(5)");
    expect(result).toContain("https://example.com/2");
    expect(result).toContain("#saarlandnews #news #tageszusammenfassung");
  });

  test("respects 500 character limit", () => {
    const entries: DigestEntry[] = Array.from({ length: 10 }, (_, i) => ({
      title: "A".repeat(100) + ` Story ${i + 1}`,
      link: `https://example.com/very-long-url-path-${i + 1}`,
      score: 10 - i,
    }));
    const result = formatDigestToot(entries);

    expect(result.length).toBeLessThanOrEqual(500);
    expect(result).toContain("Wichtigste Nachrichten des Tages");
    expect(result).toContain("#saarlandnews #news #tageszusammenfassung");
  });

  test("truncates long titles with ellipsis", () => {
    const entries: DigestEntry[] = [
      { title: "A".repeat(400), link: "https://example.com", score: 5 },
    ];
    const result = formatDigestToot(entries);

    expect(result.length).toBeLessThanOrEqual(500);
    expect(result).toContain("\u2026");
  });

  test("returns empty string for no entries", () => {
    expect(formatDigestToot([])).toBe("");
  });

  test("handles entries without links", () => {
    const entries: DigestEntry[] = [
      { title: "No link story", link: null, score: 3 },
    ];
    const result = formatDigestToot(entries);

    expect(result).toContain("1. No link story");
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
  });
});
