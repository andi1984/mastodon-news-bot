import rssFeedItem2Toot, { FeedItem } from "./rssFeedItem2Toot.js";

function makeFeedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    title: overrides.title ?? "Test Article Title",
    link: overrides.link ?? "https://example.com/article",
    creator: overrides.creator,
    "dc:creator": overrides["dc:creator"] ?? "",
    ...overrides,
  } as FeedItem;
}

describe("rssFeedItem2Toot", () => {
  it("formats a basic toot with title and link", () => {
    const item = makeFeedItem({
      title: "Neuer Radweg in Saarbrücken",
      link: "https://example.com/radweg",
    });
    const toot = rssFeedItem2Toot(item);
    expect(toot).toContain("Neuer Radweg in Saarbrücken");
    expect(toot).toContain("https://example.com/radweg");
  });

  it("includes creator attribution when present", () => {
    const item = makeFeedItem({
      title: "Test Article",
      link: "https://example.com",
      creator: "Max Müller",
    });
    const toot = rssFeedItem2Toot(item);
    expect(toot).toContain("(Max Müller)");
  });

  it("uses dc:creator when creator is not set", () => {
    const item = makeFeedItem({
      title: "Test Article",
      link: "https://example.com",
      creator: undefined,
      "dc:creator": "Anna Schmidt",
    });
    const toot = rssFeedItem2Toot(item);
    expect(toot).toContain("(Anna Schmidt)");
  });

  it("omits creator when neither field is set", () => {
    const item = makeFeedItem({
      title: "Test Article",
      link: "https://example.com",
      creator: undefined,
      "dc:creator": "",
    });
    const toot = rssFeedItem2Toot(item);
    expect(toot).not.toContain("()");
  });

  it("adds hashtags with # prefix", () => {
    const item = makeFeedItem();
    const toot = rssFeedItem2Toot(item, ["news", "Saarland"]);
    expect(toot).toContain("#News");
    expect(toot).toContain("#Saarland");
  });

  it("converts lowercase hashtags to CamelCase", () => {
    const item = makeFeedItem();
    const toot = rssFeedItem2Toot(item, ["saarlandnews"]);
    expect(toot).toContain("#Saarlandnews");
  });

  it("preserves hashtags that already have uppercase", () => {
    const item = makeFeedItem();
    const toot = rssFeedItem2Toot(item, ["SaarlandNews"]);
    expect(toot).toContain("#SaarlandNews");
  });

  it("does not add hashtag section when no hashtags provided", () => {
    const item = makeFeedItem();
    const toot = rssFeedItem2Toot(item);
    expect(toot).not.toContain("#");
  });

  it("does not add hashtag section for empty array", () => {
    const item = makeFeedItem();
    const toot = rssFeedItem2Toot(item, []);
    expect(toot).not.toContain("#");
  });

  it("adds topic emoji prefix for fire-related titles", () => {
    const item = makeFeedItem({ title: "Brand in Saarbrücken" });
    const toot = rssFeedItem2Toot(item);
    expect(toot).toMatch(/^🔥/);
  });

  it("adds topic emoji prefix for police-related titles", () => {
    const item = makeFeedItem({ title: "Polizei sucht Zeugen" });
    const toot = rssFeedItem2Toot(item);
    expect(toot).toMatch(/^🚔/);
  });

  it("no emoji prefix for generic titles", () => {
    const item = makeFeedItem({ title: "Bürgermeister besucht Messe" });
    const toot = rssFeedItem2Toot(item);
    expect(toot).not.toMatch(/^[\u{1F000}-\u{1FFFF}]/u);
  });

  it("formats title, link, and hashtags on separate lines", () => {
    const item = makeFeedItem({
      title: "Test Title",
      link: "https://example.com",
    });
    const toot = rssFeedItem2Toot(item, ["news"]);
    const lines = toot.split("\n");
    // title line, empty line, link line, empty line, hashtags
    expect(lines[0]).toContain("Test Title");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("https://example.com");
    expect(lines[3]).toBe("");
    expect(lines[4]).toContain("#News");
  });

  it("handles missing title gracefully", () => {
    const item = makeFeedItem({ title: undefined as any });
    const toot = rssFeedItem2Toot(item);
    expect(toot).toContain("https://example.com/article");
  });
});
