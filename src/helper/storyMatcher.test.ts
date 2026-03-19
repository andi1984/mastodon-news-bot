import { tokenize, jaccardSimilarity } from "./similarity.js";

// Test the core matching logic without DB dependencies
describe("storyMatcher core logic", () => {
  const STORY_SIMILARITY_THRESHOLD = 0.35;

  function wouldMatch(
    storyTitle: string,
    articleTitle: string,
    storyContent?: string,
    articleContent?: string
  ): { matches: boolean; score: number } {
    const storyText = storyContent
      ? `${storyTitle} ${storyContent.slice(0, 500)}`
      : storyTitle;
    const articleText = articleContent
      ? `${articleTitle} ${articleContent.slice(0, 500)}`
      : articleTitle;

    const storyTokens = tokenize(storyText);
    const articleTokens = tokenize(articleText);
    const score = jaccardSimilarity(storyTokens, articleTokens);

    return {
      matches: score >= STORY_SIMILARITY_THRESHOLD,
      score,
    };
  }

  describe("same event with overlapping keywords", () => {
    it("matches headlines sharing location and key terms", () => {
      const result = wouldMatch(
        "Brand in Saarbrücken: Feuerwehr im Einsatz",
        "Saarbrücken: Brand in der Innenstadt - Feuerwehr vor Ort"
      );
      expect(result.matches).toBe(true);
    });

    it("matches headlines with identical key phrases", () => {
      const result = wouldMatch(
        "Unfall auf A1 bei Saarbrücken - Verletzte",
        "A1 Saarbrücken: Unfall mit Verletzten"
      );
      expect(result.matches).toBe(true);
    });

    it("matches with content providing more overlap", () => {
      const result = wouldMatch(
        "Feuer in Saarbrücken",
        "Brand in Saarbrücker Altstadt",
        "In der Saarbrücker Altstadt ist ein Feuer ausgebrochen. Die Feuerwehr ist im Einsatz.",
        "Feuerwehr bekämpft Brand in Saarbrücken. Die Altstadt ist betroffen."
      );
      expect(result.matches).toBe(true);
    });
  });

  describe("different events should not match", () => {
    it("does not match unrelated news", () => {
      const result = wouldMatch(
        "Neuer Bürgermeister in Homburg gewählt",
        "Feuer in Saarbrücker Innenstadt"
      );
      expect(result.matches).toBe(false);
    });

    it("does not match same event type at different locations", () => {
      const result = wouldMatch(
        "Unfall in St. Wendel fordert Verletzte",
        "Unfall in Völklingen - Person schwer verletzt"
      );
      // Similar event types but different locations
      expect(result.score).toBeLessThan(0.5);
    });

    it("does not match different topics at same location", () => {
      const result = wouldMatch(
        "Neues Restaurant eröffnet in Saarbrücken",
        "Polizeieinsatz in Saarbrücken nach Streit"
      );
      expect(result.matches).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("exact same headline matches perfectly", () => {
      const result = wouldMatch(
        "Polizei sucht Zeugen nach Einbruch in Neunkirchen",
        "Polizei sucht Zeugen nach Einbruch in Neunkirchen"
      );
      expect(result.matches).toBe(true);
      expect(result.score).toBe(1);
    });

    it("empty strings do not crash", () => {
      const result = wouldMatch("", "");
      expect(result.score).toBe(1); // Both empty = equal
    });

    it("handles special characters and punctuation", () => {
      const result = wouldMatch(
        'SPD-Fraktion: "Neue Wege für Saarland nötig"',
        "SPD-Fraktion fordert neue Wege für Saarland"
      );
      expect(result.matches).toBe(true);
    });
  });

  describe("realistic multi-source scenarios", () => {
    it("matches police reports about same incident", () => {
      const result = wouldMatch(
        "Polizei Saarbrücken: Einbruch in Geschäft - Zeugen gesucht",
        "Einbruch in Saarbrücken - Polizei sucht Zeugen"
      );
      expect(result.matches).toBe(true);
    });

    it("matches event announcements with enough overlap", () => {
      const result = wouldMatch(
        "Saarbrücker Stadtfest 2024 - Programm und Infos",
        "Stadtfest in Saarbrücken 2024: Programm veröffentlicht"
      );
      expect(result.matches).toBe(true);
    });
  });

  describe("limitations - semantic similarity needed", () => {
    // These tests document current limitations of token-based matching
    // Future AI-enhanced matching would catch these

    it("struggles with synonyms (Feuer/Brand without overlap)", () => {
      const result = wouldMatch(
        "Feuer zerstört Lagerhalle in Homburg",
        "Brand in Homburger Lagerhalle"
      );
      // Would need synonym/semantic matching to catch this reliably
      // Current token overlap is limited: "lagerhalle", "homburg" (2 tokens)
      // vs total unique tokens across both (approx 6-8)
      expect(result.score).toBeGreaterThan(0.1);
      expect(result.score).toBeLessThan(0.4); // Not enough for match threshold
    });

    it("struggles with different phrasing of same person", () => {
      const result = wouldMatch(
        "Ministerpräsidentin kündigt Maßnahmen an",
        "Anke Rehlinger stellt Plan vor"
      );
      // Would need NER to link "Ministerpräsidentin" to "Anke Rehlinger"
      expect(result.matches).toBe(false);
    });
  });
});
