import { formatClusterToot, ClusterFormatOptions, formatThreadReply } from "./clusterFormatter.js";
import rssFeedItem2Toot from "./rssFeedItem2Toot.js";
import { ClusterArticle } from "./similarity.js";

function makeArticle(overrides: {
  id?: string;
  title?: string;
  link?: string;
  feedKey?: string;
  pubDate?: string;
  creator?: string;
}): ClusterArticle {
  return {
    id: overrides.id ?? "1",
    article: {
      title: overrides.title ?? "Test Article",
      link: overrides.link ?? "https://example.com/article",
      creator: overrides.creator ?? "",
      "dc:creator": "",
    } as any,
    feedKey: overrides.feedKey ?? "feed-a",
    pubDate: overrides.pubDate ?? new Date().toISOString(),
    score: 0.5,
  };
}

const defaultOptions: ClusterFormatOptions = {
  feedPriorities: { "feed-a": 0.9, "feed-b": 0.5, "feed-c": 0.3 },
  hashtags: ["News", "Saarlandnews", "Extra"],
  breakingNewsMinSources: 3,
  breakingNewsTimeWindowHours: 2,
};

describe("formatClusterToot", () => {
  it("single source delegates to original format", () => {
    const cluster = [
      makeArticle({
        title: "Feuer in Saarbrücken",
        link: "https://example.com/1",
        creator: "Max Mustermann",
        feedKey: "feed-a",
      }),
    ];
    const result = formatClusterToot(cluster, defaultOptions);
    // Should match rssFeedItem2Toot format with CamelCase hashtags in footer
    expect(result).toContain("Feuer in Saarbrücken");
    expect(result).toContain("Max Mustermann");
    expect(result).toContain("#News");
    expect(result).toContain("#Saarlandnews");
    expect(result).toContain("#Extra");
    expect(result).toContain("https://example.com/1");
  });

  it("multi-source includes Quellen: block", () => {
    const now = new Date("2024-06-15T10:00:00Z");
    const cluster = [
      makeArticle({
        id: "1",
        title: "Feuer in Saarbrücken",
        link: "https://a.com/1",
        feedKey: "feed-a",
        pubDate: now.toISOString(),
      }),
      makeArticle({
        id: "2",
        title: "Feuer Saarbrücken Innenstadt",
        link: "https://b.com/2",
        feedKey: "feed-b",
        pubDate: new Date(now.getTime() + 30 * 60000).toISOString(),
      }),
    ];
    const result = formatClusterToot(cluster, defaultOptions);
    expect(result).toContain("Quellen:");
    expect(result).toContain("feed-a: https://a.com/1");
    expect(result).toContain("feed-b: https://b.com/2");
    expect(result).not.toContain("EILMELDUNG");
  });

  it("breaking news has EILMELDUNG prefix and #eilmeldung hashtag", () => {
    const now = new Date("2024-06-15T10:00:00Z");
    const cluster = [
      makeArticle({
        id: "1",
        title: "Großbrand in Saarbrücker Innenstadt",
        link: "https://a.com/1",
        feedKey: "feed-a",
        pubDate: now.toISOString(),
      }),
      makeArticle({
        id: "2",
        title: "Großbrand Saarbrücken",
        link: "https://b.com/2",
        feedKey: "feed-b",
        pubDate: new Date(now.getTime() + 30 * 60000).toISOString(),
      }),
      makeArticle({
        id: "3",
        title: "Großbrand Saarbrücken Innenstadt",
        link: "https://c.com/3",
        feedKey: "feed-c",
        pubDate: new Date(now.getTime() + 60 * 60000).toISOString(),
      }),
    ];
    const result = formatClusterToot(cluster, defaultOptions);
    // Emoji may be prepended, so check for EILMELDUNG: anywhere near start
    expect(result).toMatch(/^.{0,5}EILMELDUNG:/);
    expect(result).toContain("#Eilmeldung");
    expect(result).toContain("Quellen:");
  });

  it("respects 500-char limit by truncating source list", () => {
    const now = new Date("2024-06-15T10:00:00Z");
    const longTitle = "A".repeat(300);
    const cluster = [
      makeArticle({
        id: "1",
        title: longTitle,
        link: "https://very-long-domain-name-example.com/article/1",
        feedKey: "feed-a",
        pubDate: now.toISOString(),
      }),
      makeArticle({
        id: "2",
        title: longTitle,
        link: "https://very-long-domain-name-example.com/article/2",
        feedKey: "feed-b",
        pubDate: new Date(now.getTime() + 30 * 60000).toISOString(),
      }),
      makeArticle({
        id: "3",
        title: longTitle,
        link: "https://very-long-domain-name-example.com/article/3",
        feedKey: "feed-c",
        pubDate: new Date(now.getTime() + 60 * 60000).toISOString(),
      }),
    ];
    const result = formatClusterToot(cluster, defaultOptions);
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it("single-source cluster produces identical output to rssFeedItem2Toot", () => {
    const cluster = [
      makeArticle({
        title: "Polizei sucht Zeugen",
        link: "https://example.com/polizei",
        creator: "Redaktion",
        feedKey: "feed-a",
      }),
    ];
    const clusterResult = formatClusterToot(cluster, defaultOptions);
    const directResult = rssFeedItem2Toot(cluster[0].article, [
      "News",
      "Saarlandnews",
      "Extra",
    ]);
    expect(clusterResult).toBe(directResult);
  });

  it("no-cluster scenario: each unrelated article formats as single-source toot", () => {
    const articles = [
      makeArticle({
        id: "1",
        title: "Feuer in Saarbrücken",
        link: "https://a.com/1",
        feedKey: "feed-a",
      }),
      makeArticle({
        id: "2",
        title: "Neuer Radweg eröffnet",
        link: "https://b.com/2",
        feedKey: "feed-b",
      }),
    ];

    // Each article in its own cluster — both should produce standard format (no Quellen:)
    for (const article of articles) {
      const result = formatClusterToot([article], defaultOptions);
      expect(result).not.toContain("Quellen:");
      expect(result).toContain(article.article.title!);
      expect(result).toContain(article.article.link!);
    }
  });
});

describe("formatThreadReply", () => {
  const feedPriorities = { "feed-a": 0.9, "feed-b": 0.5, "feed-c": 0.3 };

  it("basic thread reply with single article", () => {
    const articles = [
      makeArticle({
        id: "1",
        title: "Update on breaking story",
        link: "https://a.com/update",
        feedKey: "feed-a",
      }),
    ];
    const result = formatThreadReply(articles, feedPriorities);
    expect(result).toContain("Update: Update on breaking story");
    expect(result).toContain("feed-a: https://a.com/update");
  });

  it("thread reply with multiple sources shows source count", () => {
    const articles = [
      makeArticle({
        id: "1",
        title: "Story update",
        link: "https://a.com/1",
        feedKey: "feed-a",
      }),
      makeArticle({
        id: "2",
        title: "Story update v2",
        link: "https://b.com/2",
        feedKey: "feed-b",
      }),
    ];
    const result = formatThreadReply(articles, feedPriorities);
    expect(result).toContain("Update (2 Quellen):");
    expect(result).toContain("feed-a: https://a.com/1");
    expect(result).toContain("feed-b: https://b.com/2");
  });

  it("handles all-duplicate links gracefully (defensive case - feed-tooter filters these upstream)", () => {
    // Note: In production, feed-tooter.ts skips thread replies entirely when all links
    // are duplicates. This test covers the defensive behavior if formatThreadReply
    // is called directly with duplicate links.
    const originalLinks = ["https://a.com/original"];
    const articles = [
      makeArticle({
        id: "1",
        title: "Same story different angle",
        link: "https://a.com/original", // Same link as original!
        feedKey: "feed-a",
      }),
    ];
    const result = formatThreadReply(articles, feedPriorities, originalLinks);
    // Should NOT include the link since it's already in the quoted toot
    expect(result).not.toContain("https://a.com/original");
    expect(result).toContain("Update: Same story different angle");
    expect(result).toContain("(feed-a)"); // Source name only, no link
  });

  it("excludes duplicate links across multiple follow-up articles", () => {
    const originalLinks = ["https://a.com/original", "https://b.com/original"];
    const articles = [
      makeArticle({
        id: "1",
        title: "New coverage",
        link: "https://a.com/original", // Same as original
        feedKey: "feed-a",
      }),
      makeArticle({
        id: "2",
        title: "Fresh take",
        link: "https://c.com/new", // New link
        feedKey: "feed-c",
      }),
    ];
    const result = formatThreadReply(articles, feedPriorities, originalLinks);
    // Primary link was excluded, but new link should appear
    expect(result).not.toContain("https://a.com/original");
    expect(result).toContain("https://c.com/new");
    expect(result).toContain("(feed-a)"); // Primary source with no link
    expect(result).toContain("feed-c: https://c.com/new");
  });

  it("includes new links not in original toot", () => {
    const originalLinks = ["https://old.com/1"];
    const articles = [
      makeArticle({
        id: "1",
        title: "Completely new article",
        link: "https://new.com/article",
        feedKey: "feed-a",
      }),
    ];
    const result = formatThreadReply(articles, feedPriorities, originalLinks);
    expect(result).toContain("https://new.com/article");
    expect(result).toContain("feed-a: https://new.com/article");
  });

  it("deduplicates links within follow-up articles", () => {
    const articles = [
      makeArticle({
        id: "1",
        title: "Article 1",
        link: "https://shared.com/link",
        feedKey: "feed-a",
      }),
      makeArticle({
        id: "2",
        title: "Article 2",
        link: "https://shared.com/link", // Same link different feed
        feedKey: "feed-b",
      }),
    ];
    const result = formatThreadReply(articles, feedPriorities);
    // Link should appear only once
    const linkMatches = result.match(/https:\/\/shared\.com\/link/g);
    expect(linkMatches?.length).toBe(1);
  });

  // ---- Regression tests for the daily re-toot bug ----
  //
  // Background: the `verbraucherzentrale` feed re-emits the same article
  // for weeks, sometimes with a cosmetic URL tweak (trailing slash,
  // tracking param, fragment). `formatThreadReply` was comparing links
  // with raw string equality, so the variant was treated as "new" and
  // included in the quote post even though the primary toot already
  // linked the same page. These tests pin that behavior shut.

  it("treats trailing-slash URL as duplicate of no-slash URL in excludeLinks", () => {
    const originalLinks = [
      "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen",
    ];
    const articles = [
      makeArticle({
        id: "1",
        title: "Klage gegen Stadtsparkasse München",
        link: "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen/",
        feedKey: "verbraucherzentrale",
      }),
    ];
    const result = formatThreadReply(articles, feedPriorities, originalLinks);
    // The URL must not appear at all - it's the same page as the original.
    expect(result).not.toMatch(/stadtsparkasse-muenchen/);
  });

  it("treats utm-param URL as duplicate of clean URL in excludeLinks", () => {
    const originalLinks = ["https://example.com/article"];
    const articles = [
      makeArticle({
        id: "1",
        title: "Same article",
        link: "https://example.com/article?utm_source=rss&utm_medium=feed",
        feedKey: "feed-a",
      }),
    ];
    const result = formatThreadReply(articles, feedPriorities, originalLinks);
    expect(result).not.toMatch(/example\.com\/article/);
  });

  it("treats fragment-only URL variation as duplicate in excludeLinks", () => {
    const originalLinks = ["https://example.com/article"];
    const articles = [
      makeArticle({
        id: "1",
        title: "Same article",
        link: "https://example.com/article#read-more",
        feedKey: "feed-a",
      }),
    ];
    const result = formatThreadReply(articles, feedPriorities, originalLinks);
    expect(result).not.toMatch(/example\.com\/article/);
  });

  it("treats mixed-case-host URL as duplicate of lowercase URL in excludeLinks", () => {
    const originalLinks = ["https://example.com/article"];
    const articles = [
      makeArticle({
        id: "1",
        title: "Same article",
        link: "HTTPS://Example.COM/article",
        feedKey: "feed-a",
      }),
    ];
    const result = formatThreadReply(articles, feedPriorities, originalLinks);
    expect(result).not.toMatch(/[Ee]xample\.[Cc][Oo][Mm]\/article/);
  });

  it("deduplicates cosmetic URL variants across multiple follow-up articles", () => {
    // Multi-source cluster where two feeds emit the same page via
    // slightly different URLs - the second copy must be filtered.
    const articles = [
      makeArticle({
        id: "1",
        title: "Article",
        link: "https://shared.com/page",
        feedKey: "feed-a",
      }),
      makeArticle({
        id: "2",
        title: "Article (other feed)",
        link: "https://shared.com/page/?utm_source=twitter",
        feedKey: "feed-b",
      }),
    ];
    const result = formatThreadReply(articles, feedPriorities);
    const linkMatches = result.match(/shared\.com\/page/g);
    expect(linkMatches?.length).toBe(1);
  });
});
