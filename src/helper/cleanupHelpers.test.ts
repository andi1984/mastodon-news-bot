import { jest, describe, test, expect, beforeEach } from "@jest/globals";

type Call = {
  seq: number;
  table: string;
  op: "select" | "upsert" | "delete" | "update";
  args: any[];
  filters?: { method: string; col: string; value: any }[];
  upsertOptions?: any;
};

let calls: Call[];
let seq: number;

// Per-operation results, keyed by `${table}:${op}`. Tests set these in beforeEach or mid-test.
let selectResults: Record<string, { data: any; error: any }>;
let upsertResult: { error: any };
let deleteResult: { error: any };
let updateResult: { error: any };

const resolvable = (v: any) => Promise.resolve(v);

function record(op: Call["op"], table: string, args: any[]): Call {
  const call: Call = { seq: seq++, table, op, args, filters: [] };
  calls.push(call);
  return call;
}

function makeSelectChain(table: string, call: Call) {
  // Supabase query builders are thenable: calling eq/or/in returns a new
  // builder that can either chain further or resolve. We model that by
  // returning an object that has the methods AND a then() which resolves
  // to the result keyed by `${table}:select`.
  const key = `${table}:select`;
  const chain: any = {
    eq: (col: string, val: any) => {
      call.filters!.push({ method: "eq", col, value: val });
      return chain;
    },
    or: (clause: string) => {
      call.filters!.push({ method: "or", col: "", value: clause });
      return chain;
    },
    in: (col: string, val: any) => {
      call.filters!.push({ method: "in", col, value: val });
      return chain;
    },
    then: (resolve: any, reject: any) =>
      resolvable(selectResults[key] ?? { data: [], error: null }).then(resolve, reject),
  };
  return chain;
}

function makeDeleteChain(call: Call) {
  const chain: any = {
    in: (col: string, val: any) => {
      call.filters!.push({ method: "in", col, value: val });
      return resolvable(deleteResult);
    },
  };
  return chain;
}

function makeUpdateChain(call: Call) {
  const chain: any = {
    in: (col: string, val: any) => {
      call.filters!.push({ method: "in", col, value: val });
      return resolvable(updateResult);
    },
  };
  return chain;
}

function makeFrom(table: string) {
  return {
    select: (...args: any[]) => {
      const call = record("select", table, args);
      return makeSelectChain(table, call);
    },
    upsert: (...args: any[]) => {
      const [rows, options] = args;
      const call = record("upsert", table, [rows]);
      call.upsertOptions = options;
      return resolvable(upsertResult);
    },
    delete: () => {
      const call = record("delete", table, []);
      return makeDeleteChain(call);
    },
    update: (...args: any[]) => {
      const [payload] = args;
      const call = record("update", table, [payload]);
      return makeUpdateChain(call);
    },
  };
}

const mockFrom = jest.fn((table: string) => makeFrom(table));
const fakeClient: any = { from: mockFrom };

const { cleanupTootedArticles, cleanupStaleArticles } = await import(
  "./cleanupHelpers.js"
);

