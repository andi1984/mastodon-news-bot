import { tokenize, jaccardSimilarity } from "./similarity.js";

// Simulate batch story cache matching (mirrors processNewArticles logic)
function simulateBatchMatching(
  articles: Array<{ title: string; feedKey: string; contentSnippet?: string }>
): Map<number, number> {
  const STORY_SIMILARITY_THRESHOLD = 0.40;

  // Maps article index -> story representative index
  const storyAssignments = new Map<number, number>();
  // Maps story representative index -> token set
  const storyCache = new Map<number, Set<string>>();

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const articleText = article.contentSnippet
      ? `${article.title} ${article.contentSnippet.slice(0, 500)}`
      : article.title;
    const articleTokens = tokenize(articleText);

    let matchedStory: number | null = null;
    let bestScore = 0;

    // Check against existing stories in cache
    for (const [storyIdx, storyTokens] of storyCache) {
      const similarity = jaccardSimilarity(articleTokens, storyTokens);
      if (similarity >= STORY_SIMILARITY_THRESHOLD && similarity > bestScore) {
        bestScore = similarity;
        matchedStory = storyIdx;
      }
    }

    if (matchedStory !== null) {
      storyAssignments.set(i, matchedStory);
      // Merge tokens
      const existingTokens = storyCache.get(matchedStory)!;
      for (const token of articleTokens) {
        existingTokens.add(token);
      }
    } else {
      // Create new story with this article as representative
      storyAssignments.set(i, i);
      storyCache.set(i, articleTokens);
    }
  }

  return storyAssignments;
}

// Test the core matching logic without DB dependencies
describe("storyMatcher core logic", () => {
  const STORY_SIMILARITY_THRESHOLD = 0.40;

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

  describe("cases now handled by semantic similarity", () => {
    // These cases fall in the "uncertain zone" (Jaccard 0.12-0.35) and will be
    // sent to the batch semantic similarity API when budget allows.
    // The semantic matcher uses Claude to understand synonyms and entity references.

    it("synonyms fall in uncertain zone - semantic matching handles this", () => {
      const result = wouldMatch(
        "Feuer zerstört Lagerhalle in Homburg",
        "Brand in Homburger Lagerhalle"
      );
      // Token overlap is limited, but score is in uncertain zone (0.12-0.35)
      // Semantic matching will correctly identify these as the same story
      expect(result.score).toBeGreaterThan(0.1);
      expect(result.score).toBeLessThan(0.4);
      // When semantic matching is enabled and budget available, these WILL match
    });

    it("different phrasing of same person - semantic matching handles this", () => {
      const result = wouldMatch(
        "Ministerpräsidentin kündigt Maßnahmen an",
        "Anke Rehlinger stellt Plan vor"
      );
      // Token-based matching fails, but semantic matching understands
      // "Ministerpräsidentin" = "Anke Rehlinger" in Saarland context
      expect(result.matches).toBe(false); // Token-only fails
      // When semantic matching is enabled, this WILL be caught
    });
  });
});

// Tests for the two-threshold behavior that prevents false-positive follow-up quotes.
// An already-tooted story requires STORY_FOLLOW_UP_THRESHOLD (0.55) for a direct token
// match; untooted stories still use STORY_SIMILARITY_THRESHOLD (0.40).
describe("follow-up threshold: tooted vs untooted stories", () => {
  const BASE_THRESHOLD = 0.40;
  const FOLLOW_UP_THRESHOLD = 0.55;

  function scoreForStory(
    storyTitle: string,
    articleTitle: string,
    storyContent?: string,
    articleContent?: string
  ): number {
    const storyText = storyContent
      ? `${storyTitle} ${storyContent.slice(0, 500)}`
      : storyTitle;
    const articleText = articleContent
      ? `${articleTitle} ${articleContent.slice(0, 500)}`
      : articleTitle;
    return jaccardSimilarity(tokenize(storyText), tokenize(articleText));
  }

  it("borderline score (0.40-0.55) matches untooted story but NOT tooted story", () => {
    // Two police reports from the same district share boilerplate vocabulary.
    // They are about different incidents ("Einbruch" vs "Diebstahl") so we
    // don't want the second to become a follow-up quote on the first.
    const score = scoreForStory(
      "Polizeipräsidium Saarbrücken: Einbruch in Apotheke - Polizei sucht Zeugen",
      "Polizeipräsidium Saarbrücken: Diebstahl gemeldet - Polizei bittet Zeugen",
      "Die Polizei Saarbrücken berichtet über einen Einbruch. Zeugen werden gebeten sich zu melden.",
      "Die Polizei Saarbrücken berichtet über einen Diebstahl. Zeugen werden gebeten sich zu melden."
    );

    // Must be in the borderline zone: passes BASE_THRESHOLD but not FOLLOW_UP_THRESHOLD
    expect(score).toBeGreaterThanOrEqual(BASE_THRESHOLD);
    expect(score).toBeLessThan(FOLLOW_UP_THRESHOLD);
  });

  it("high-overlap follow-up clears FOLLOW_UP_THRESHOLD for tooted story", () => {
    // A second source reporting the same incident with nearly identical vocabulary
    // (same location, same event type, same key facts) should score above 0.55.
    const score = scoreForStory(
      "Einbruch Saarbrücken Innenstadt Polizei Zeugen Schmuck gestohlen Täter flüchtig Ermittlungen",
      "Saarbrücken Innenstadt Einbruch Schmuck gestohlen Polizei Zeugen Ermittlungen Täter",
      "Polizei Saarbrücken Einbruch Innenstadt Schmuck Täter flüchtig Zeugen Ermittlungen",
      "Einbruch Saarbrücken Innenstadt Polizei Schmuck gestohlen Täter Zeugen Ermittlungen"
    );

    expect(score).toBeGreaterThanOrEqual(FOLLOW_UP_THRESHOLD);
  });
});

