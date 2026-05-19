import {
  parseFeedItemDate,
  filterFeedItemsByAge,
  filterFeedItemsByKeywords,
  FilteredFeedItem,
  RawFeedItem,
} from "./feedItemFilter";

const makeItem = (fields: Partial<RawFeedItem>): FilteredFeedItem => ({
  item: fields,
  pubDate: new Date("2026-03-28T10:00:00Z"),
});

describe("filterFeedItemsByKeywords", () => {
  const keywords = ["saarland", "saarbrücken"];

  it("accepts item whose title contains a keyword", () => {
    const items = [makeItem({ title: "News aus Saarland heute" })];
    const { accepted, filteredCount } = filterFeedItemsByKeywords(items, keywords);
    expect(accepted).toHaveLength(1);
    expect(filteredCount).toBe(0);
  });

  it("accepts item whose contentSnippet contains a keyword", () => {
    const items = [makeItem({ title: "Breaking", contentSnippet: "Ereignis in Saarbrücken" })];
    const { accepted, filteredCount } = filterFeedItemsByKeywords(items, keywords);
    expect(accepted).toHaveLength(1);
    expect(filteredCount).toBe(0);
  });

  it("rejects item with no keyword match", () => {
    const items = [makeItem({ title: "Bundesliga Ergebnis Bayern", contentSnippet: "Bayern gewinnt" })];
    const { accepted, filteredCount } = filterFeedItemsByKeywords(items, keywords);
    expect(accepted).toHaveLength(0);
    expect(filteredCount).toBe(1);
  });

  it("is case-insensitive", () => {
    const items = [makeItem({ title: "SAARLAND aktuell" })];
    const { accepted } = filterFeedItemsByKeywords(items, keywords);
    expect(accepted).toHaveLength(1);
  });

  it("returns all items when keywords list is empty", () => {
    const items = [
      makeItem({ title: "Unrelated article" }),
      makeItem({ title: "Another irrelevant item" }),
    ];
    const { accepted, filteredCount } = filterFeedItemsByKeywords(items, []);
    expect(accepted).toHaveLength(2);
    expect(filteredCount).toBe(0);
  });

  it("handles empty items array", () => {
    const { accepted, filteredCount } = filterFeedItemsByKeywords([], keywords);
    expect(accepted).toHaveLength(0);
    expect(filteredCount).toBe(0);
  });

  it("mixes accepted and rejected correctly", () => {
    const items = [
      makeItem({ title: "Saarland Nachrichten" }),
      makeItem({ title: "Berlin Wetter" }),
      makeItem({ title: "Konzert in Saarbrücken" }),
    ];
    const { accepted, filteredCount } = filterFeedItemsByKeywords(items, keywords);
    expect(accepted).toHaveLength(2);
    expect(filteredCount).toBe(1);
  });

  it("checks content and summary fields too", () => {
    const items = [makeItem({ title: "Lokales", content: "Bericht über Saarland", summary: "" })];
    const { accepted } = filterFeedItemsByKeywords(items, keywords);
    expect(accepted).toHaveLength(1);
  });
});

