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
      data: [{ hash: "h1" }, { hash: "h2" }],
      error: null,
    };

    await saveHashesAndFinalize(db, ["id1", "id2"], "main-toot");

    const selectCall = calls.find((c) => c.op === "select");
    expect(selectCall).toBeDefined();
    expect(selectCall!.table).toBe("news");
    expect(selectCall!.args).toEqual(["hash"]);
    expect(selectCall!.filter).toEqual({
      method: "in",
      col: "id",
      values: ["id1", "id2"],
    });

    const upsertCall = calls.find((c) => c.op === "upsert");
    expect(upsertCall).toBeDefined();
    expect(upsertCall!.table).toBe("tooted_hashes");
    expect(upsertCall!.args[0]).toEqual([{ hash: "h1" }, { hash: "h2" }]);
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
        { hash: "keep1" },
        { hash: null },
        { hash: "" },
        { hash: "keep2" },
      ],
      error: null,
    };

    await saveHashesAndFinalize(db, ["id1", "id2", "id3", "id4"], "filter-nulls");

    const upsertCall = calls.find((c) => c.op === "upsert");
    expect(upsertCall).toBeDefined();
    expect(upsertCall!.args[0]).toEqual([{ hash: "keep1" }, { hash: "keep2" }]);
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
      data: [{ hash: null }, { hash: "" }],
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
    selectResult = { data: [{ hash: "h1" }], error: null };
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
      data: [{ hash: "h1" }],
      error: null,
    };
    upsertResult = { error: { message: "upsert boom" } };

    await saveHashesAndFinalize(db, ["id1"], "ctx-upsert-err");

    const upsertCall = calls.find((c) => c.op === "upsert");
    expect(upsertCall).toBeDefined();
    expect(upsertCall!.args[0]).toEqual([{ hash: "h1" }]);

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
      data: [{ hash: "h1" }],
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
      data: [{ hash: "onlyhash" }],
      error: null,
    };

    await saveHashesAndFinalize(db, ["only-id"], "suppress-threaded");

    const selectCall = calls.find((c) => c.op === "select");
    expect(selectCall!.filter!.values).toEqual(["only-id"]);

    const upsertCall = calls.find((c) => c.op === "upsert");
    expect(upsertCall!.args[0]).toEqual([{ hash: "onlyhash" }]);
    expect(upsertCall!.upsertOptions).toEqual({ onConflict: "hash" });

    const deleteCall = calls.find((c) => c.op === "delete");
    expect(deleteCall!.filter!.values).toEqual(["only-id"]);

    expect(calls.find((c) => c.op === "update")).toBeUndefined();
  });
});
