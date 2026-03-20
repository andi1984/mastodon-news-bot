import {
  tokenize,
  jaccardSimilarity,
  timeProximityScore,
  storySimilarity,
  clusterArticles,
  pickPrimaryArticle,
  isBreakingNews,
  ClusterArticle,
} from "./similarity.js";

function makeArticle(
  overrides: Partial<ClusterArticle> & {
    title?: string;
    feedKey?: string;
    contentSnippet?: string;
  }
): ClusterArticle {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    article: {
      title: overrides.title ?? "Test Article",
      link: `https://example.com/${overrides.id ?? "test"}`,
      "dc:creator": "",
      contentSnippet: overrides.contentSnippet,
      ...(overrides.article as any),
    },
    feedKey: overrides.feedKey ?? "feed-a",
    pubDate: overrides.pubDate ?? new Date().toISOString(),
    score: overrides.score ?? 0.5,
  };
}

describe("tokenize", () => {
  it("lowercases and splits on whitespace", () => {
    const tokens = tokenize("Großbrand Saarbrücken");
    expect(tokens.has("großbrand")).toBe(true);
    expect(tokens.has("saarbrücken")).toBe(true);
  });

  it("preserves German umlauts and ß", () => {
    const tokens = tokenize("Übung Straße Lösung Ärger");
    expect(tokens.has("übung")).toBe(true);
    expect(tokens.has("straße")).toBe(true);
    expect(tokens.has("lösung")).toBe(true);
    expect(tokens.has("ärger")).toBe(true);
  });

  it("removes stopwords", () => {
    const tokens = tokenize("Der Brand in der Innenstadt");
    expect(tokens.has("der")).toBe(false);
    expect(tokens.has("brand")).toBe(true);
    expect(tokens.has("innenstadt")).toBe(true);
  });

  it("removes punctuation", () => {
    const tokens = tokenize("Feuer: Innenstadt betroffen!");
    expect(tokens.has("feuer")).toBe(true);
    expect(tokens.has("innenstadt")).toBe(true);
    expect(tokens.has("betroffen")).toBe(true);
  });

  it("drops tokens shorter than 3 chars", () => {
    const tokens = tokenize("ab cd efg hi");
    expect(tokens.has("ab")).toBe(false);
    expect(tokens.has("cd")).toBe(false);
    expect(tokens.has("efg")).toBe(true);
    expect(tokens.has("hi")).toBe(false);
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it("returns 0 when one set is empty", () => {
    expect(jaccardSimilarity(new Set(["a"]), new Set())).toBe(0);
  });

  it("returns 1 for identical sets", () => {
    const s = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["c", "d"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("computes partial overlap correctly", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    // intersection=2, union=4
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });
});

describe("timeProximityScore", () => {
  it("returns 1.0 within 2 hours", () => {
    const a = new Date("2024-01-01T12:00:00Z");
    const b = new Date("2024-01-01T13:00:00Z");
    expect(timeProximityScore(a, b)).toBe(1.0);
  });

  it("returns 0.0 at 12+ hours", () => {
    const a = new Date("2024-01-01T00:00:00Z");
    const b = new Date("2024-01-01T14:00:00Z");
    expect(timeProximityScore(a, b)).toBe(0.0);
  });

  it("linearly decays between 2h and 12h", () => {
    const a = new Date("2024-01-01T00:00:00Z");
    const b = new Date("2024-01-01T07:00:00Z"); // 7h apart → (7-2)/10 = 0.5 → score 0.5
    expect(timeProximityScore(a, b)).toBeCloseTo(0.5, 5);
  });
});

describe("storySimilarity — same story detection", () => {
  const now = new Date("2024-06-15T10:00:00Z");
  const oneHourLater = new Date("2024-06-15T11:00:00Z");

  it("detects similar stories about same event", () => {
    const sim = storySimilarity(
      "Großbrand in Saarbrücker Innenstadt",
      "Feuer in Saarbrücken: Innenstadt betroffen",
      now,
      oneHourLater
    );
    // Should have decent similarity due to shared "saarbrück*" and "innenstadt" tokens + close time
    expect(sim).toBeGreaterThan(0.3);
  });

  it("keeps unrelated stories separate", () => {
    const sim = storySimilarity(
      "Großbrand in Saarbrücker Innenstadt",
      "Fahrradweg am Bostalsee eröffnet",
      now,
      oneHourLater
    );
    expect(sim).toBeLessThan(0.4);
  });

  it("time decay reduces similarity for distant articles", () => {
    const farApart = new Date("2024-06-16T10:00:00Z"); // 24h later
    const sim = storySimilarity(
      "Großbrand in Saarbrücker Innenstadt",
      "Großbrand in Saarbrücker Innenstadt",
      now,
      farApart
    );
    // Identical titles but 24h apart → jaccard=1.0, time=0.0 → 0.7
    expect(sim).toBeCloseTo(0.7, 5);
  });

  it("uses description to detect same story when titles share few tokens", () => {
    // Simulate two sources covering the same road accident with very different headlines.
    // Title overlap is minimal, but descriptions overlap substantially.
    const sim = storySimilarity(
      "Unfall auf der A6",
      "Sperrung wegen Verkehrsgeschehen",
      now,
      oneHourLater,
      "Schwerer Unfall auf der Autobahn A6 bei Saarbrücken führt zu Vollsperrung. Zwei Fahrzeuge kollidierten.",
      "Die A6 bei Saarbrücken ist nach einem schweren Unfall vollgesperrt. Zwei Autos kollidierten auf der Autobahn."
    );
    expect(sim).toBeGreaterThanOrEqual(0.4);
  });
});

describe("clusterArticles", () => {
  // Note: We pass useSemanticMatching=false in tests to avoid API calls
  // and test the Jaccard-only fallback behavior

  it("clusters 3 articles from 3 feeds about the same story", async () => {
    const now = new Date("2024-06-15T10:00:00Z");
    const articles: ClusterArticle[] = [
      makeArticle({
        id: "1",
        title: "Großbrand in Saarbrücker Innenstadt zerstört Gebäude",
        feedKey: "feed-a",
        pubDate: now.toISOString(),
      }),
      makeArticle({
        id: "2",
        title: "Großbrand Saarbrücken Innenstadt: Gebäude zerstört",
        feedKey: "feed-b",
        pubDate: new Date(now.getTime() + 30 * 60000).toISOString(),
      }),
      makeArticle({
        id: "3",
        title: "Saarbrücker Innenstadt: Großbrand zerstört Gebäude",
        feedKey: "feed-c",
        pubDate: new Date(now.getTime() + 60 * 60000).toISOString(),
      }),
    ];

    const clusters = await clusterArticles(articles, 0.4, false);
    expect(clusters.size).toBe(1);
    const allClusters = Array.from(clusters.values());
    expect(allClusters[0]!.length).toBe(3);
  });

  it("does not cluster articles from the same feed", async () => {
    const now = new Date("2024-06-15T10:00:00Z");
    const articles: ClusterArticle[] = [
      makeArticle({
        id: "1",
        title: "Großbrand in Saarbrücker Innenstadt",
        feedKey: "feed-a",
        pubDate: now.toISOString(),
      }),
      makeArticle({
        id: "2",
        title: "Großbrand in Saarbrücker Innenstadt Update",
        feedKey: "feed-a",
        pubDate: new Date(now.getTime() + 30 * 60000).toISOString(),
      }),
    ];

    const clusters = await clusterArticles(articles, 0.4, false);
    expect(clusters.size).toBe(2);
  });

  it("keeps unrelated stories in separate clusters", async () => {
    const now = new Date("2024-06-15T10:00:00Z");
    const articles: ClusterArticle[] = [
      makeArticle({
        id: "1",
        title: "Großbrand in Saarbrücker Innenstadt",
        feedKey: "feed-a",
        pubDate: now.toISOString(),
      }),
      makeArticle({
        id: "2",
        title: "Neuer Fahrradweg am Bostalsee eröffnet",
        feedKey: "feed-b",
        pubDate: now.toISOString(),
      }),
    ];

    const clusters = await clusterArticles(articles, 0.4, false);
    expect(clusters.size).toBe(2);
  });

  it("returns each article in its own cluster when none are similar", async () => {
    const now = new Date("2024-06-15T10:00:00Z");
    const articles: ClusterArticle[] = [
      makeArticle({
        id: "1",
        title: "Großbrand in Saarbrücker Innenstadt",
        feedKey: "feed-a",
        pubDate: now.toISOString(),
      }),
      makeArticle({
        id: "2",
        title: "Neuer Fahrradweg am Bostalsee eröffnet",
        feedKey: "feed-b",
        pubDate: now.toISOString(),
      }),
      makeArticle({
        id: "3",
        title: "Polizei sucht Zeugen nach Einbruch in Merzig",
        feedKey: "feed-c",
        pubDate: now.toISOString(),
      }),
    ];

    const clusters = await clusterArticles(articles, 0.4, false);
    expect(clusters.size).toBe(3);
    // Each cluster has exactly one article
    for (const [, cluster] of clusters) {
      expect(cluster.length).toBe(1);
    }
  });

  it("clusters articles from different feeds with differing titles but similar descriptions", async () => {
    // Regression: two sources covered the same road accident but with headlines
    // that share almost no tokens. Without description-based similarity they would
    // end up in separate clusters and both get posted.
    const now = new Date("2024-06-15T10:00:00Z");
    const articles: ClusterArticle[] = [
      makeArticle({
        id: "1",
        title: "Unfall auf der A6",
        feedKey: "feed-a",
        pubDate: now.toISOString(),
        contentSnippet:
          "Schwerer Unfall auf der Autobahn A6 bei Saarbrücken führt zu Vollsperrung. Zwei Fahrzeuge kollidierten.",
      }),
      makeArticle({
        id: "2",
        title: "Sperrung wegen Verkehrsgeschehen",
        feedKey: "feed-b",
        pubDate: new Date(now.getTime() + 20 * 60000).toISOString(),
        contentSnippet:
          "Die A6 bei Saarbrücken ist nach einem schweren Unfall vollgesperrt. Zwei Autos kollidierten auf der Autobahn.",
      }),
    ];

    const clusters = await clusterArticles(articles, 0.4, false);
    expect(clusters.size).toBe(1);
    const allArticles = Array.from(clusters.values())[0]!;
    expect(allArticles.length).toBe(2);
  });

  it("returns a single-article cluster for a single input", async () => {
    const articles: ClusterArticle[] = [
      makeArticle({
        id: "1",
        title: "Einzelne Meldung",
        feedKey: "feed-a",
      }),
    ];

    const clusters = await clusterArticles(articles, 0.4, false);
    expect(clusters.size).toBe(1);
    const cluster = Array.from(clusters.values())[0]!;
    expect(cluster.length).toBe(1);
    expect(cluster[0].id).toBe("1");
  });
});

describe("pickPrimaryArticle", () => {
  it("picks the article with highest feed priority", () => {
    const cluster: ClusterArticle[] = [
      makeArticle({ id: "1", feedKey: "low", score: 0.5 }),
      makeArticle({ id: "2", feedKey: "high", score: 0.5 }),
    ];
    const primary = pickPrimaryArticle(cluster, { low: 0.3, high: 0.9 });
    expect(primary.feedKey).toBe("high");
  });

  it("breaks ties with freshest article", () => {
    const cluster: ClusterArticle[] = [
      makeArticle({
        id: "1",
        feedKey: "a",
        pubDate: "2024-06-15T10:00:00Z",
      }),
      makeArticle({
        id: "2",
        feedKey: "b",
        pubDate: "2024-06-15T12:00:00Z",
      }),
    ];
    // Same default priority (0.5), so freshest wins
    const primary = pickPrimaryArticle(cluster, {});
    expect(primary.id).toBe("2");
  });
});

describe("isBreakingNews", () => {
  it("returns true when 3+ feeds publish within 2 hours", () => {
    const base = new Date("2024-06-15T10:00:00Z");
    const cluster: ClusterArticle[] = [
      makeArticle({
        id: "1",
        feedKey: "feed-a",
        pubDate: base.toISOString(),
      }),
      makeArticle({
        id: "2",
        feedKey: "feed-b",
        pubDate: new Date(base.getTime() + 30 * 60000).toISOString(),
      }),
      makeArticle({
        id: "3",
        feedKey: "feed-c",
        pubDate: new Date(base.getTime() + 90 * 60000).toISOString(),
      }),
    ];
    expect(isBreakingNews(cluster, 2, 3)).toBe(true);
  });

  it("returns false when fewer than minSources unique feeds", () => {
    const base = new Date("2024-06-15T10:00:00Z");
    const cluster: ClusterArticle[] = [
      makeArticle({
        id: "1",
        feedKey: "feed-a",
        pubDate: base.toISOString(),
      }),
      makeArticle({
        id: "2",
        feedKey: "feed-b",
        pubDate: new Date(base.getTime() + 30 * 60000).toISOString(),
      }),
    ];
    expect(isBreakingNews(cluster, 2, 3)).toBe(false);
  });

  it("returns false when articles are spread over more than the time window", () => {
    const base = new Date("2024-06-15T10:00:00Z");
    const cluster: ClusterArticle[] = [
      makeArticle({
        id: "1",
        feedKey: "feed-a",
        pubDate: base.toISOString(),
      }),
      makeArticle({
        id: "2",
        feedKey: "feed-b",
        pubDate: new Date(base.getTime() + 3 * 3600000).toISOString(), // 3h later
      }),
      makeArticle({
        id: "3",
        feedKey: "feed-c",
        pubDate: new Date(base.getTime() + 6 * 3600000).toISOString(), // 6h later
      }),
    ];
    // No window of 3 articles within 2h
    expect(isBreakingNews(cluster, 2, 3)).toBe(false);
  });
});
