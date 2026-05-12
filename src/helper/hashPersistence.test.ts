import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// Recorded calls so tests can assert exact arguments.
type Call = {
  table: string;
  op: "select" | "update" | "upsert" | "delete";
  args: any[];
  filter?: { method: string; col: string; values: any };
  upsertOptions?: any;
};

let calls: Call[];
let selectResult: { data: any; error: any };
let upsertResult: { error: any };
let deleteResult: { error: any };
let updateResult: { error: any };

function makeFrom(table: string) {
  return {
    select: (...args: any[]) => {
      const call: Call = { table, op: "select", args };
      calls.push(call);
      return {
        in: (col: string, values: any) => {
          call.filter = { method: "in", col, values };
          return Promise.resolve(selectResult);
        },
      };
    },
    upsert: (...args: any[]) => {
      const [rows, options] = args;
      calls.push({ table, op: "upsert", args: [rows], upsertOptions: options });
      return Promise.resolve(upsertResult);
    },
    delete: () => {
      const call: Call = { table, op: "delete", args: [] };
      calls.push(call);
      return {
        in: (col: string, values: any) => {
          call.filter = { method: "in", col, values };
          return Promise.resolve(deleteResult);
        },
      };
    },
    update: (...args: any[]) => {
      const [payload] = args;
      const call: Call = { table, op: "update", args: [payload] };
      calls.push(call);
      return {
        in: (col: string, values: any) => {
          call.filter = { method: "in", col, values };
          return Promise.resolve(updateResult);
        },
      };
    },
  };
}

const mockFrom = jest.fn((table: string) => makeFrom(table));

jest.unstable_mockModule("./db.js", () => ({
  default: () => ({ from: mockFrom }),
}));

const { saveHashesAndFinalize } = await import("./hashPersistence.js");

// fake db — structure matches what saveHashesAndFinalize uses.
const db: any = { from: mockFrom };

