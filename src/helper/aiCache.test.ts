import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// Mock db.js before importing aiCache
const mockUpsert = jest.fn().mockResolvedValue({ error: null });
const mockIn = jest.fn().mockResolvedValue({ data: [], error: null });
const mockSelect = jest.fn().mockReturnValue({ in: mockIn });
const mockFrom = jest.fn().mockReturnValue({ select: mockSelect, upsert: mockUpsert });

const mockCreateClient = jest.fn().mockReturnValue({ from: mockFrom });

jest.unstable_mockModule("./db.js", () => ({
  default: mockCreateClient,
}));

const {
  getCachedRegionalCategories,
  setCachedRegionalCategories,
  getCachedSemanticScores,
  setCachedSemanticScores,
  _pairKeyForTesting,
} = await import("./aiCache.js");

describe("aiCache", () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...ORIG_ENV,
      SUPABASE_URL: "http://localhost",
      SUPABASE_KEY: "test-key",
    };
    jest.clearAllMocks();
    // Re-set up default mock chain after clearAllMocks
    mockSelect.mockReturnValue({ in: mockIn });
    mockFrom.mockReturnValue({ select: mockSelect, upsert: mockUpsert });
    mockCreateClient.mockReturnValue({ from: mockFrom });
  });

  afterEach(() => {
    process.env = ORIG_ENV;
  });

  // -------------------------------------------------------------------------
  // _pairKeyForTesting
  // -------------------------------------------------------------------------
  describe("_pairKeyForTesting (pairKey)", () => {
    test("is order-independent: pairKey(a,b) === pairKey(b,a)", () => {
      const a = "Breaking: Saarland floods";
      const b = "Economy worsens in Germany";
      expect(_pairKeyForTesting(a, b)).toBe(_pairKeyForTesting(b, a));
    });

    test("different pairs produce different keys", () => {
      const key1 = _pairKeyForTesting("article A", "article B");
      const key2 = _pairKeyForTesting("article A", "article C");
      expect(key1).not.toBe(key2);
    });

    test("key contains a colon separator", () => {
      const key = _pairKeyForTesting("foo", "bar");
      expect(key).toContain(":");
    });

    test("same title pair always gives same key", () => {
      const key1 = _pairKeyForTesting("hello world", "another title");
      const key2 = _pairKeyForTesting("hello world", "another title");
      expect(key1).toBe(key2);
    });

    test("normalizes whitespace before hashing (trimming and lowercasing)", () => {
      // Same logical title with different casing/whitespace should yield the same key
      const key1 = _pairKeyForTesting("  Hello World  ", "foo");
      const key2 = _pairKeyForTesting("hello world", "foo");
      expect(key1).toBe(key2);
    });
  });

  // -------------------------------------------------------------------------
  // getCachedRegionalCategories
  // -------------------------------------------------------------------------
  describe("getCachedRegionalCategories", () => {
    test("returns empty map for empty titles array", async () => {
      const result = await getCachedRegionalCategories([]);
      expect(result.size).toBe(0);
      expect(mockCreateClient).not.toHaveBeenCalled();
    });

    test("returns empty map when DB is not configured (no SUPABASE_URL)", async () => {
      delete process.env.SUPABASE_URL;
      const result = await getCachedRegionalCategories(["some title"]);
      expect(result.size).toBe(0);
      expect(mockCreateClient).not.toHaveBeenCalled();
    });

    test("returns empty map when DB is not configured (no SUPABASE_KEY)", async () => {
      delete process.env.SUPABASE_KEY;
      const result = await getCachedRegionalCategories(["some title"]);
      expect(result.size).toBe(0);
      expect(mockCreateClient).not.toHaveBeenCalled();
    });

    test("returns empty map when DB returns no data", async () => {
      mockIn.mockResolvedValue({ data: [], error: null });
      const result = await getCachedRegionalCategories(["Saarland news"]);
      expect(result.size).toBe(0);
    });

    test("returns populated map when DB returns rows", async () => {
      const titles = ["Saarland news", "Germany news"];
      // We need to use the same hashes that aiCache computes internally.
      // The function maps title_hash → title; the mock must return matching hashes.
      // Since we can't import titleHash directly, we compute it here via the same approach.
      const { createHash } = await import("node:crypto");
      const h = (t: string) =>
        createHash("sha256")
          .update(t.trim().toLowerCase().replace(/\s+/g, " "))
          .digest("hex");

      const hash1 = h("Saarland news");
      const hash2 = h("Germany news");

      mockIn.mockResolvedValue({
        data: [
          { title_hash: hash1, category: "regional" },
          { title_hash: hash2, category: "national" },
        ],
        error: null,
      });

      const result = await getCachedRegionalCategories(titles);
      expect(result.size).toBe(2);
      expect(result.get("Saarland news")).toBe("regional");
      expect(result.get("Germany news")).toBe("national");
    });

    test("returns empty map when DB returns an error", async () => {
      mockIn.mockResolvedValue({ data: null, error: { message: "db error" } });
      const result = await getCachedRegionalCategories(["some title"]);
      expect(result.size).toBe(0);
    });

    test("returns empty map when DB returns null data", async () => {
      mockIn.mockResolvedValue({ data: null, error: null });
      const result = await getCachedRegionalCategories(["some title"]);
      expect(result.size).toBe(0);
    });

    test("degrades silently when DB throws", async () => {
      mockFrom.mockImplementationOnce(() => {
        throw new Error("connection failed");
      });
      const result = await getCachedRegionalCategories(["some title"]);
      expect(result.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // setCachedRegionalCategories
  // -------------------------------------------------------------------------
  describe("setCachedRegionalCategories", () => {
    test("is a no-op for empty entries array", async () => {
      await setCachedRegionalCategories([]);
      expect(mockCreateClient).not.toHaveBeenCalled();
    });

    test("is a no-op when DB is not configured", async () => {
      delete process.env.SUPABASE_URL;
      await setCachedRegionalCategories([{ title: "foo", category: "local" }]);
      expect(mockCreateClient).not.toHaveBeenCalled();
    });

    test("calls upsert with correct rows on success", async () => {
      mockUpsert.mockResolvedValue({ error: null });
      const entries = [
        { title: "Local event", category: "local" as const },
        { title: "National story", category: "national" as const },
      ];
      await setCachedRegionalCategories(entries);
      expect(mockFrom).toHaveBeenCalledWith("regional_cache");
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ category: "local" }),
          expect.objectContaining({ category: "national" }),
        ]),
        { onConflict: "title_hash" }
      );
    });

    test("degrades silently when DB throws", async () => {
      mockFrom.mockImplementationOnce(() => {
        throw new Error("upsert failed");
      });
      await expect(
        setCachedRegionalCategories([{ title: "foo", category: "local" }])
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getCachedSemanticScores
  // -------------------------------------------------------------------------
  describe("getCachedSemanticScores", () => {
    test("returns empty map for empty pairs array", async () => {
      const result = await getCachedSemanticScores([]);
      expect(result.size).toBe(0);
      expect(mockCreateClient).not.toHaveBeenCalled();
    });

    test("returns empty map when DB is not configured", async () => {
      delete process.env.SUPABASE_URL;
      const result = await getCachedSemanticScores([{ titleA: "a", titleB: "b" }]);
      expect(result.size).toBe(0);
      expect(mockCreateClient).not.toHaveBeenCalled();
    });

    test("returns empty map when DB returns no data", async () => {
      mockIn.mockResolvedValue({ data: [], error: null });
      const result = await getCachedSemanticScores([{ titleA: "a", titleB: "b" }]);
      expect(result.size).toBe(0);
    });

    test("returns scores mapped by pair_hash", async () => {
      const titleA = "foo story";
      const titleB = "bar story";
      const pairHash = _pairKeyForTesting(titleA, titleB);

      mockIn.mockResolvedValue({
        data: [{ pair_hash: pairHash, score: 0.85 }],
        error: null,
      });

      const result = await getCachedSemanticScores([{ titleA, titleB }]);
      expect(result.size).toBe(1);
      expect(result.get(pairHash)).toBeCloseTo(0.85);
    });

    test("returns empty map when DB returns an error", async () => {
      mockIn.mockResolvedValue({ data: null, error: { message: "fail" } });
      const result = await getCachedSemanticScores([{ titleA: "a", titleB: "b" }]);
      expect(result.size).toBe(0);
    });

    test("degrades silently when DB throws", async () => {
      mockFrom.mockImplementationOnce(() => {
        throw new Error("network error");
      });
      const result = await getCachedSemanticScores([{ titleA: "a", titleB: "b" }]);
      expect(result.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // setCachedSemanticScores
  // -------------------------------------------------------------------------
  describe("setCachedSemanticScores", () => {
    test("is a no-op for empty entries array", async () => {
      await setCachedSemanticScores([]);
      expect(mockCreateClient).not.toHaveBeenCalled();
    });

    test("is a no-op when DB is not configured", async () => {
      delete process.env.SUPABASE_KEY;
      await setCachedSemanticScores([{ titleA: "a", titleB: "b", score: 0.5 }]);
      expect(mockCreateClient).not.toHaveBeenCalled();
    });

    test("calls upsert with correct rows on success", async () => {
      mockUpsert.mockResolvedValue({ error: null });
      const titleA = "story one";
      const titleB = "story two";
      const expectedHash = _pairKeyForTesting(titleA, titleB);

      await setCachedSemanticScores([{ titleA, titleB, score: 0.75 }]);
      expect(mockFrom).toHaveBeenCalledWith("semantic_pair_cache");
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ pair_hash: expectedHash, score: 0.75 }),
        ]),
        { onConflict: "pair_hash" }
      );
    });

    test("degrades silently when DB throws", async () => {
      mockFrom.mockImplementationOnce(() => {
        throw new Error("upsert error");
      });
      await expect(
        setCachedSemanticScores([{ titleA: "a", titleB: "b", score: 0.9 }])
      ).resolves.toBeUndefined();
    });
  });
});
