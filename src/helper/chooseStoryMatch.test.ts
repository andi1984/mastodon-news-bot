import { describe, test, expect, jest } from "@jest/globals";
import { chooseStoryMatch, type StoryCandidate, type SemanticChecker, type MatchThresholds } from "./chooseStoryMatch.js";
import type { StoryRecord } from "./storyMatcher.js";

const DEFAULT_THRESHOLDS: MatchThresholds = {
  baseThreshold: 0.40,
  followUpThreshold: 0.55,
  uncertainLow: 0.20,
  semanticMatchThreshold: 0.80,
};

function makeStory(opts: Partial<StoryRecord> & { id: string; tooted: boolean }): StoryRecord {
  return {
    id: opts.id,
    created_at: "2026-05-03T00:00:00Z",
    updated_at: "2026-05-03T00:00:00Z",
    article_count: 1,
    tooted: opts.tooted,
    toot_id: opts.tooted ? opts.toot_id ?? `toot-${opts.id}` : null,
    original_links: opts.original_links ?? [],
    primary_title: opts.primary_title ?? `Story ${opts.id}`,
    tokens: opts.tokens ?? [],
  };
}

const noopSemantic: SemanticChecker = async () => new Map();

describe("chooseStoryMatch", () => {
  describe("definite matches", () => {
    test("returns null when no candidates given", async () => {
      const result = await chooseStoryMatch(
        "Some article",
        [],
        DEFAULT_THRESHOLDS,
        noopSemantic
      );
      expect(result).toBeNull();
    });

    test("returns untooted story when jaccard >= baseThreshold", async () => {
      const story = makeStory({ id: "s1", tooted: false });
      const candidates: StoryCandidate[] = [
        { story, jaccardScore: 0.45 },
      ];
      const result = await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        noopSemantic
      );
      expect(result?.story.id).toBe("s1");
      expect(result?.reason).toBe("token");
    });

    test("returns tooted story when jaccard >= followUpThreshold", async () => {
      const story = makeStory({ id: "s1", tooted: true });
      const candidates: StoryCandidate[] = [
        { story, jaccardScore: 0.60 },
      ];
      const result = await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        noopSemantic
      );
      expect(result?.story.id).toBe("s1");
      expect(result?.reason).toBe("token");
    });

    test("does NOT return tooted story when jaccard between baseThreshold and followUpThreshold (no AI)", async () => {
      const story = makeStory({ id: "s1", tooted: true });
      const candidates: StoryCandidate[] = [
        { story, jaccardScore: 0.45 },
      ];
      // Semantic check returns nothing (e.g. budget exhausted)
      const result = await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        async () => new Map()
      );
      expect(result).toBeNull();
    });

    test("when multiple definite matches, highest jaccard wins", async () => {
      const candidates: StoryCandidate[] = [
        { story: makeStory({ id: "s1", tooted: false }), jaccardScore: 0.42 },
        { story: makeStory({ id: "s2", tooted: false }), jaccardScore: 0.50 },
      ];
      const result = await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        noopSemantic
      );
      expect(result?.story.id).toBe("s2");
    });

    test("when multiple tooted definite matches, highest jaccard wins", async () => {
      const candidates: StoryCandidate[] = [
        { story: makeStory({ id: "t1", tooted: true }), jaccardScore: 0.60 },
        { story: makeStory({ id: "t2", tooted: true }), jaccardScore: 0.75 },
      ];
      const result = await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        noopSemantic
      );
      expect(result?.story.id).toBe("t2");
    });
  });

  describe("threading bug fix: AI runs on uncertain tooted even when untooted definite exists", () => {
    // This is the core regression test.
    // Before the fix: an untooted definite match (0.42) would short-circuit the
    // matcher and the tooted borderline candidate (0.50) was never sent to the
    // AI. The article would attach to the untooted story, becoming a new toot
    // instead of a thread reply to the original.
    test("AI-confirmed tooted match is preferred over untooted definite match", async () => {
      const tootedStory = makeStory({
        id: "tooted-parent",
        tooted: true,
        primary_title: "Brand in Saarbrücken",
      });
      const untootedStory = makeStory({
        id: "untooted-other",
        tooted: false,
        primary_title: "Polizei Pressemitteilung Saarbrücken",
      });

      const semanticCheck: SemanticChecker = jest.fn(async (pairs) => {
        const result = new Map<string, number>();
        for (const p of pairs) {
          // Only the tooted story is checked; AI says it's the same event.
          if (p.story.id === "tooted-parent") result.set(p.story.id, 0.90);
        }
        return result;
      });

      const candidates: StoryCandidate[] = [
        { story: tootedStory, jaccardScore: 0.50 }, // borderline tooted
        { story: untootedStory, jaccardScore: 0.42 }, // definite untooted
      ];

      const result = await chooseStoryMatch(
        "Brand in Saarbrücker Innenstadt",
        candidates,
        DEFAULT_THRESHOLDS,
        semanticCheck
      );

      expect(result?.story.id).toBe("tooted-parent");
      expect(result?.reason).toBe("semantic");
      expect(semanticCheck).toHaveBeenCalled();
    });

    test("falls back to untooted definite when AI rejects tooted candidate", async () => {
      // This is the false-positive guard: the boilerplate-overlap police case.
      const tootedStory = makeStory({
        id: "tooted-different-incident",
        tooted: true,
      });
      const untootedStory = makeStory({
        id: "untooted-real-match",
        tooted: false,
      });

      const semanticCheck: SemanticChecker = async (pairs) => {
        const result = new Map<string, number>();
        for (const p of pairs) {
          // AI: tooted candidate is NOT the same event (boilerplate match)
          if (p.story.id === "tooted-different-incident") result.set(p.story.id, 0.20);
        }
        return result;
      };

      const candidates: StoryCandidate[] = [
        { story: tootedStory, jaccardScore: 0.50 },
        { story: untootedStory, jaccardScore: 0.45 },
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        semanticCheck
      );

      expect(result?.story.id).toBe("untooted-real-match");
      expect(result?.reason).toBe("token");
    });

    test("multiple uncertain tooted candidates: highest semantic score wins", async () => {
      const a = makeStory({ id: "tooted-a", tooted: true });
      const b = makeStory({ id: "tooted-b", tooted: true });

      const semanticCheck: SemanticChecker = async (pairs) => {
        const result = new Map<string, number>();
        for (const p of pairs) {
          if (p.story.id === "tooted-a") result.set(p.story.id, 0.82);
          if (p.story.id === "tooted-b") result.set(p.story.id, 0.95);
        }
        return result;
      };

      const candidates: StoryCandidate[] = [
        { story: a, jaccardScore: 0.30 },
        { story: b, jaccardScore: 0.25 },
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        semanticCheck
      );

      expect(result?.story.id).toBe("tooted-b");
      expect(result?.reason).toBe("semantic");
    });

    test("tooted definite (0.60) beats AI-confirmed tooted uncertain (0.50)", async () => {
      const definite = makeStory({ id: "tooted-definite", tooted: true });
      const uncertain = makeStory({ id: "tooted-uncertain", tooted: true });

      const semanticCheck: SemanticChecker = async (pairs) => {
        const result = new Map<string, number>();
        for (const p of pairs) result.set(p.story.id, 0.99);
        return result;
      };

      const candidates: StoryCandidate[] = [
        { story: definite, jaccardScore: 0.60 },
        { story: uncertain, jaccardScore: 0.50 },
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        semanticCheck
      );

      expect(result?.story.id).toBe("tooted-definite");
      expect(result?.reason).toBe("token");
    });
  });

  describe("uncertain untooted candidates", () => {
    test("AI-confirms uncertain untooted candidate when no definite exists", async () => {
      const story = makeStory({ id: "uncertain-untooted", tooted: false });
      const semanticCheck: SemanticChecker = async (pairs) => {
        const result = new Map<string, number>();
        for (const p of pairs) result.set(p.story.id, 0.85);
        return result;
      };

      const candidates: StoryCandidate[] = [
        { story, jaccardScore: 0.30 },
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        semanticCheck
      );

      expect(result?.story.id).toBe("uncertain-untooted");
      expect(result?.reason).toBe("semantic");
    });

    test("rejects uncertain untooted when AI score below threshold", async () => {
      const story = makeStory({ id: "uncertain-untooted", tooted: false });
      const semanticCheck: SemanticChecker = async (pairs) => {
        const result = new Map<string, number>();
        for (const p of pairs) result.set(p.story.id, 0.70);
        return result;
      };

      const candidates: StoryCandidate[] = [
        { story, jaccardScore: 0.30 },
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        semanticCheck
      );

      expect(result).toBeNull();
    });

    test("ignores below-uncertainLow candidates entirely (no AI call)", async () => {
      const story = makeStory({ id: "irrelevant", tooted: false });
      const semanticCheck: SemanticChecker = jest.fn(async () => new Map());

      const candidates: StoryCandidate[] = [
        { story, jaccardScore: 0.05 },
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        semanticCheck
      );

      expect(result).toBeNull();
      expect(semanticCheck).not.toHaveBeenCalled();
    });
  });

  describe("AI candidate cap", () => {
    test("limits AI calls to top-N uncertain candidates by jaccard", async () => {
      const candidates: StoryCandidate[] = Array.from({ length: 10 }, (_, i) =>
        ({
          story: makeStory({ id: `s${i}`, tooted: true }),
          jaccardScore: 0.30 + i * 0.01, // 0.30..0.39 (all uncertain tooted)
        })
      );

      let aiCallCount = 0;
      const semanticCheck: SemanticChecker = async (pairs) => {
        aiCallCount = pairs.length;
        return new Map();
      };

      await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        semanticCheck
      );

      // The implementation caps AI calls to top 3 candidates
      expect(aiCallCount).toBeLessThanOrEqual(3);
    });

    test("passes the highest-scoring uncertain candidates to AI first", async () => {
      const candidates: StoryCandidate[] = [
        { story: makeStory({ id: "low", tooted: true }), jaccardScore: 0.22 },
        { story: makeStory({ id: "mid", tooted: true }), jaccardScore: 0.30 },
        { story: makeStory({ id: "high", tooted: true }), jaccardScore: 0.50 },
      ];

      const sentIds: string[] = [];
      const semanticCheck: SemanticChecker = async (pairs) => {
        for (const p of pairs) sentIds.push(p.story.id);
        return new Map();
      };

      await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        semanticCheck
      );

      // First sent should be the highest-scored uncertain
      expect(sentIds[0]).toBe("high");
    });
  });

  describe("follow-up eligibility caps", () => {
    const NOW = new Date("2026-06-10T12:00:00Z");
    const CAPPED_THRESHOLDS: MatchThresholds = {
      ...DEFAULT_THRESHOLDS,
      followUpMaxAgeHours: 72,
      maxArticlesPerStory: 8,
    };

    test("tooted story older than followUpMaxAgeHours is not matched even with definite jaccard", async () => {
      const oldStory = makeStory({ id: "old-tooted", tooted: true });
      oldStory.created_at = "2026-06-01T12:00:00Z"; // 216h old
      const candidates: StoryCandidate[] = [
        { story: oldStory, jaccardScore: 0.9 },
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        CAPPED_THRESHOLDS,
        noopSemantic,
        NOW
      );

      expect(result).toBeNull();
    });

    test("tooted story within followUpMaxAgeHours still matches", async () => {
      const freshStory = makeStory({ id: "fresh-tooted", tooted: true });
      freshStory.created_at = "2026-06-09T12:00:00Z"; // 24h old
      const candidates: StoryCandidate[] = [
        { story: freshStory, jaccardScore: 0.9 },
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        CAPPED_THRESHOLDS,
        noopSemantic,
        NOW
      );

      expect(result?.story.id).toBe("fresh-tooted");
    });

    test("tooted story at maxArticlesPerStory is not matched (thread is full)", async () => {
      const fullStory = makeStory({ id: "full-tooted", tooted: true });
      fullStory.created_at = "2026-06-09T12:00:00Z";
      fullStory.article_count = 8;
      const candidates: StoryCandidate[] = [
        { story: fullStory, jaccardScore: 0.9 },
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        CAPPED_THRESHOLDS,
        noopSemantic,
        NOW
      );

      expect(result).toBeNull();
    });

    test("ineligible tooted candidate is not sent to AI", async () => {
      const oldStory = makeStory({ id: "old-tooted", tooted: true });
      oldStory.created_at = "2026-06-01T12:00:00Z";
      const semanticCheck: SemanticChecker = jest.fn(async () => new Map());
      const candidates: StoryCandidate[] = [
        { story: oldStory, jaccardScore: 0.5 }, // borderline → would go to AI
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        CAPPED_THRESHOLDS,
        semanticCheck,
        NOW
      );

      expect(result).toBeNull();
      expect(semanticCheck).not.toHaveBeenCalled();
    });

    test("untooted stories are unaffected by follow-up caps", async () => {
      const oldUntooted = makeStory({ id: "old-untooted", tooted: false });
      oldUntooted.created_at = "2026-06-01T12:00:00Z";
      oldUntooted.article_count = 20;
      const candidates: StoryCandidate[] = [
        { story: oldUntooted, jaccardScore: 0.5 },
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        CAPPED_THRESHOLDS,
        noopSemantic,
        NOW
      );

      expect(result?.story.id).toBe("old-untooted");
    });

    test("ineligible tooted is skipped but untooted definite still wins", async () => {
      const oldTooted = makeStory({ id: "old-tooted", tooted: true });
      oldTooted.created_at = "2026-06-01T12:00:00Z";
      const untooted = makeStory({ id: "untooted", tooted: false });
      untooted.created_at = "2026-06-10T00:00:00Z";

      const candidates: StoryCandidate[] = [
        { story: oldTooted, jaccardScore: 0.9 },
        { story: untooted, jaccardScore: 0.45 },
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        CAPPED_THRESHOLDS,
        noopSemantic,
        NOW
      );

      expect(result?.story.id).toBe("untooted");
    });

    test("caps are inactive when not configured (backwards compatible)", async () => {
      const oldStory = makeStory({ id: "old-tooted", tooted: true });
      oldStory.created_at = "2026-06-01T12:00:00Z";
      oldStory.article_count = 40;
      const candidates: StoryCandidate[] = [
        { story: oldStory, jaccardScore: 0.9 },
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        noopSemantic,
        NOW
      );

      expect(result?.story.id).toBe("old-tooted");
    });
  });

  describe("semantic check failures", () => {
    test("handles semantic check returning empty map (budget exhausted)", async () => {
      const tootedStory = makeStory({ id: "tooted", tooted: true });
      const untootedStory = makeStory({ id: "untooted", tooted: false });

      const candidates: StoryCandidate[] = [
        { story: tootedStory, jaccardScore: 0.50 },
        { story: untootedStory, jaccardScore: 0.45 },
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        async () => new Map() // budget exhausted
      );

      // Falls back to untooted definite match
      expect(result?.story.id).toBe("untooted");
      expect(result?.reason).toBe("token");
    });

    test("handles semantic check throwing", async () => {
      const tootedStory = makeStory({ id: "tooted", tooted: true });
      const untootedStory = makeStory({ id: "untooted", tooted: false });

      const candidates: StoryCandidate[] = [
        { story: tootedStory, jaccardScore: 0.50 },
        { story: untootedStory, jaccardScore: 0.45 },
      ];

      const result = await chooseStoryMatch(
        "title",
        candidates,
        DEFAULT_THRESHOLDS,
        async () => {
          throw new Error("AI down");
        }
      );

      // Should not crash; falls back to untooted definite
      expect(result?.story.id).toBe("untooted");
    });
  });
});