describe("saveHashesAndFinalize", () => {
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    calls = [];
    selectResult = { data: [], error: null };
    upsertResult = { error: null };
    deleteResult = { error: null };
    updateResult = { error: null };
    mockFrom.mockClear();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  test("returns early without any DB calls when articleIds is empty", async () => {
    await saveHashesAndFinalize(db, [], "empty-test");
    expect(calls).toEqual([]);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test("happy path: selects hashes, upserts them, deletes articles, no update", async () => {
    selectResult = {
      data: [
        { hash: "h1", canonical_url: "https://sr.de/a" },
        { hash: "h2", canonical_url: null },
      ],
      error: null,
    };

    await saveHashesAndFinalize(db, ["id1", "id2"], "main-toot");

    const selectCall = calls.find((c) => c.op === "select");
    expect(selectCall).toBeDefined();
    expect(selectCall!.table).toBe("news");
    expect(selectCall!.args).toEqual(["hash, canonical_url"]);
    expect(selectCall!.filter).toEqual({
      method: "in",
      col: "id",
      values: ["id1", "id2"],
    });

    const upsertCall = calls.find((c) => c.op === "upsert");
    expect(upsertCall).toBeDefined();
    expect(upsertCall!.table).toBe("tooted_hashes");
    expect(upsertCall!.args[0]).toEqual([
      { hash: "h1", canonical_url: "https://sr.de/a" },
      { hash: "h2", canonical_url: null },
    ]);
    expect(upsertCall!.upsertOptions).toEqual({ onConflict: "hash" });

    const deleteCall = calls.find((c) => c.op === "delete");
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.table).toBe("news");
    expect(deleteCall!.filter).toEqual({
      method: "in",
      col: "id",
      values: ["id1", "id2"],
    });

    const updateCall = calls.find((c) => c.op === "update");
    expect(updateCall).toBeUndefined();

    // Order matters: the bug this helper prevents is deleting before the
    // hash lands in tooted_hashes. Assert select → upsert → delete order.
    const opOrder = calls.map((c) => c.op);
    const selectIdx = opOrder.indexOf("select");
    const upsertIdx = opOrder.indexOf("upsert");
    const deleteIdx = opOrder.indexOf("delete");
    expect(selectIdx).toBeGreaterThanOrEqual(0);
    expect(upsertIdx).toBeGreaterThan(selectIdx);
    expect(deleteIdx).toBeGreaterThan(upsertIdx);
  });

  test("SELECT error: marks tooted=true, no upsert, no delete", async () => {
    selectResult = { data: null, error: { message: "select boom" } };

    await saveHashesAndFinalize(db, ["id1", "id2"], "ctx-select-err");

    const updateCall = calls.find((c) => c.op === "update");
    expect(updateCall).toBeDefined();
    expect(updateCall!.table).toBe("news");
    expect(updateCall!.args[0]).toEqual({ tooted: true });
    expect(updateCall!.filter).toEqual({
      method: "in",
      col: "id",
      values: ["id1", "id2"],
    });

    expect(calls.find((c) => c.op === "upsert")).toBeUndefined();
    expect(calls.find((c) => c.op === "delete")).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ctx-select-err]")
    );
    expect(errorSpy.mock.calls[0][0]).toEqual(
      expect.stringContaining("select boom")
    );
  });

  test("filters null/empty hashes, upserts only non-null ones", async () => {
    selectResult = {
      data: [
        { hash: "keep1", canonical_url: null },
        { hash: null, canonical_url: null },
        { hash: "", canonical_url: null },
        { hash: "keep2", canonical_url: "https://sr.de/k2" },
      ],
      error: null,
    };

    await saveHashesAndFinalize(db, ["id1", "id2", "id3", "id4"], "filter-nulls");

    const upsertCall = calls.find((c) => c.op === "upsert");
    expect(upsertCall).toBeDefined();
    expect(upsertCall!.args[0]).toEqual([
      { hash: "keep1", canonical_url: null },
      { hash: "keep2", canonical_url: "https://sr.de/k2" },
    ]);
    expect(upsertCall!.upsertOptions).toEqual({ onConflict: "hash" });

    // Delete is still called with all articleIds.
    const deleteCall = calls.find((c) => c.op === "delete");
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.filter!.values).toEqual(["id1", "id2", "id3", "id4"]);

    expect(calls.find((c) => c.op === "update")).toBeUndefined();
  });

  test("all hashes null: does NOT delete, marks tooted=true and logs", async () => {
    // Safer behavior: without any usable dedup hash, deleting the news
    // row would let the RSS item be re-ingested and re-tooted. We prefer
    // to mark it tooted=true and surface the anomaly via the log.
    selectResult = {
      data: [
        { hash: null, canonical_url: null },
        { hash: "", canonical_url: null },
      ],
      error: null,
    };

    await saveHashesAndFinalize(db, ["id1", "id2"], "all-nulls");

    expect(calls.find((c) => c.op === "upsert")).toBeUndefined();
    expect(calls.find((c) => c.op === "delete")).toBeUndefined();

    const updateCall = calls.find((c) => c.op === "update");
    expect(updateCall).toBeDefined();
    expect(updateCall!.table).toBe("news");
    expect(updateCall!.args[0]).toEqual({ tooted: true });
    expect(updateCall!.filter).toEqual({
      method: "in",
      col: "id",
      values: ["id1", "id2"],
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[all-nulls]")
    );
    expect(errorSpy.mock.calls[0][0]).toEqual(
      expect.stringContaining("null/empty hash")
    );
  });

  test("select returns empty array: no upsert, no update, delete no-ops", async () => {
    // Distinct from the all-null-hash case: if SELECT returns zero rows
    // (articleIds vanished between insert and this call) there is no hash
    // anomaly to flag — the delete will simply be a no-op.
    selectResult = { data: [], error: null };

    await saveHashesAndFinalize(db, ["gone1", "gone2"], "empty-select");

    expect(calls.find((c) => c.op === "upsert")).toBeUndefined();
    expect(calls.find((c) => c.op === "update")).toBeUndefined();
    // Delete is still issued (safe no-op against vanished ids).
    const deleteCall = calls.find((c) => c.op === "delete");
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.filter!.values).toEqual(["gone1", "gone2"]);
  });

  test("update fallback error is logged with context", async () => {
    // If the fallback update itself fails we cannot throw (the toot is
    // already out). At minimum we must log so operators can find the
    // stuck row. The context string must appear in the log.
    selectResult = {
      data: [{ hash: "h1", canonical_url: null }],
      error: null,
    };
    upsertResult = { error: { message: "upsert boom" } };
    updateResult = { error: { message: "update boom" } };

    await saveHashesAndFinalize(db, ["id1"], "ctx-update-err");

    const updateCall = calls.find((c) => c.op === "update");
    expect(updateCall).toBeDefined();

    const loggedMessages = errorSpy.mock.calls.map(
      (c) => c[0] as string
    );
    expect(
      loggedMessages.some(
        (m) => m.includes("[ctx-update-err]") && m.includes("update boom")
      )
    ).toBe(true);
  });

  test("upsert error: marks tooted=true and skips delete", async () => {
    selectResult = {
      data: [{ hash: "h1", canonical_url: null }],
      error: null,
    };
    upsertResult = { error: { message: "upsert boom" } };

    await saveHashesAndFinalize(db, ["id1"], "ctx-upsert-err");

    const upsertCall = calls.find((c) => c.op === "upsert");
    expect(upsertCall).toBeDefined();
    expect(upsertCall!.args[0]).toEqual([{ hash: "h1", canonical_url: null }]);

    const updateCall = calls.find((c) => c.op === "update");
    expect(updateCall).toBeDefined();
    expect(updateCall!.table).toBe("news");
    expect(updateCall!.args[0]).toEqual({ tooted: true });
    expect(updateCall!.filter).toEqual({
      method: "in",
      col: "id",
      values: ["id1"],
    });

    expect(calls.find((c) => c.op === "delete")).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ctx-upsert-err]")
    );
    expect(errorSpy.mock.calls[0][0]).toEqual(
      expect.stringContaining("upsert boom")
    );
  });

  test("delete error: marks tooted=true AFTER the failed delete", async () => {
    selectResult = {
      data: [{ hash: "h1", canonical_url: null }],
      error: null,
    };
    deleteResult = { error: { message: "delete boom" } };

    await saveHashesAndFinalize(db, ["id1"], "ctx-delete-err");

    // Upsert and delete both attempted before the fallback update.
    const opOrder = calls.map((c) => c.op);
    const upsertIdx = opOrder.indexOf("upsert");
    const deleteIdx = opOrder.indexOf("delete");
    const updateIdx = opOrder.indexOf("update");

    expect(upsertIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(upsertIdx);
    expect(updateIdx).toBeGreaterThan(deleteIdx);

    const updateCall = calls[updateIdx];
    expect(updateCall.table).toBe("news");
    expect(updateCall.args[0]).toEqual({ tooted: true });
    expect(updateCall.filter).toEqual({
      method: "in",
      col: "id",
      values: ["id1"],
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ctx-delete-err]")
    );
    expect(errorSpy.mock.calls[0][0]).toEqual(
      expect.stringContaining("delete boom")
    );
  });

  test("single id happy path (suppressed-article site)", async () => {
    selectResult = {
      data: [{ hash: "onlyhash", canonical_url: "https://sr.de/x" }],
      error: null,
    };

    await saveHashesAndFinalize(db, ["only-id"], "suppress-threaded");

    const selectCall = calls.find((c) => c.op === "select");
    expect(selectCall!.filter!.values).toEqual(["only-id"]);

    const upsertCall = calls.find((c) => c.op === "upsert");
    expect(upsertCall!.args[0]).toEqual([
      { hash: "onlyhash", canonical_url: "https://sr.de/x" },
    ]);
    expect(upsertCall!.upsertOptions).toEqual({ onConflict: "hash" });

    const deleteCall = calls.find((c) => c.op === "delete");
    expect(deleteCall!.filter!.values).toEqual(["only-id"]);

    expect(calls.find((c) => c.op === "update")).toBeUndefined();
  });
});

