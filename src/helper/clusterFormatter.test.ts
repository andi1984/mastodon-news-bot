import { formatClusterToot, ClusterFormatOptions } from "./clusterFormatter.js";
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
  feedHashtags: ["news", "saarlandnews"],
  feedSpecificHashtags: { "feed-a": ["extra"] },
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
      "news",
      "saarlandnews",
      "extra",
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
