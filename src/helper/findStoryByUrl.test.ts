import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// Why this module exists:
//
// `findMatchingStory` (in storyMatcher.ts) only searches stories updated in
// the last 72h. When the verbraucherzentrale feed re-emits a long-lived
// article weeks later with a cosmetic title/URL variation, the grabber's
// hash-based dedup fails (hash shifts), the article is re-ingested, and
// `findMatchingStory` fails to find the older story. A NEW story is created
// and fully re-tooted. That's the daily re-toot still observed after PR #9.
//
// `findStoryByUrl` is a URL-based short-circuit that ignores the 72h window:
// if the article's normalized link is already in some story's
// `original_links`, that's the matching story — regardless of age, token
// drift, or cosmetic variation in the URL.

type Call = {
  seq: number;
  table: string;
  op: "select";
  args: any[];
  filters: { method: string; col: string; value: any }[];
  limit?: number;
};

let calls: Call[];
let seq: number;
let selectResult: { data: any; error: any };

const resolvable = (v: any) => Promise.resolve(v);

function makeSelectChain(call: Call) {
  const chain: any = {
    not: (col: string, op: string, val: any) => {
      call.filters.push({ method: `not.${op}`, col, value: val });
      return chain;
    },
    order: (col: string, opts: any) => {
      call.filters.push({ method: "order", col, value: opts });
      return chain;
    },
    limit: (n: number) => {
      call.limit = n;
      return chain;
    },
    then: (resolve: any, reject: any) =>
      resolvable(selectResult ?? { data: [], error: null }).then(resolve, reject),
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
      return makeSelectChain(call);
    },
  };
}

const mockFrom = jest.fn((table: string) => makeFrom(table));
const fakeClient: any = { from: mockFrom };

const { findStoryByUrl } = await import("./findStoryByUrl.js");

beforeEach(() => {
  calls = [];
  seq = 0;
  selectResult = { data: [], error: null };
  mockFrom.mockClear();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("findStoryByUrl", () => {
  test("returns null for empty/nullish links (no query issued)", async () => {
    const a = await findStoryByUrl(fakeClient, "");
    const b = await findStoryByUrl(fakeClient, null as any);
    const c = await findStoryByUrl(fakeClient, undefined as any);

    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(c).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("returns null when no stories have original_links", async () => {
    selectResult = { data: [], error: null };

    const result = await findStoryByUrl(
      fakeClient,
      "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen"
    );

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("stories");
  });

  test("returns matching story when normalized URL is in a story's original_links", async () => {
    const story = {
      id: "story-old",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z", // >72h old from today
      tooted: true,
      toot_id: "toot-123",
      original_links: [
        "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen",
      ],
      primary_title: "Klage gegen Stadtsparkasse München",
      tokens: ["klage", "stadtsparkasse"],
      article_count: 3,
    };
    selectResult = { data: [story], error: null };

    const result = await findStoryByUrl(
      fakeClient,
      "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen"
    );

    expect(result).not.toBeNull();
    expect(result!.id).toBe("story-old");
  });

  test("matches despite cosmetic URL drift in the incoming link", async () => {
    // The whole point: the feed re-emits the same article with utm params,
    // trailing slash, or fragment. The normalized form still matches.
    const story = {
      id: "story-1",
      original_links: [
        "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen",
      ],
      primary_title: "X",
      tokens: [],
      article_count: 1,
      tooted: true,
      toot_id: "t",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    };
    selectResult = { data: [story], error: null };

    const result = await findStoryByUrl(
      fakeClient,
      "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen/?utm_source=newsletter#anchor"
    );

    expect(result).not.toBeNull();
    expect(result!.id).toBe("story-1");
  });

  test("matches legacy stories whose original_links were stored un-normalized", async () => {
    // Stories tooted before normalization shipped may contain raw URLs.
    // We must normalize both sides (store + lookup) so the dedup still
    // catches them.
    const story = {
      id: "legacy-story",
      original_links: [
        "HTTPS://www.Verbraucherzentrale-Saarland.de/verfahren/stadtsparkasse-muenchen/?utm_source=rss#top",
      ],
      primary_title: "X",
      tokens: [],
      article_count: 1,
      tooted: true,
      toot_id: "t",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    };
    selectResult = { data: [story], error: null };

    const result = await findStoryByUrl(
      fakeClient,
      "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen"
    );

    expect(result).not.toBeNull();
    expect(result!.id).toBe("legacy-story");
  });

  test("returns null when no story contains the URL", async () => {
    selectResult = {
      data: [
        {
          id: "other",
          original_links: ["https://example.com/unrelated"],
          primary_title: "X",
          tokens: [],
          article_count: 1,
          tooted: true,
          toot_id: "t",
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        },
      ],
      error: null,
    };

    const result = await findStoryByUrl(
      fakeClient,
      "https://www.verbraucherzentrale-saarland.de/verfahren/stadtsparkasse-muenchen"
    );

    expect(result).toBeNull();
  });

  test("returns first match when multiple stories contain the URL (newest wins by order)", async () => {
    // We order by updated_at DESC, so the most recently updated story wins.
    // This matters if a content migration or bug ever produced dupes -
    // we pick the most recent as the canonical one.
    selectResult = {
      data: [
        {
          id: "newer",
          original_links: ["https://example.com/a"],
          primary_title: "X",
          tokens: [],
          article_count: 1,
          tooted: true,
          toot_id: "t",
          created_at: "2026-01-01",
          updated_at: "2026-03-01",
        },
        {
          id: "older",
          original_links: ["https://example.com/a"],
          primary_title: "X",
          tokens: [],
          article_count: 1,
          tooted: true,
          toot_id: "t",
          created_at: "2026-01-01",
          updated_at: "2026-01-05",
        },
      ],
      error: null,
    };

    const result = await findStoryByUrl(fakeClient, "https://example.com/a/");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("newer");
  });

  test("select failure: returns null and logs", async () => {
    selectResult = { data: null, error: { message: "db dead" } };

    const result = await findStoryByUrl(
      fakeClient,
      "https://example.com/a"
    );

    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  test("skips stories with null/empty original_links without crashing", async () => {
    selectResult = {
      data: [
        {
          id: "empty",
          original_links: null,
          primary_title: "X",
          tokens: [],
          article_count: 1,
          tooted: true,
          toot_id: "t",
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        },
        {
          id: "match",
          original_links: ["https://example.com/a"],
          primary_title: "X",
          tokens: [],
          article_count: 1,
          tooted: true,
          toot_id: "t",
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        },
      ],
      error: null,
    };

    const result = await findStoryByUrl(fakeClient, "https://example.com/a");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("match");
  });
});