beforeEach(() => {
  calls = [];
  seq = 0;
  selectResults = {};
  upsertResult = { error: null };
  deleteResult = { error: null };
  updateResult = { error: null };
  mockFrom.mockClear();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("cleanupTootedArticles", () => {
  test("rows with hashes: selects first, upserts before delete, returns count", async () => {
    selectResults["news:select"] = {
      data: [
        { id: "a1", hash: "h1" },
        { id: "a2", hash: "h2" },
      ],
      error: null,
    };

    const count = await cleanupTootedArticles(fakeClient);
    expect(count).toBe(2);

    const selectCall = calls.find((c) => c.table === "news" && c.op === "select");
    const upsertCall = calls.find(
      (c) => c.table === "tooted_hashes" && c.op === "upsert"
    );
    const deleteCall = calls.find((c) => c.table === "news" && c.op === "delete");

    expect(selectCall).toBeDefined();
    expect(selectCall!.args).toEqual(["id, hash"]);
    expect(selectCall!.filters).toEqual([
      { method: "eq", col: "tooted", value: true },
    ]);

    expect(upsertCall).toBeDefined();
    expect(upsertCall!.args[0]).toEqual([{ hash: "h1" }, { hash: "h2" }]);
    expect(upsertCall!.upsertOptions).toEqual({ onConflict: "hash" });

    expect(deleteCall).toBeDefined();
    expect(deleteCall!.filters).toEqual([
      { method: "in", col: "id", value: ["a1", "a2"] },
    ]);

    // Safety invariant: upsert must come before delete.
    expect(upsertCall!.seq).toBeLessThan(deleteCall!.seq);
  });

  test("upsert fails: delete is NOT called, returns 0", async () => {
    selectResults["news:select"] = {
      data: [
        { id: "a1", hash: "h1" },
        { id: "a2", hash: "h2" },
      ],
      error: null,
    };
    upsertResult = { error: { message: "upsert kaput" } };

    const count = await cleanupTootedArticles(fakeClient);
    expect(count).toBe(0);

    expect(calls.find((c) => c.op === "upsert")).toBeDefined();
    expect(calls.find((c) => c.op === "delete")).toBeUndefined();
  });

  test("all rows have null hash: nothing upserted or deleted, logged", async () => {
    selectResults["news:select"] = {
      data: [
        { id: "a1", hash: null },
        { id: "a2", hash: "" },
      ],
      error: null,
    };

    const count = await cleanupTootedArticles(fakeClient);
    expect(count).toBe(0);

    expect(calls.find((c) => c.op === "upsert")).toBeUndefined();
    expect(calls.find((c) => c.op === "delete")).toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("null/empty hash left in place")
    );
  });

  test("mixed null and non-null hashes: only non-null upserted, only those deleted", async () => {
    selectResults["news:select"] = {
      data: [
        { id: "a1", hash: "keep1" },
        { id: "a2", hash: null },
        { id: "a3", hash: "keep2" },
      ],
      error: null,
    };

    const count = await cleanupTootedArticles(fakeClient);
    expect(count).toBe(2);

    const upsertCall = calls.find((c) => c.table === "tooted_hashes");
    expect(upsertCall!.args[0]).toEqual([{ hash: "keep1" }, { hash: "keep2" }]);

    const deleteCall = calls.find((c) => c.table === "news" && c.op === "delete");
    expect(deleteCall!.filters![0].value).toEqual(["a1", "a3"]);
  });

  test("select fails: returns 0, no writes", async () => {
    selectResults["news:select"] = {
      data: null,
      error: { message: "select kaput" },
    };

    const count = await cleanupTootedArticles(fakeClient);
    expect(count).toBe(0);

    expect(calls.find((c) => c.op === "upsert")).toBeUndefined();
    expect(calls.find((c) => c.op === "delete")).toBeUndefined();
  });

  test("zero matching rows: no writes, returns 0", async () => {
    selectResults["news:select"] = { data: [], error: null };

    const count = await cleanupTootedArticles(fakeClient);
    expect(count).toBe(0);

    expect(calls.find((c) => c.op === "upsert")).toBeUndefined();
    expect(calls.find((c) => c.op === "delete")).toBeUndefined();
  });
});

describe("cleanupStaleArticles", () => {
  test("selects stale untooted rows, upserts before delete, returns count", async () => {
    selectResults["news:select"] = {
      data: [
        { id: "s1", hash: "sh1" },
        { id: "s2", hash: "sh2" },
      ],
      error: null,
    };

    const count = await cleanupStaleArticles(fakeClient, 24);
    expect(count).toBe(2);

    const selectCall = calls.find(
      (c) => c.table === "news" && c.op === "select"
    );
    expect(selectCall!.args).toEqual(["id, hash"]);
    const eq = selectCall!.filters!.find((f) => f.method === "eq");
    expect(eq).toEqual({ method: "eq", col: "tooted", value: false });
    const orFilter = selectCall!.filters!.find((f) => f.method === "or");
    expect(orFilter!.value).toMatch(/pub_date\.lt\..*,created_at\.lt\./);

    const upsertCall = calls.find(
      (c) => c.table === "tooted_hashes" && c.op === "upsert"
    );
    expect(upsertCall!.args[0]).toEqual([{ hash: "sh1" }, { hash: "sh2" }]);

    const deleteCall = calls.find(
      (c) => c.table === "news" && c.op === "delete"
    );
    expect(deleteCall!.filters![0].value).toEqual(["s1", "s2"]);

    expect(upsertCall!.seq).toBeLessThan(deleteCall!.seq);
  });

  test("upsert fails: delete is NOT called, returns 0", async () => {
    selectResults["news:select"] = {
      data: [{ id: "s1", hash: "sh1" }],
      error: null,
    };
    upsertResult = { error: { message: "upsert kaput" } };

    const count = await cleanupStaleArticles(fakeClient, 24);
    expect(count).toBe(0);

    expect(calls.find((c) => c.op === "upsert")).toBeDefined();
    expect(calls.find((c) => c.op === "delete")).toBeUndefined();
  });

  test("null-hash stale rows: marked tooted=true, not deleted", async () => {
    selectResults["news:select"] = {
      data: [
        { id: "s1", hash: null },
        { id: "s2", hash: "" },
      ],
      error: null,
    };

    const count = await cleanupStaleArticles(fakeClient, 24);
    expect(count).toBe(2); // counted as "touched" via the update path

    const updateCall = calls.find(
      (c) => c.table === "news" && c.op === "update"
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.args[0]).toEqual({ tooted: true });
    expect(updateCall!.filters![0].value).toEqual(["s1", "s2"]);

    expect(calls.find((c) => c.op === "upsert")).toBeUndefined();
    expect(
      calls.find((c) => c.table === "news" && c.op === "delete")
    ).toBeUndefined();
  });

  test("mixed: null-hash rows marked tooted, hashed rows upserted-then-deleted", async () => {
    selectResults["news:select"] = {
      data: [
        { id: "s1", hash: "keep" },
        { id: "s2", hash: null },
      ],
      error: null,
    };

    const count = await cleanupStaleArticles(fakeClient, 24);
    expect(count).toBe(2); // 1 marked + 1 deleted

    const updateCall = calls.find(
      (c) => c.table === "news" && c.op === "update"
    );
    expect(updateCall!.filters![0].value).toEqual(["s2"]);

    const upsertCall = calls.find((c) => c.table === "tooted_hashes");
    expect(upsertCall!.args[0]).toEqual([{ hash: "keep" }]);

    const deleteCall = calls.find(
      (c) => c.table === "news" && c.op === "delete"
    );
    expect(deleteCall!.filters![0].value).toEqual(["s1"]);
  });

  test("select fails: returns 0, no writes", async () => {
    selectResults["news:select"] = {
      data: null,
      error: { message: "select kaput" },
    };

    const count = await cleanupStaleArticles(fakeClient, 24);
    expect(count).toBe(0);

    expect(calls.find((c) => c.op === "upsert")).toBeUndefined();
    expect(calls.find((c) => c.op === "delete")).toBeUndefined();
    expect(calls.find((c) => c.op === "update")).toBeUndefined();
  });

  test("uses the configured retentionHours to compute cutoff", async () => {
    const now = new Date("2026-04-18T12:00:00Z");
    jest.useFakeTimers().setSystemTime(now);

    selectResults["news:select"] = { data: [], error: null };
    await cleanupStaleArticles(fakeClient, 48);

    const selectCall = calls.find((c) => c.op === "select");
    const orFilter = selectCall!.filters!.find((f) => f.method === "or");
    // 48 hours before the frozen now = 2026-04-16T12:00:00.000Z
    expect(orFilter!.value).toContain("2026-04-16T12:00:00.000Z");

    jest.useRealTimers();
  });
});
