import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const mockParseString = jest.fn();

jest.unstable_mockModule("rss-parser", () => ({
  default: jest.fn().mockImplementation(() => ({
    parseString: mockParseString,
  })),
}));

const { default: getFeed } = await import("./getFeed.js");

const xmlResponse = (body: string, init?: ResponseInit) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
    ...init,
  });

describe("getFeed", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns parsed feed on success", async () => {
    const mockFeed = {
      items: [
        { title: "Article 1", link: "https://example.com/1" },
        { title: "Article 2", link: "https://example.com/2" },
      ],
    };
    globalThis.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(xmlResponse("<rss/>"));
    mockParseString.mockResolvedValue(mockFeed);

    const result = await getFeed("https://example.com/feed");
    expect(result).toEqual(mockFeed);
    expect(result!.items).toHaveLength(2);
    expect(mockParseString).toHaveBeenCalledWith("<rss/>");
  });

  test("passes an abort signal so a hung transfer cannot outlive the timeout", async () => {
    globalThis.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(xmlResponse("<rss/>"));
    mockParseString.mockResolvedValue({ items: [] });

    await getFeed("https://example.com/feed");

    const init = (globalThis.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("decodes ISO-8859-1 bodies via the content-type charset", async () => {
    // "Saarbrücken" with the ü encoded as latin-1 byte 0xFC
    const latin1 = new Uint8Array([
      0x53, 0x61, 0x61, 0x72, 0x62, 0x72, 0xfc, 0x63, 0x6b, 0x65, 0x6e,
    ]);
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(latin1, {
        status: 200,
        headers: { "content-type": "text/xml; charset=iso-8859-1" },
      })
    );
    mockParseString.mockResolvedValue({ items: [] });

    await getFeed("https://example.com/feed");
    expect(mockParseString).toHaveBeenCalledWith("Saarbrücken");
  });

  test("returns null on general error", async () => {
    globalThis.fetch = jest
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("Network failure"));

    const result = await getFeed("https://example.com/feed");
    expect(result).toBeNull();
  });

  test("returns null on timeout", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue(timeoutError);

    const result = await getFeed("https://example.com/feed");
    expect(result).toBeNull();
  });

  test.each(["503", "502", "504"])(
    "returns null on %s status (temporary unavailability)",
    async (status) => {
      globalThis.fetch = jest
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: Number(status) }));

      const result = await getFeed("https://example.com/feed");
      expect(result).toBeNull();
      expect(mockParseString).not.toHaveBeenCalled();
    }
  );

  test("returns null on parse error", async () => {
    globalThis.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(xmlResponse("not xml"));
    mockParseString.mockRejectedValue(new Error("Feed not recognized as RSS 1 or 2."));

    const result = await getFeed("https://example.com/feed");
    expect(result).toBeNull();
  });

  test("returns feed with empty items array", async () => {
    globalThis.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(xmlResponse("<rss/>"));
    mockParseString.mockResolvedValue({ items: [] });

    const result = await getFeed("https://example.com/empty-feed");
    expect(result).toEqual({ items: [] });
    expect(result!.items).toHaveLength(0);
  });

  test("handles error without message property", async () => {
    globalThis.fetch = jest.fn<typeof fetch>().mockRejectedValue("string error");

    const result = await getFeed("https://example.com/feed");
    expect(result).toBeNull();
  });
});
