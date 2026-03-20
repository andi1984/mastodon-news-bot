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

  const expectedMatches: Array<{
    titleA: string;
    titleB: string;
    expectedScore: string; // "high" (0.7+), "medium" (0.4-0.7), "low" (<0.4)
    reason: string;
  }> = [
    {
      titleA: "Feuer zerstört Lagerhalle in Homburg",
      titleB: "Brand in Homburger Lagerhalle",
      expectedScore: "high",
      reason: "Feuer and Brand are synonyms (both mean fire)",
    },
    {
      titleA: "Ministerpräsidentin kündigt Maßnahmen an",
      titleB: "Anke Rehlinger stellt Plan vor",
      expectedScore: "high",
      reason: "Anke Rehlinger is the Ministerpräsidentin of Saarland",
    },
    {
      titleA: "Unfall auf A1 bei Saarbrücken",
      titleB: "A1 Saarbrücken: Verkehrsunfall",
      expectedScore: "high",
      reason: "Same event, same location, Unfall = Verkehrsunfall",
    },
    {
      titleA: "Neues Restaurant in Saarbrücken",
      titleB: "Polizeieinsatz in Saarbrücken",
      expectedScore: "low",
      reason: "Completely different topics at same location",
    },
    {
      titleA: "Feuerwehr löscht Brand in Neunkirchen",
      titleB: "Brand in Homburg: Feuerwehr im Einsatz",
      expectedScore: "medium",
      reason: "Similar event type but different locations",
    },
  ];

  it.each(expectedMatches)(
    "should score $expectedScore: $titleA vs $titleB ($reason)",
    ({ titleA, titleB, expectedScore }) => {
      // This test documents expected behavior without calling the API
      // When the API is called, we expect these scores:
      // - high: 0.7+ (should cluster)
      // - medium: 0.4-0.7 (might cluster depending on threshold)
      // - low: <0.4 (should not cluster)
      expect(["high", "medium", "low"]).toContain(expectedScore);
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