const { claimArticles, releaseCanonicalUrls } = await import(
  "./hashPersistence.js"
);

describe("claimArticles", () => {
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    calls = [];
    selectResult = { data: [], error: null };
    upsertResult = { error: null };
    deleteResult = { error: null };
    updateResult = { error: null };
    mockFrom.mockClear();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  test("returns empty proceed/conflict on empty input", async () => {
    const result = await claimArticles(db, [], "empty");
    expect(result).toEqual({
      proceedArticleIds: [],
      conflictArticleIds: [],
      claimedCanonicalUrls: [],
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test("read error treats all as conflict (fail safe — never duplicate-post)", async () => {
    selectResult = { data: null, error: { message: "select boom" } };
    const result = await claimArticles(db, ["a", "b"], "ctx-read-err");
    expect(result.proceedArticleIds).toEqual([]);
    expect(result.conflictArticleIds).toEqual(["a", "b"]);
    expect(result.claimedCanonicalUrls).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ctx-read-err")
    );
  });

  test("articles with no canonical_url proceed without DB claim (hash-only path)", async () => {
    // Simulate: news rows were read; some/all have null canonical_url.
    // We set a multi-step plan: first select returns the news rows (with
    // null canonical_url for both), so the function should never reach the
    // tooted_hashes select/upsert.
    selectResult = {
      data: [
        { id: "a", hash: "h1", canonical_url: null },
        { id: "b", hash: "h2", canonical_url: null },
      ],
      error: null,
    };

    const result = await claimArticles(db, ["a", "b"], "no-urls");

    expect(result.proceedArticleIds).toEqual(["a", "b"]);
    expect(result.conflictArticleIds).toEqual([]);
    expect(result.claimedCanonicalUrls).toEqual([]);

    // Only the news SELECT should have happened — no precheck against
    // tooted_hashes, no upsert.
    const tootedHashOps = calls.filter((c) => c.table === "tooted_hashes");
    expect(tootedHashOps).toEqual([]);
  });
});

describe("releaseCanonicalUrls", () => {
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    calls = [];
    selectResult = { data: [], error: null };
    upsertResult = { error: null };
    deleteResult = { error: null };
    updateResult = { error: null };
    mockFrom.mockClear();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  test("no-ops on empty input", async () => {
    await releaseCanonicalUrls(db, [], "empty");
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test("deletes from tooted_hashes by canonical_url", async () => {
    await releaseCanonicalUrls(
      db,
      ["https://sr.de/a", "https://sr.de/b"],
      "rollback"
    );

    const deleteCall = calls.find(
      (c) => c.op === "delete" && c.table === "tooted_hashes"
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.filter).toEqual({
      method: "in",
      col: "canonical_url",
      values: ["https://sr.de/a", "https://sr.de/b"],
    });
  });

  test("logs context on delete error (must not throw)", async () => {
    deleteResult = { error: { message: "delete boom" } };
    await releaseCanonicalUrls(db, ["https://sr.de/a"], "ctx-del-err");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ctx-del-err")
    );
    expect(errorSpy.mock.calls[0][0]).toEqual(
      expect.stringContaining("delete boom")
    );
  });
});

// ─── claimArticles: extended tests covering lines 98-172 ─────────────────────
//
// claimArticles makes TWO selects (news table then tooted_hashes), plus an
// optional upsert.  We need per-table select results, so we introduce a new
// helper `makeMultiResultFrom` that returns different data depending on which
// table is queried.

describe("claimArticles — canonical_url paths (lines 98-172)", () => {
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  // Per-table select results so we can differentiate the two SELECT calls.
  let newsSelectResult: { data: any; error: any };
  let tootedHashesSelectResult: { data: any; error: any };

  function makeMultiResultFrom(table: string) {
    return {
      select: (...args: any[]) => {
        const call: Call = { table, op: "select", args };
        calls.push(call);
        return {
          in: (col: string, values: any) => {
            call.filter = { method: "in", col, values };
            const result =
              table === "tooted_hashes"
                ? tootedHashesSelectResult
                : newsSelectResult;
            return Promise.resolve(result);
          },
        };
      },
      upsert: (...args: any[]) => {
        const [rows, options] = args;
        calls.push({ table, op: "upsert", args: [rows], upsertOptions: options });
        return Promise.resolve(upsertResult);
      },
      delete: () => {
        const call: Call = { table, op: "delete", args: [] };
        calls.push(call);
        return {
          in: (col: string, values: any) => {
            call.filter = { method: "in", col, values };
            return Promise.resolve(deleteResult);
          },
        };
      },
      update: (...args: any[]) => {
        const [payload] = args;
        const call: Call = { table, op: "update", args: [payload] };
        calls.push(call);
        return {
          in: (col: string, values: any) => {
            call.filter = { method: "in", col, values };
            return Promise.resolve(updateResult);
          },
        };
      },
    };
  }

  const multiMockFrom = jest.fn((table: string) => makeMultiResultFrom(table));
  const multiDb: any = { from: multiMockFrom };

  beforeEach(() => {
    calls = [];
    newsSelectResult = { data: [], error: null };
    tootedHashesSelectResult = { data: [], error: null };
    upsertResult = { error: null };
    deleteResult = { error: null };
    updateResult = { error: null };
    multiMockFrom.mockClear();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  test("articles with canonical_url, none existing in tooted_hashes — proceeds and claims all", async () => {
    newsSelectResult = {
      data: [
        { id: "a1", hash: "h1", canonical_url: "https://sr.de/a" },
        { id: "a2", hash: "h2", canonical_url: "https://sr.de/b" },
      ],
      error: null,
    };
    // tooted_hashes precheck returns empty — no conflicts
    tootedHashesSelectResult = { data: [], error: null };

    const result = await claimArticles(multiDb, ["a1", "a2"], "all-new");

    expect(result.proceedArticleIds).toEqual(["a1", "a2"]);
    expect(result.conflictArticleIds).toEqual([]);
    expect(result.claimedCanonicalUrls).toEqual(["https://sr.de/a", "https://sr.de/b"]);

    // Should have upserted into tooted_hashes
    const upsertCall = calls.find(
      (c) => c.op === "upsert" && c.table === "tooted_hashes"
    );
    expect(upsertCall).toBeDefined();
    expect(upsertCall!.args[0]).toEqual([
      { hash: "h1", canonical_url: "https://sr.de/a" },
      { hash: "h2", canonical_url: "https://sr.de/b" },
    ]);
    expect(upsertCall!.upsertOptions).toEqual({
      onConflict: "canonical_url",
      ignoreDuplicates: true,
    });
  });

  test("mix of articles with and without canonical_url — both sets proceed", async () => {
    newsSelectResult = {
      data: [
        { id: "a1", hash: "h1", canonical_url: "https://sr.de/a" },
        { id: "a2", hash: "h2", canonical_url: null },
      ],
      error: null,
    };
    tootedHashesSelectResult = { data: [], error: null };

    const result = await claimArticles(multiDb, ["a1", "a2"], "mixed");

    // Both should proceed: a1 via canonical_url claim, a2 via hash-only path
    expect(result.proceedArticleIds).toContain("a1");
    expect(result.proceedArticleIds).toContain("a2");
    expect(result.conflictArticleIds).toEqual([]);
    expect(result.claimedCanonicalUrls).toEqual(["https://sr.de/a"]);
  });

  test("all canonical_urls already exist in tooted_hashes — all conflict", async () => {
    newsSelectResult = {
      data: [
        { id: "a1", hash: "h1", canonical_url: "https://sr.de/a" },
        { id: "a2", hash: "h2", canonical_url: "https://sr.de/b" },
      ],
      error: null,
    };
    // Both URLs already claimed
    tootedHashesSelectResult = {
      data: [
        { canonical_url: "https://sr.de/a" },
        { canonical_url: "https://sr.de/b" },
      ],
      error: null,
    };

    const result = await claimArticles(multiDb, ["a1", "a2"], "all-conflict");

    expect(result.proceedArticleIds).toEqual([]);
    expect(result.conflictArticleIds).toEqual(["a1", "a2"]);
    expect(result.claimedCanonicalUrls).toEqual([]);

    // No upsert should have happened (nothing to insert)
    const upsertCall = calls.find(
      (c) => c.op === "upsert" && c.table === "tooted_hashes"
    );
    expect(upsertCall).toBeUndefined();
  });

  test("partial conflict: some URLs claimed, some new — correct split", async () => {
    newsSelectResult = {
      data: [
        { id: "a1", hash: "h1", canonical_url: "https://sr.de/a" },
        { id: "a2", hash: "h2", canonical_url: "https://sr.de/b" },
        { id: "a3", hash: "h3", canonical_url: null },
      ],
      error: null,
    };
    // Only first URL already claimed
    tootedHashesSelectResult = {
      data: [{ canonical_url: "https://sr.de/a" }],
      error: null,
    };

    const result = await claimArticles(
      multiDb,
      ["a1", "a2", "a3"],
      "partial-conflict"
    );

    expect(result.conflictArticleIds).toEqual(["a1"]);
    // a2 (new URL) and a3 (no URL) both proceed
    expect(result.proceedArticleIds).toContain("a2");
    expect(result.proceedArticleIds).toContain("a3");
    expect(result.claimedCanonicalUrls).toEqual(["https://sr.de/b"]);
  });

  test("tooted_hashes precheck error treats all as conflict", async () => {
    newsSelectResult = {
      data: [{ id: "a1", hash: "h1", canonical_url: "https://sr.de/a" }],
      error: null,
    };
    tootedHashesSelectResult = {
      data: null,
      error: { message: "precheck boom" },
    };

    const result = await claimArticles(multiDb, ["a1"], "precheck-err");

    expect(result.proceedArticleIds).toEqual([]);
    expect(result.conflictArticleIds).toEqual(["a1"]);
    expect(result.claimedCanonicalUrls).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("precheck-err")
    );
    expect(errorSpy.mock.calls[0][0]).toContain("precheck boom");
  });

  test("upsert insert error treats all as conflict", async () => {
    newsSelectResult = {
      data: [{ id: "a1", hash: "h1", canonical_url: "https://sr.de/a" }],
      error: null,
    };
    tootedHashesSelectResult = { data: [], error: null };
    upsertResult = { error: { message: "upsert boom" } };

    const result = await claimArticles(multiDb, ["a1"], "upsert-err");

    expect(result.proceedArticleIds).toEqual([]);
    expect(result.conflictArticleIds).toEqual(["a1"]);
    expect(result.claimedCanonicalUrls).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("upsert-err")
    );
  });

  test("article with canonical_url but null hash falls back to claim: prefix", async () => {
    newsSelectResult = {
      data: [
        { id: "a1", hash: null, canonical_url: "https://sr.de/a" },
      ],
      error: null,
    };
    tootedHashesSelectResult = { data: [], error: null };

    const result = await claimArticles(multiDb, ["a1"], "null-hash");

    expect(result.proceedArticleIds).toEqual(["a1"]);
    expect(result.claimedCanonicalUrls).toEqual(["https://sr.de/a"]);

    const upsertCall = calls.find(
      (c) => c.op === "upsert" && c.table === "tooted_hashes"
    );
    expect(upsertCall).toBeDefined();
    // hash should be the claim: fallback
    expect(upsertCall!.args[0][0].hash).toBe("claim:https://sr.de/a");
    expect(upsertCall!.args[0][0].canonical_url).toBe("https://sr.de/a");
  });

  test("all URLs conflict + articles without URL: no-URL articles still proceed (line 131)", async () => {
    // All articles with canonical_url are in conflict, but there are also
    // articles without a canonical_url.  The latter should proceed via
    // hash-only path.
    newsSelectResult = {
      data: [
        { id: "url-article", hash: "h1", canonical_url: "https://sr.de/a" },
        { id: "no-url-article", hash: "h2", canonical_url: null },
      ],
      error: null,
    };
    // The URL is already claimed — conflict
    tootedHashesSelectResult = {
      data: [{ canonical_url: "https://sr.de/a" }],
      error: null,
    };

    const result = await claimArticles(
      multiDb,
      ["url-article", "no-url-article"],
      "conflict-and-no-url"
    );

    // url-article conflicts, no-url-article proceeds
    expect(result.conflictArticleIds).toEqual(["url-article"]);
    expect(result.proceedArticleIds).toEqual(["no-url-article"]);
    expect(result.claimedCanonicalUrls).toEqual([]);
  });

  test("deduplicates canonical_urls before precheck when articles share the same URL", async () => {
    newsSelectResult = {
      data: [
        { id: "a1", hash: "h1", canonical_url: "https://sr.de/same" },
        { id: "a2", hash: "h2", canonical_url: "https://sr.de/same" },
      ],
      error: null,
    };
    tootedHashesSelectResult = { data: [], error: null };

    const result = await claimArticles(
      multiDb,
      ["a1", "a2"],
      "dedup-urls"
    );

    // Both should proceed since the URL is new
    expect(result.proceedArticleIds).toContain("a1");
    expect(result.proceedArticleIds).toContain("a2");

    // The precheck select should be for unique URLs only
    const precheckCall = calls.find(
      (c) => c.op === "select" && c.table === "tooted_hashes"
    );
    expect(precheckCall).toBeDefined();
    expect(precheckCall!.filter!.values).toEqual(["https://sr.de/same"]);
  });
});
