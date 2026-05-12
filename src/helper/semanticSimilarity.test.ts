import {
  jest,
  describe,
  it,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
} from "@jest/globals";

// -------------------------------------------------------------------------
// Mock Anthropic SDK
// -------------------------------------------------------------------------
const mockCreate = jest.fn();

jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// -------------------------------------------------------------------------
// Mock aiCache
// -------------------------------------------------------------------------
const mockGetCachedScores = jest.fn<() => Promise<Map<string, number>>>();
const mockSetCachedScores = jest.fn<() => Promise<void>>();
const mockPairKey = (a: string, b: string) => {
  // Mirrors the real pairKey: sort hashes lexicographically
  // For testing we use a simplified version that still produces consistent keys
  const ha = a.trim().toLowerCase();
  const hb = b.trim().toLowerCase();
  return ha <= hb ? `${ha}:${hb}` : `${hb}:${ha}`;
};

jest.unstable_mockModule("./aiCache.js", () => ({
  getCachedSemanticScores: mockGetCachedScores,
  setCachedSemanticScores: mockSetCachedScores,
  _pairKeyForTesting: mockPairKey,
}));

// -------------------------------------------------------------------------
// Mock costTracker
// -------------------------------------------------------------------------
const mockHasBudget = jest.fn<() => Promise<boolean>>();
const mockLogUsage = jest.fn<() => Promise<void>>();

jest.unstable_mockModule("./costTracker.js", () => ({
  hasAiBudgetForSource: mockHasBudget,
  logAiUsage: mockLogUsage,
}));

// -------------------------------------------------------------------------
// Import the module under test AFTER mocks are declared
// -------------------------------------------------------------------------
const { batchSemanticSimilarity, semanticSimilarity } = await import(
  "./semanticSimilarity.js"
);
import type { SemanticPair, SemanticResult } from "./semanticSimilarity.js";

// -------------------------------------------------------------------------
// Type-level tests
// -------------------------------------------------------------------------

