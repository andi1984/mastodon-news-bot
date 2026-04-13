import { jest, describe, test, expect, beforeEach } from "@jest/globals";

type Call = {
  table: string;
  op: "delete" | "select" | "upsert" | "eq";
  args: any[];
  upsertOptions?: any;
};

let calls: Call[];
let deleteChainResult: { data: any; error: any };
let upsertResult: { error: any };

// Fluent chain: from(table).delete().eq(col, val).select("id, hash")
function makeFrom(table: string) {
  return {
    delete: () => {
      calls.push({ table, op: "delete", args: [] });
      return {
        eq: (col: string, val: any) => {
          calls.push({ table, op: "eq", args: [col, val] });
          return {
            select: (sel: string) => {
              calls.push({ table, op: "select", args: [sel] });
              return Promise.resolve(deleteChainResult);
            },
          };
        },
      };
    },
    upsert: (...args: any[]) => {
      const [rows, options] = args;
      calls.push({ table, op: "upsert", args: [rows], upsertOptions: options });
      return Promise.resolve(upsertResult);
    },
  };
}

const mockFrom = jest.fn((table: string) => makeFrom(table));

const fakeClient: any = { from: mockFrom };

const { cleanupTootedArticles } = await import("./cleanupHelpers.js");

describe("cleanupTootedArticles", () => {
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    calls = [];
    deleteChainResult = { data: [], error: null };
    upsertResult = { error: null };
    mockFrom.mockClear();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  test("rows with hashes: upserts to tooted_hashes, returns row count", async () => {
    deleteChainResult = {
      data: [
        { id: "a1", hash: "h1" },
        { id: "a2", hash: "h2" },
      ],
      error: null,
    };

    const count = await cleanupTootedArticles(fakeClient);
    expect(count).toBe(2);

    const deleteCall = calls.find((c) => c.op === "delete");
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.table).toBe("news");

    const eqCall = calls.find((c) => c.op === "eq");
    expect(eqCall).toBeDefined();
    expect(eqCall!.args).toEqual(["tooted", true]);

    const selectCall = calls.find((c) => c.op === "select");
    expect(selectCall).toBeDefined();
    expect(selectCall!.args).toEqual(["id, hash"]);

    const upsertCall = calls.find((c) => c.op === "upsert");
    expect(upsertCall).toBeDefined();
    expect(upsertCall!.table).toBe("tooted_hashes");
    expect(upsertCall!.args[0]).toEqual([{ hash: "h1" }, { hash: "h2" }]);
    expect(upsertCall!.upsertOptions).toEqual({ onConflict: "hash" });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("rows with some null hashes: only non-null hashes upserted", async () => {
    deleteChainResult = {
      data: [
        { id: "a1", hash: "keep1" },
        { id: "a2", hash: null },
        { id: "a3", hash: "" },
        { id: "a4", hash: "keep2" },
      ],
      error: null,
    };

    const count = await cleanupTootedArticles(fakeClient);
    expect(count).toBe(4);

    const upsertCall = calls.find((c) => c.op === "upsert");
    expect(upsertCall).toBeDefined();
    expect(upsertCall!.args[0]).toEqual([{ hash: "keep1" }, { hash: "keep2" }]);
    expect(upsertCall!.upsertOptions).toEqual({ onConflict: "hash" });
  });

  test("zero rows returned: upsert not called, returns 0", async () => {
    deleteChainResult = { data: [], error: null };

    const count = await cleanupTootedArticles(fakeClient);
    expect(count).toBe(0);

    expect(calls.find((c) => c.op === "upsert")).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("delete returns error: returns 0, no upsert, error logged", async () => {
    deleteChainResult = { data: null, error: { message: "delete kaput" } };

    const count = await cleanupTootedArticles(fakeClient);
    expect(count).toBe(0);

    expect(calls.find((c) => c.op === "upsert")).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("delete kaput")
    );
    expect(errorSpy.mock.calls[0][0]).toEqual(
      expect.stringContaining("Cleanup tooted articles")
    );
  });

  test("upsert returns error: still returns row count, error logged", async () => {
    deleteChainResult = {
      data: [
        { id: "a1", hash: "h1" },
        { id: "a2", hash: "h2" },
      ],
      error: null,
    };
    upsertResult = { error: { message: "upsert kaput" } };

    const count = await cleanupTootedArticles(fakeClient);
    expect(count).toBe(2);

    const upsertCall = calls.find((c) => c.op === "upsert");
    expect(upsertCall).toBeDefined();
    expect(upsertCall!.args[0]).toEqual([{ hash: "h1" }, { hash: "h2" }]);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("upsert kaput")
    );
    expect(errorSpy.mock.calls[0][0]).toEqual(
      expect.stringContaining("failed to persist hashes")
    );
  });
});