describe("parseFeedItemDate", () => {
  it("parses pubDate field", () => {
    const item: RawFeedItem = { pubDate: "2026-03-28T10:00:00Z" };
    const result = parseFeedItemDate(item);
    expect(result.toISOString()).toBe("2026-03-28T10:00:00.000Z");
  });

  it("falls back to isoDate if pubDate is missing", () => {
    const item: RawFeedItem = { isoDate: "2026-03-27T15:30:00Z" };
    const result = parseFeedItemDate(item);
    expect(result.toISOString()).toBe("2026-03-27T15:30:00.000Z");
  });

  it("prefers pubDate over isoDate", () => {
    const item: RawFeedItem = {
      pubDate: "2026-03-28T10:00:00Z",
      isoDate: "2026-03-27T15:30:00Z",
    };
    const result = parseFeedItemDate(item);
    expect(result.toISOString()).toBe("2026-03-28T10:00:00.000Z");
  });

  it("returns current date if no date fields present", () => {
    const before = new Date();
    const item: RawFeedItem = { title: "No date" };
    const result = parseFeedItemDate(item);
    const after = new Date();

    expect(result.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("returns current date for invalid date string", () => {
    const before = new Date();
    const item: RawFeedItem = { pubDate: "not-a-valid-date" };
    const result = parseFeedItemDate(item);
    const after = new Date();

    expect(result.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

describe("filterFeedItemsByAge", () => {
  const now = new Date("2026-03-28T12:00:00Z");

  it("accepts items within the age threshold", () => {
    const items: RawFeedItem[] = [
      { title: "Fresh news", pubDate: "2026-03-28T10:00:00Z" }, // 2 hours old
      { title: "Also fresh", pubDate: "2026-03-28T00:00:00Z" }, // 12 hours old
    ];

    const result = filterFeedItemsByAge(items, 24, now);

    expect(result.accepted).toHaveLength(2);
    expect(result.filteredCount).toBe(0);
  });

  it("filters out items older than the threshold", () => {
    const items: RawFeedItem[] = [
      { title: "Fresh news", pubDate: "2026-03-28T10:00:00Z" }, // 2 hours old
      { title: "Old news", pubDate: "2026-03-27T10:00:00Z" }, // 26 hours old
      { title: "Very old", pubDate: "2026-01-01T00:00:00Z" }, // months old
    ];

    const result = filterFeedItemsByAge(items, 24, now);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].item.title).toBe("Fresh news");
    expect(result.filteredCount).toBe(2);
  });

  it("handles edge case at exactly the threshold", () => {
    const items: RawFeedItem[] = [
      { title: "Exactly 24h", pubDate: "2026-03-27T12:00:00Z" }, // exactly 24 hours
    ];

    const result = filterFeedItemsByAge(items, 24, now);

    // Items at exactly the cutoff are accepted (pubDate < cutoff, not <=)
    expect(result.accepted).toHaveLength(1);
    expect(result.filteredCount).toBe(0);
  });

  it("accepts items just within threshold", () => {
    const items: RawFeedItem[] = [
      { title: "Just fresh", pubDate: "2026-03-27T12:00:01Z" }, // 23h 59m 59s old
    ];

    const result = filterFeedItemsByAge(items, 24, now);

    expect(result.accepted).toHaveLength(1);
    expect(result.filteredCount).toBe(0);
  });

  it("handles empty items array", () => {
    const result = filterFeedItemsByAge([], 24, now);

    expect(result.accepted).toHaveLength(0);
    expect(result.filteredCount).toBe(0);
  });

  it("treats items without dates as fresh (current time)", () => {
    const items: RawFeedItem[] = [
      { title: "No date field" },
      { title: "Invalid date", pubDate: "garbage" },
    ];

    const result = filterFeedItemsByAge(items, 24, now);

    // Items without valid dates get current time, so they should pass
    expect(result.accepted).toHaveLength(2);
    expect(result.filteredCount).toBe(0);
  });

  it("preserves original item data in accepted results", () => {
    const items: RawFeedItem[] = [
      {
        title: "Full item",
        link: "https://example.com/news",
        pubDate: "2026-03-28T10:00:00Z",
        customField: "preserved",
      },
    ];

    const result = filterFeedItemsByAge(items, 24, now);

    expect(result.accepted[0].item).toEqual(items[0]);
    expect(result.accepted[0].item.customField).toBe("preserved");
  });

  it("includes parsed pubDate in accepted results", () => {
    const items: RawFeedItem[] = [
      { title: "Test", pubDate: "2026-03-28T10:00:00Z" },
    ];

    const result = filterFeedItemsByAge(items, 24, now);

    expect(result.accepted[0].pubDate).toBeInstanceOf(Date);
    expect(result.accepted[0].pubDate.toISOString()).toBe(
      "2026-03-28T10:00:00.000Z"
    );
  });

  it("filters articles from months ago", () => {
    const items: RawFeedItem[] = [
      { title: "January article", pubDate: "2026-01-15T10:00:00Z" },
      { title: "December article", pubDate: "2025-12-01T10:00:00Z" },
      { title: "Fresh article", pubDate: "2026-03-28T11:00:00Z" },
    ];

    const result = filterFeedItemsByAge(items, 24, now);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].item.title).toBe("Fresh article");
    expect(result.filteredCount).toBe(2);
  });

  it("uses current time as default when now is not provided (default parameter branch)", () => {
    // Recent item should pass when now defaults to current time
    const recentDate = new Date();
    recentDate.setHours(recentDate.getHours() - 1); // 1 hour ago
    const items: RawFeedItem[] = [
      { title: "Recent item", pubDate: recentDate.toISOString() },
    ];

    // Call WITHOUT the 'now' argument to exercise the default parameter branch
    const result = filterFeedItemsByAge(items, 24);

    expect(result.accepted).toHaveLength(1);
    expect(result.filteredCount).toBe(0);
  });
});