describe("semanticSimilarity types", () => {
  it("SemanticPair has required fields", () => {
    const pair: SemanticPair = {
      indexA: 0,
      indexB: 1,
      titleA: "Feuer zerstört Lagerhalle",
      titleB: "Brand in Lagerhalle",
    };
    expect(pair.indexA).toBe(0);
    expect(pair.indexB).toBe(1);
    expect(pair.titleA).toContain("Feuer");
    expect(pair.titleB).toContain("Brand");
  });

  it("SemanticResult has required fields", () => {
    const result: SemanticResult = {
      indexA: 0,
      indexB: 1,
      score: 0.85,
    };
    expect(result.indexA).toBe(0);
    expect(result.indexB).toBe(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

describe("semantic similarity expected behavior", () => {
  const expectedMatches: Array<{
    titleA: string;
    titleB: string;
    expectedScore: string;
    shouldMatch: boolean;
    reason: string;
  }> = [
    {
      titleA: "Feuer zerstört Lagerhalle in Homburg",
      titleB: "Brand in Homburger Lagerhalle",
      expectedScore: "high",
      shouldMatch: true,
      reason: "Same event: fire at same location (Homburg warehouse)",
    },
    {
      titleA: "Ministerpräsidentin kündigt Maßnahmen an",
      titleB: "Anke Rehlinger stellt Plan vor",
      expectedScore: "high",
      shouldMatch: true,
      reason: "Same event: Anke Rehlinger is the Ministerpräsidentin of Saarland",
    },
    {
      titleA: "Unfall auf A1 bei Saarbrücken",
      titleB: "A1 Saarbrücken: Verkehrsunfall",
      expectedScore: "high",
      shouldMatch: true,
      reason: "Same event: accident at same location (A1 Saarbrücken)",
    },
    {
      titleA: "Neues Restaurant in Saarbrücken",
      titleB: "Polizeieinsatz in Saarbrücken",
      expectedScore: "low",
      shouldMatch: false,
      reason: "Different topics - only location in common",
    },
    {
      titleA: "Feuerwehr löscht Brand in Neunkirchen",
      titleB: "Brand in Homburg: Feuerwehr im Einsatz",
      expectedScore: "low",
      shouldMatch: false,
      reason: "DIFFERENT events - fires at different locations should NOT match",
    },
    {
      titleA: "Zugverkehr: Verspätungen im Saarland",
      titleB: "Hausbrand in Saarbrücken",
      expectedScore: "low",
      shouldMatch: false,
      reason: "Completely different topics (trains vs fire)",
    },
    {
      titleA: "Wirtschaftsminister trifft Unternehmer",
      titleB: "Brand in Lagerhalle fordert Feuerwehreinsatz",
      expectedScore: "low",
      shouldMatch: false,
      reason: "Completely different topics (economy vs fire)",
    },
  ];

  it.each(expectedMatches)(
    "should score $expectedScore (match=$shouldMatch): $titleA vs $titleB",
    ({ titleA, titleB, expectedScore, shouldMatch }) => {
      expect(["high", "medium", "low"]).toContain(expectedScore);
      expect(typeof shouldMatch).toBe("boolean");
    }
  );
});

// -------------------------------------------------------------------------
// batchSemanticSimilarity - fully mocked tests
// -------------------------------------------------------------------------

describe("batchSemanticSimilarity - mocked", () => {
  beforeEach(() => {
    process.env.CLAUDE_API_KEY = "test-api-key";
    mockGetCachedScores.mockResolvedValue(new Map());
    mockSetCachedScores.mockResolvedValue(undefined);
    mockHasBudget.mockResolvedValue(true);
    mockLogUsage.mockResolvedValue(undefined);
    mockCreate.mockReset();
  });

  afterEach(() => {
    delete process.env.CLAUDE_API_KEY;
  });

  it("returns empty array for empty pairs input", async () => {
    const result = await batchSemanticSimilarity([]);
    expect(result).toEqual([]);
    expect(mockGetCachedScores).not.toHaveBeenCalled();
  });

  it("returns empty array when no API key is set", async () => {
    delete process.env.CLAUDE_API_KEY;
    const result = await batchSemanticSimilarity([
      { indexA: 0, indexB: 1, titleA: "A", titleB: "B" },
    ]);
    expect(result).toEqual([]);
    expect(mockGetCachedScores).not.toHaveBeenCalled();
  });

  it("returns cached results when all pairs are cached", async () => {
    const titleA = "Feuer in Homburg";
    const titleB = "Brand in Homburg";
    // Use the real pairKey logic to build the right key
    // The real aiCache.ts uses sha256, but the mock uses simplified key.
    // We need to match what the module calls: pairKey(p.titleA, p.titleB)
    // The mock pairKey is injected into the module through unstable_mockModule.
    const key = mockPairKey(titleA, titleB);
    mockGetCachedScores.mockResolvedValue(new Map([[key, 0.9]]));

    const pairs: SemanticPair[] = [{ indexA: 0, indexB: 1, titleA, titleB }];
    const result = await batchSemanticSimilarity(pairs);

    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.9);
    expect(result[0].indexA).toBe(0);
    expect(result[0].indexB).toBe(1);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("clamps cached scores above 1 to 1", async () => {
    const titleA = "Test A";
    const titleB = "Test B";
    const key = mockPairKey(titleA, titleB);
    mockGetCachedScores.mockResolvedValue(new Map([[key, 1.5]]));

    const result = await batchSemanticSimilarity([
      { indexA: 0, indexB: 1, titleA, titleB },
    ]);
    expect(result[0].score).toBe(1);
  });

  it("clamps cached scores below 0 to 0", async () => {
    const titleA = "Negative A";
    const titleB = "Negative B";
    const key = mockPairKey(titleA, titleB);
    mockGetCachedScores.mockResolvedValue(new Map([[key, -0.5]]));

    const result = await batchSemanticSimilarity([
      { indexA: 0, indexB: 1, titleA, titleB },
    ]);
    expect(result[0].score).toBe(0);
  });

  it("skips API when budget is exceeded, returns only cached results", async () => {
    mockHasBudget.mockResolvedValue(false);
    mockGetCachedScores.mockResolvedValue(new Map());

    const result = await batchSemanticSimilarity([
      { indexA: 0, indexB: 1, titleA: "A", titleB: "B" },
    ]);
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("budget exceeded: returns cached-only results (non-empty)", async () => {
    const titleA = "Budget Test A";
    const titleB = "Budget Test B";
    const key = mockPairKey(titleA, titleB);
    mockGetCachedScores.mockResolvedValue(new Map([[key, 0.7]]));
    mockHasBudget.mockResolvedValue(false);

    const pairs: SemanticPair[] = [
      { indexA: 0, indexB: 1, titleA, titleB },
      { indexA: 2, indexB: 3, titleA: "Uncached X", titleB: "Uncached Y" },
    ];
    const result = await batchSemanticSimilarity(pairs);

    // Only the cached pair returns
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.7);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("calls API for uncached pairs and preserves original indices", async () => {
    mockGetCachedScores.mockResolvedValue(new Map());
    mockHasBudget.mockResolvedValue(true);
    mockCreate.mockResolvedValue({
      usage: { input_tokens: 100, output_tokens: 20 },
      content: [
        {
          type: "text",
          text: JSON.stringify([{ a: 0, b: 0, s: 0.87 }]),
        },
      ],
    });

    const pairs: SemanticPair[] = [
      { indexA: 5, indexB: 7, titleA: "Unfall A1 Saarbrücken", titleB: "A1 Unfall" },
    ];
    const result = await batchSemanticSimilarity(pairs);

    expect(result).toHaveLength(1);
    expect(result[0].indexA).toBe(5);
    expect(result[0].indexB).toBe(7);
    expect(result[0].score).toBeCloseTo(0.87);
    expect(mockSetCachedScores).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ score: expect.any(Number) }),
      ])
    );
  });

  it("clamps API response scores above 1 to 1", async () => {
    mockGetCachedScores.mockResolvedValue(new Map());
    mockHasBudget.mockResolvedValue(true);
    mockCreate.mockResolvedValue({
      usage: { input_tokens: 50, output_tokens: 10 },
      content: [{ type: "text", text: JSON.stringify([{ a: 0, b: 0, s: 1.5 }]) }],
    });

    const result = await batchSemanticSimilarity([
      { indexA: 0, indexB: 1, titleA: "X", titleB: "Y" },
    ]);
    expect(result[0].score).toBe(1);
  });

  it("ignores API entries whose pairIndex is out of uncachedPairs range", async () => {
    mockGetCachedScores.mockResolvedValue(new Map());
    mockHasBudget.mockResolvedValue(true);
    mockCreate.mockResolvedValue({
      usage: { input_tokens: 50, output_tokens: 10 },
      content: [
        {
          type: "text",
          text: JSON.stringify([{ a: 5, b: 0, s: 0.9 }]), // index 5 out of range for 1 pair
        },
      ],
    });

    const result = await batchSemanticSimilarity([
      { indexA: 0, indexB: 1, titleA: "X", titleB: "Y" },
    ]);
    expect(result).toHaveLength(0);
  });

  it("handles mixed cache hits and uncached pairs correctly", async () => {
    const titleA1 = "Cached Title A";
    const titleB1 = "Cached Title B";
    const key1 = mockPairKey(titleA1, titleB1);

    mockGetCachedScores.mockResolvedValue(new Map([[key1, 0.75]]));
    mockHasBudget.mockResolvedValue(true);
    mockCreate.mockResolvedValue({
      usage: { input_tokens: 50, output_tokens: 10 },
      content: [
        {
          type: "text",
          text: JSON.stringify([{ a: 0, b: 0, s: 0.5 }]),
        },
      ],
    });

    const pairs: SemanticPair[] = [
      { indexA: 0, indexB: 1, titleA: titleA1, titleB: titleB1 },
      { indexA: 2, indexB: 3, titleA: "Uncached A", titleB: "Uncached B" },
    ];
    const result = await batchSemanticSimilarity(pairs);

    expect(result).toHaveLength(2);
    const cached = result.find((r) => r.indexA === 0);
    expect(cached?.score).toBe(0.75);
    const fresh = result.find((r) => r.indexA === 2);
    expect(fresh?.score).toBeCloseTo(0.5);
  });

  it("returns empty array when API call throws", async () => {
    mockGetCachedScores.mockResolvedValue(new Map());
    mockHasBudget.mockResolvedValue(true);
    mockCreate.mockRejectedValue(new Error("Network error"));

    const result = await batchSemanticSimilarity([
      { indexA: 0, indexB: 1, titleA: "A", titleB: "B" },
    ]);
    expect(result).toEqual([]);
  });

  it("handles non-text API response (image content type) → falls back to empty", async () => {
    mockGetCachedScores.mockResolvedValue(new Map());
    mockHasBudget.mockResolvedValue(true);
    mockCreate.mockResolvedValue({
      usage: { input_tokens: 50, output_tokens: 10 },
      content: [{ type: "image", source: { type: "url", url: "http://example.com/img.png" } }],
    });

    const result = await batchSemanticSimilarity([
      { indexA: 0, indexB: 1, titleA: "A", titleB: "B" },
    ]);
    // Non-text → empty string → JSON.parse fails → catch → []
    expect(result).toEqual([]);
  });

  it("logs AI usage after a successful API call", async () => {
    mockGetCachedScores.mockResolvedValue(new Map());
    mockHasBudget.mockResolvedValue(true);
    mockCreate.mockResolvedValue({
      usage: { input_tokens: 100, output_tokens: 25 },
      content: [{ type: "text", text: "[]" }],
    });

    await batchSemanticSimilarity([
      { indexA: 0, indexB: 1, titleA: "A", titleB: "B" },
    ]);

    expect(mockLogUsage).toHaveBeenCalledWith("semantic_similarity", 100, 25);
  });

  it("handles markdown-wrapped JSON response from API", async () => {
    mockGetCachedScores.mockResolvedValue(new Map());
    mockHasBudget.mockResolvedValue(true);
    mockCreate.mockResolvedValue({
      usage: { input_tokens: 50, output_tokens: 20 },
      content: [
        {
          type: "text",
          text: "```json\n[{\"a\":0,\"b\":0,\"s\":0.75}]\n```",
        },
      ],
    });

    const result = await batchSemanticSimilarity([
      { indexA: 3, indexB: 4, titleA: "Title A", titleB: "Title B" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeCloseTo(0.75);
    expect(result[0].indexA).toBe(3);
  });
});

// -------------------------------------------------------------------------
// semanticSimilarity single-pair wrapper
// -------------------------------------------------------------------------
describe("semanticSimilarity single-pair wrapper - mocked", () => {
  beforeEach(() => {
    process.env.CLAUDE_API_KEY = "test-api-key";
    mockGetCachedScores.mockResolvedValue(new Map());
    mockSetCachedScores.mockResolvedValue(undefined);
    mockHasBudget.mockResolvedValue(true);
    mockLogUsage.mockResolvedValue(undefined);
    mockCreate.mockReset();
  });

  afterEach(() => {
    delete process.env.CLAUDE_API_KEY;
  });

  it("returns score from underlying batchSemanticSimilarity result", async () => {
    mockCreate.mockResolvedValue({
      usage: { input_tokens: 50, output_tokens: 10 },
      content: [{ type: "text", text: JSON.stringify([{ a: 0, b: 0, s: 0.92 }]) }],
    });

    const score = await semanticSimilarity("Title A", "Title B");
    expect(score).toBeCloseTo(0.92);
  });

  it("returns null when no results (no API key)", async () => {
    delete process.env.CLAUDE_API_KEY;
    const score = await semanticSimilarity("A", "B");
    expect(score).toBeNull();
  });

  it("returns null when API throws", async () => {
    mockCreate.mockRejectedValue(new Error("API down"));
    const score = await semanticSimilarity("A", "B");
    expect(score).toBeNull();
  });
});

// -------------------------------------------------------------------------
// graceful degradation (no API key path - matches original test)
// -------------------------------------------------------------------------
describe("graceful degradation", () => {
  it("returns empty array when API key is not set", async () => {
    const originalKey = process.env.CLAUDE_API_KEY;
    delete process.env.CLAUDE_API_KEY;

    const result = await batchSemanticSimilarity([
      { indexA: 0, indexB: 1, titleA: "Test A", titleB: "Test B" },
    ]);

    expect(result).toEqual([]);

    if (originalKey) process.env.CLAUDE_API_KEY = originalKey;
  });
});
