import { jest, describe, test, expect, beforeEach } from "@jest/globals";

const mockParseURL = jest.fn();

jest.unstable_mockModule("rss-parser", () => ({
  default: jest.fn().mockImplementation(() => ({
    parseURL: mockParseURL,
  })),
}));

const { default: getFeed } = await import("./getFeed.js");

describe("getFeed", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns parsed feed on success", async () => {
    const mockFeed = {
      items: [
        { title: "Article 1", link: "https://example.com/1" },
        { title: "Article 2", link: "https://example.com/2" },
      ],
    };
    mockParseURL.mockResolvedValue(mockFeed);

    const result = await getFeed("https://example.com/feed");
    expect(result).toEqual(mockFeed);
    expect(result!.items).toHaveLength(2);
  });

  test("returns null on general error", async () => {
    mockParseURL.mockRejectedValue(new Error("Network failure"));

    const result = await getFeed("https://example.com/feed");
    expect(result).toBeNull();
  });

  test("returns null on 503 status (temporary unavailability)", async () => {
    mockParseURL.mockRejectedValue(new Error("Status code 503"));

    const result = await getFeed("https://example.com/feed");
    expect(result).toBeNull();
  });

  test("returns null on 502 status", async () => {
    mockParseURL.mockRejectedValue(new Error("Status code 502"));

    const result = await getFeed("https://example.com/feed");
    expect(result).toBeNull();
  });

  test("returns null on 504 status", async () => {
    mockParseURL.mockRejectedValue(new Error("Status code 504"));

    const result = await getFeed("https://example.com/feed");
    expect(result).toBeNull();
  });

  test("returns feed with empty items array", async () => {
    mockParseURL.mockResolvedValue({ items: [] });

    const result = await getFeed("https://example.com/empty-feed");
    expect(result).toEqual({ items: [] });
    expect(result!.items).toHaveLength(0);
  });

  test("handles error without message property", async () => {
    mockParseURL.mockRejectedValue("string error");

    const result = await getFeed("https://example.com/feed");
    expect(result).toBeNull();
  });
});
