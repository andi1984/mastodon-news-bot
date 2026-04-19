import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// Why this module exists:
//
// After the bot posts a follow-up quote toot for an already-tooted story,
// the links included in that quote are NOT added to the story's
// `original_links`. On the next day, if the feed re-emits one of those
// same URLs (perhaps under a slightly different hash due to title/URL
// cosmetic variation), the follow-up dedup check sees the link as "new"
// and posts ANOTHER quote toot. This produces the daily re-tooting the
// user is observing.
//
// `extendStoryOriginalLinks` closes that loop: after a successful
// follow-up post, the caller appends the newly-posted (normalized) links
// to the story's `original_links` so tomorrow's follow-up dedup treats
// them as already-seen.

type Call = {
  seq: number;
  table: string;
  op: "select" | "update";
  args: any[];
  filters: { method: string; col: string; value: any }[];
};

let calls: Call[];
let seq: number;
let selectResult: { data: any; error: any };
let updateResult: { error: any };

const resolvable = (v: any) => Promise.resolve(v);

function makeSelectChain(call: Call, table: string) {
  const chain: any = {
    eq: (col: string, val: any) => {
      call.filters.push({ method: "eq", col, value: val });
      return chain;
    },
    maybeSingle: () =>
      resolvable(selectResult ?? { data: null, error: null }),
    single: () => resolvable(selectResult ?? { data: null, error: null }),
    then: (resolve: any, reject: any) =>
      resolvable(selectResult ?? { data: [], error: null }).then(resolve, reject),
  };
  return chain;
}

function makeUpdateChain(call: Call) {
  const chain: any = {
    eq: (col: string, val: any) => {
      call.filters.push({ method: "eq", col, value: val });
      return resolvable(updateResult);
    },
  };
  return chain;
}

function record(op: Call["op"], table: string, args: any[]): Call {
  const call: Call = { seq: seq++, table, op, args, filters: [] };
  calls.push(call);
  return call;
}

function makeFrom(table: string) {
  return {
    select: (...args: any[]) => {
      const call = record("select", table, args);
      return makeSelectChain(call, table);
    },
    update: (...args: any[]) => {
      const call = record("update", table, args);
      return makeUpdateChain(call);
    },
  };
}

const mockFrom = jest.fn((table: string) => makeFrom(table));
const fakeClient: any = { from: mockFrom };

const { extendStoryOriginalLinks } = await import("./storyLinks.js");

beforeEach(() => {
  calls = [];
  seq = 0;
  selectResult = { data: null, error: null };
  updateResult = { error: null };
  mockFrom.mockClear();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("extendStoryOriginalLinks", () => {
  test("adds normalized new links to an existing story's original_links", async () => {
    selectResult = {
      data: {
        original_links: [
          "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen",
        ],
      },
      error: null,
    };

    await extendStoryOriginalLinks(fakeClient, "story-1", [
      "https://example.com/new-source",
    ]);

    const updateCall = calls.find((c) => c.op === "update");
    expect(updateCall).toBeDefined();
    const payload = updateCall!.args[0];
    expect(payload.original_links).toEqual(
      expect.arrayContaining([
        "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen",
        "https://example.com/new-source",
      ])
    );
  });

  test("does NOT write when all new links are already present (normalized)", async () => {
    // The core regression guard: if the follow-up just re-posted
    // cosmetic variants of existing links, the update would be a no-op.
    // We skip the write entirely to save a DB round-trip - AND so the
    // test confirms we correctly detected the dedup.
    selectResult = {
      data: {
        original_links: ["https://example.com/a"],
      },
      error: null,
    };

    await extendStoryOriginalLinks(fakeClient, "story-1", [
      "https://example.com/a/?utm_source=feed", // same URL, normalized equivalent
      "HTTPS://Example.COM/a#top", // same URL, mixed case + fragment
    ]);

    expect(calls.find((c) => c.op === "update")).toBeUndefined();
  });

  test("normalizes both existing and incoming links before deduping", async () => {
    // Older stories may have un-normalized URLs in original_links from
    // before normalization shipped. We must normalize on read too, so
    // legacy data doesn't defeat the dedup.
    selectResult = {
      data: {
        original_links: ["https://example.com/a/?utm_source=old"],
      },
      error: null,
    };

    await extendStoryOriginalLinks(fakeClient, "story-1", [
      "https://example.com/a", // equivalent to the legacy entry
      "https://example.com/b", // genuinely new
    ]);

    const updateCall = calls.find((c) => c.op === "update");
    expect(updateCall).toBeDefined();
    const payload = updateCall!.args[0];
    // Must contain exactly two canonical URLs, no dupes.
    expect(payload.original_links).toHaveLength(2);
    expect(new Set(payload.original_links)).toEqual(
      new Set(["https://example.com/a", "https://example.com/b"])
    );
  });

  test("handles story with null/undefined original_links (legacy rows)", async () => {
    selectResult = {
      data: { original_links: null },
      error: null,
    };

    await extendStoryOriginalLinks(fakeClient, "story-1", [
      "https://example.com/a",
    ]);

    const updateCall = calls.find((c) => c.op === "update");
    expect(updateCall).toBeDefined();
    expect(updateCall!.args[0].original_links).toEqual([
      "https://example.com/a",
    ]);
  });

  test("no-op for empty newLinks", async () => {
    await extendStoryOriginalLinks(fakeClient, "story-1", []);
    expect(calls).toHaveLength(0);
  });

  test("filters out empty/whitespace links from the input", async () => {
    selectResult = {
      data: { original_links: [] },
      error: null,
    };

    await extendStoryOriginalLinks(fakeClient, "story-1", [
      "",
      "   ",
      "https://example.com/a",
    ]);

    const updateCall = calls.find((c) => c.op === "update");
    expect(updateCall).toBeDefined();
    expect(updateCall!.args[0].original_links).toEqual([
      "https://example.com/a",
    ]);
  });

  test("select failure: logs and skips write - does not corrupt data", async () => {
    selectResult = {
      data: null,
      error: { message: "select kaput" },
    };

    await extendStoryOriginalLinks(fakeClient, "story-1", [
      "https://example.com/a",
    ]);

    expect(calls.find((c) => c.op === "update")).toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  test("update failure: logs but does not throw (tooter must not crash)", async () => {
    selectResult = {
      data: { original_links: [] },
      error: null,
    };
    updateResult = { error: { message: "update kaput" } };

    await expect(
      extendStoryOriginalLinks(fakeClient, "story-1", [
        "https://example.com/a",
      ])
    ).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalled();
  });
});