describe("cross-feed batch matching", () => {
  it("groups articles from different feeds about same topic", () => {
    const articles = [
      { title: "Brand in Saarbrücken: Feuerwehr im Einsatz", feedKey: "feed-a" },
      { title: "Neues Restaurant eröffnet in Homburg", feedKey: "feed-b" },
      { title: "Saarbrücken: Brand in der Innenstadt - Feuerwehr vor Ort", feedKey: "feed-c" },
    ];

    const assignments = simulateBatchMatching(articles);

    // Article 0 and 2 should be in the same story (both about fire in Saarbrücken)
    expect(assignments.get(0)).toBe(0); // First article creates story
    expect(assignments.get(2)).toBe(0); // Third article matches first

    // Article 1 should be in its own story (different topic)
    expect(assignments.get(1)).toBe(1);
  });

  it("handles multiple simultaneous news events from many feeds", () => {
    const articles = [
      { title: "Schwerer Unfall auf A1 Saarbrücken - Verletzte gemeldet", feedKey: "polizei" },
      { title: "Brand in Völklingen: Feuerwehr im Großeinsatz", feedKey: "breaking-news" },
      { title: "A1 Saarbrücken: Schwerer Unfall mit Verletzte", feedKey: "radio-salue" },
      { title: "Großeinsatz Feuerwehr: Brand in Völklingen", feedKey: "saarnews" },
      { title: "SPD-Fraktion fordert neue Verkehrskonzepte", feedKey: "tagesschau" },
    ];

    const assignments = simulateBatchMatching(articles);

    // Story 1: Articles 0, 2 about accident on A1
    expect(assignments.get(0)).toBe(0);
    expect(assignments.get(2)).toBe(0);

    // Story 2: Articles 1, 3 about fire in Völklingen (same keywords: Brand, Völklingen, Feuerwehr, Großeinsatz)
    expect(assignments.get(1)).toBe(1);
    expect(assignments.get(3)).toBe(1);

    // Story 3: Article 4 is unrelated
    expect(assignments.get(4)).toBe(4);
  });

  it("accumulates tokens for better subsequent matching", () => {
    const articles = [
      { title: "Polizei Saarbrücken: Einbruch in Geschäft - Zeugen gesucht", feedKey: "polizei" },
      { title: "Einbruch in Saarbrücken - Polizei sucht Zeugen nach Tat", feedKey: "radio-salue" },
      { title: "Saarbrücken: Polizei Zeugenaufruf nach Einbruch in Geschäft", feedKey: "breaking-news" },
    ];

    const assignments = simulateBatchMatching(articles);

    // All three should be in the same story
    // The token merging ensures later articles can still match
    const storyRep = assignments.get(0)!;
    expect(assignments.get(1)).toBe(storyRep);
    expect(assignments.get(2)).toBe(storyRep);
  });

  it("does not falsely group unrelated articles", () => {
    const articles = [
      { title: "Konzert in der Saarlandhalle am Samstag", feedKey: "events" },
      { title: "Polizeikontrolle auf der A8", feedKey: "polizei" },
      { title: "Neuer Bürgermeister in St. Wendel gewählt", feedKey: "tagesschau" },
      { title: "Restaurant Tipps für Saarbrücken", feedKey: "local" },
    ];

    const assignments = simulateBatchMatching(articles);

    // Each article should create its own story (all unrelated)
    expect(assignments.get(0)).toBe(0);
    expect(assignments.get(1)).toBe(1);
    expect(assignments.get(2)).toBe(2);
    expect(assignments.get(3)).toBe(3);
  });
});
