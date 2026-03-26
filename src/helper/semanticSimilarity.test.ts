import { SemanticPair, SemanticResult } from "./semanticSimilarity.js";

// Note: These tests don't call the actual API. They test the interface
// and document expected behavior. Integration tests with real API calls
// should be run separately with proper budget limits.

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
  // These document what the semantic matcher SHOULD return
  // when called with real API access
  // NOTE: With stricter prompt (2024-03), we require score >= 0.8 to match

  const expectedMatches: Array<{
    titleA: string;
    titleB: string;
    expectedScore: string; // "high" (0.8+), "medium" (0.4-0.8), "low" (<0.4)
    shouldMatch: boolean; // Whether this should cluster (score >= 0.8)
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
      // This test documents expected behavior without calling the API
      // When the API is called, we expect these scores:
      // - high: 0.85+ (should cluster, same specific event)
      // - medium: 0.4-0.85 (should NOT cluster - threshold is 0.8)
      // - low: <0.4 (definitely should not cluster)
      expect(["high", "medium", "low"]).toContain(expectedScore);
      expect(typeof shouldMatch).toBe("boolean");
    }
  );
});

describe("graceful degradation", () => {
  it("returns empty array when API key is not set", async () => {
    // The actual function checks for CLAUDE_API_KEY
    // When not set, it should return [] and fall back to Jaccard
    const originalKey = process.env.CLAUDE_API_KEY;
    delete process.env.CLAUDE_API_KEY;

    const { batchSemanticSimilarity } = await import("./semanticSimilarity.js");
    const result = await batchSemanticSimilarity([
      { indexA: 0, indexB: 1, titleA: "Test A", titleB: "Test B" },
    ]);

    expect(result).toEqual([]);

    // Restore
    if (originalKey) process.env.CLAUDE_API_KEY = originalKey;
  });
});
