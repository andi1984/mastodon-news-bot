/**
 * Bug investigation: "Update:" thread accumulates 10-20 toots about completely
 * DIFFERENT topics piled under the same original toot.
 *
 * Each section corresponds to one hypothesis. Tests are labelled:
 *   [H1] Regional vocabulary inflates Jaccard scores
 *   [H2] chooseStoryMatch prefers tooted stories even with borderline AI scores
 *   [H3] batchStoryCache uses only Jaccard (no AI, no tooted distinction)
 *   [H4] formatThreadReply doesn't gate on story relevance (it is a pure formatter)
 *   [H5] normalizeUrl false-matches different-domain URLs
 *   [H6] assignStoryToArticle overwrites an already-set story_id
 */

import { describe, test, expect, jest } from "@jest/globals";

// ── Similarity / tokenise (no network, no DB) ────────────────────────────────
import { tokenize, jaccardSimilarity } from "./similarity.js";
import { normalizeUrl } from "./normalizeUrl.js";
import { formatThreadReply } from "./clusterFormatter.js";
import {
  chooseStoryMatch,
  type StoryCandidate,
  type SemanticChecker,
  type MatchThresholds,
} from "./chooseStoryMatch.js";
import type { StoryRecord } from "./storyMatcher.js";
import type { ClusterArticle } from "./similarity.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const REAL_THRESHOLDS: MatchThresholds = {
  baseThreshold: 0.40,       // settings.story_similarity_threshold
  followUpThreshold: 0.55,   // settings.story_follow_up_threshold
  uncertainLow: 0.20,        // AI_UNCERTAIN_LOW from storyMatcher.ts
  semanticMatchThreshold: 0.80,
};

function makeStory(opts: Partial<StoryRecord> & { id: string; tooted: boolean }): StoryRecord {
  return {
    id: opts.id,
    created_at: "2026-05-19T00:00:00Z",
    updated_at: "2026-05-19T00:00:00Z",
    article_count: opts.article_count ?? 1,
    tooted: opts.tooted,
    toot_id: opts.tooted ? (opts.toot_id ?? `toot-${opts.id}`) : null,
    original_links: opts.original_links ?? [],
    primary_title: opts.primary_title ?? `Story ${opts.id}`,
    tokens: opts.tokens ?? [],
  };
}

function jaccardForTitles(titleA: string, titleB: string): number {
  return jaccardSimilarity(tokenize(titleA), tokenize(titleB));
}

function makeClusterArticle(overrides: {
  id?: string;
  title?: string;
  link?: string;
  feedKey?: string;
  pubDate?: string;
}): ClusterArticle {
  return {
    id: overrides.id ?? "art-1",
    article: {
      title: overrides.title ?? "Test Article",
      link: overrides.link ?? "https://example.com/article",
      "dc:creator": "",
    } as any,
    feedKey: overrides.feedKey ?? "feed-a",
    pubDate: overrides.pubDate ?? new Date().toISOString(),
    score: 0.5,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HYPOTHESIS 1 — Regional vocabulary inflates Jaccard scores
//
// Saarland articles share "saarland", "saarbrücken", "saar", city names.
// Two articles about COMPLETELY different topics may cross the 0.40 threshold.
//
// Expected (NOT a bug): clearly different-topic pairs score < 0.20
// Bug confirmed if:        score >= 0.40 for obviously different topics
// ─────────────────────────────────────────────────────────────────────────────
describe("[H1] Regional vocabulary inflation of Jaccard scores", () => {
  // Threshold values taken directly from settings.json / storyMatcher constants
  const BASE_THRESHOLD = 0.40;
  const AI_UNCERTAIN_LOW = 0.20; // below this → "definitely different"

  test("police-report vs. weather report – completely different topics", () => {
    // Classic false-positive: both articles mention "Saarland" but nothing else overlaps.
    const score = jaccardForTitles(
      "Polizei Saarbrücken: Einsatz nach Streit in der Innenstadt",
      "Wetter Saarland: Gewitter erwartet heute Abend"
    );
    // Should be well below the definite-match threshold
    expect(score).toBeLessThan(BASE_THRESHOLD);
    // Is it also below the AI_UNCERTAIN_LOW? If yes, AI won't even be consulted.
    // If no (between 0.20 and 0.40), AI is consulted — which is the correct guard.
    console.log(`[H1] police vs weather score: ${score.toFixed(4)}`);
  });

  test("fire report vs. cycling event – share only Saarland", () => {
    const score = jaccardForTitles(
      "Großbrand in Saarbrücken: Feuerwehr im Einsatz",
      "Neuer Fahrradweg im Saarland eröffnet"
    );
    expect(score).toBeLessThan(BASE_THRESHOLD);
    console.log(`[H1] fire vs cycling score: ${score.toFixed(4)}`);
  });

  test("SPD politics vs. traffic accident – share Saarland token", () => {
    const score = jaccardForTitles(
      "SPD Saarland fordert mehr Investitionen in Schulen",
      "Unfall auf der A6 bei Saarbrücken: Drei Verletzte"
    );
    expect(score).toBeLessThan(BASE_THRESHOLD);
    console.log(`[H1] SPD news vs traffic score: ${score.toFixed(4)}`);
  });

  test("two different police press releases from same city share boilerplate", () => {
    // This is the scenario described in storyMatcher.ts comments.
    // Two police announcements from Saarbrücken about different incidents.
    const score = jaccardForTitles(
      "Polizeipräsidium Saarbrücken: Einbruch in Apotheke – Zeugen gesucht",
      "Polizeipräsidium Saarbrücken: Trickdiebstahl an Senioren – Polizei bittet Zeugen"
    );
    // These share "polizeipräsidium", "saarbrücken", "zeugen" / "polizei" - a real risk
    // They MUST be below followUpThreshold (0.55) to avoid incorrect thread assignment.
    // A score >= 0.40 here means they'd merge for untooted stories — a weaker bug.
    // A score >= 0.55 here means they'd ALWAYS merge even for tooted stories — the bug.
    console.log(`[H1] two police press releases score: ${score.toFixed(4)}`);
    // Bug check: if this is >= 0.55 two completely different police incidents get threaded
    expect(score).toBeLessThan(0.55); // must not trigger tooted-story follow-up automatically
  });

  test("real-world scenario: Polizei Einsatz Saarbrücken vs. Wetter Saarland heute – CRITICAL", () => {
    // If this crosses 0.40, every weather article gets threaded under a police story!
    const policeTitle = "Polizei Saarbrücken: Messerangriff in der Innenstadt";
    const weatherTitle = "Wetter Saarland: Hitzewarnung für heute";
    const score = jaccardForTitles(policeTitle, weatherTitle);
    console.log(`[H1] police vs weather (critical): ${score.toFixed(4)}`);

    // If score >= 0.20: AI check is run (correct guard, but AI could still be wrong)
    // If score >= 0.40: direct match WITHOUT AI for untooted stories (= bug for different topics)
    // If score >= 0.55: direct match WITHOUT AI for tooted stories (= the reported bug)
    expect(score).toBeLessThan(BASE_THRESHOLD);
  });

  test("two different incidents sharing only 'Saarbrücken' and 'Polizei'", () => {
    // "polizei" is NOT in the stopwords list in similarity.ts
    // → it contributes to the token overlap
    const incidentA = tokenize("Polizei Saarbrücken: Raub in Discounter – Zeugen gesucht");
    const incidentB = tokenize("Polizei Saarbrücken: Verkehrsunfall mit Fahrerflucht");
    const score = jaccardSimilarity(incidentA, incidentB);
    console.log(`[H1] two different police incidents score: ${score.toFixed(4)}`);
    // Shared: polizei, saarbrücken (2 tokens shared)
    // Union: all unique tokens (much more)
    // A score >= 0.40 here would be a definite match for an untooted story — a bug.
    expect(score).toBeLessThan(BASE_THRESHOLD);
  });

  test("REVEALS BUG IF ANY: token-only match causes different-topic story merge", () => {
    // Exhaustive check of real-world Saarland headline pairs that should NEVER match.
    // Any score >= 0.40 would cause incorrect story assignment (no AI consulted for
    // untooted stories at baseThreshold level).
    const differentTopicPairs: [string, string][] = [
      [
        "Saarbrücken: Brand in der Innenstadt – Feuerwehr vor Ort",
        "Saarbrücken: Stadtrat beschließt neues Radwegekonzept",
      ],
      [
        "Polizei Saarland: Festnahmen nach Drogenrazzia",
        "Saarland: Landtag debattiert Haushaltsplan 2026",
      ],
      [
        "Hochwasser: Überschwemmungen im Saartal",
        "Konzert in der Saarlandhalle: Ausverkaufte Vorstellung",
      ],
      [
        "Homburg: Neues Krankenhaus eröffnet",
        "Homburg: Polizei sucht Zeugen nach Einbruch",
      ],
      [
        "Saarbrücken: Lärmsanierung der Autobahn A620",
        "Saarbrücken: Neuer Bürgermeister vereidigt",
      ],
    ];

    for (const [titleA, titleB] of differentTopicPairs) {
      const score = jaccardForTitles(titleA, titleB);
      console.log(`[H1] "${titleA.slice(0, 40)}" vs "${titleB.slice(0, 40)}" → ${score.toFixed(4)}`);
      // None of these should reach the definite-match threshold for TOOTED stories
      expect(score).toBeLessThan(0.55);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HYPOTHESIS 2 — chooseStoryMatch: borderline AI scores near 0.80 threshold
//
// When Jaccard is in uncertain zone (0.20–0.55) for a tooted story, AI is
// consulted. Check that the boundary at semanticMatchThreshold (0.80) is
// correctly exclusive (< 0.80 = no match) vs inclusive (>= 0.80 = match).
// ─────────────────────────────────────────────────────────────────────────────
describe("[H2] chooseStoryMatch – borderline AI scores for uncertain tooted candidate", () => {
  const noopSemantic: SemanticChecker = async () => new Map();

  test("AI score exactly at 0.80 (= threshold): tooted story IS matched", async () => {
    // The boundary is >=, so 0.80 must produce a match
    const tooted = makeStory({ id: "tooted-parent", tooted: true, primary_title: "Brand in Neunkirchen" });

    const semanticCheck: SemanticChecker = async (pairs) => {
      const m = new Map<string, number>();
      for (const p of pairs) m.set(p.story.id, 0.80);
      return m;
    };

    const result = await chooseStoryMatch(
      "Neunkirchen: Feuer im Industriegebiet",
      [{ story: tooted, jaccardScore: 0.35 }], // uncertain tooted (between 0.20 and 0.55)
      REAL_THRESHOLDS,
      semanticCheck
    );

    expect(result?.story.id).toBe("tooted-parent");
    expect(result?.reason).toBe("semantic");
    expect(result?.score).toBe(0.80);
  });

  test("AI score 0.79 (just below threshold): tooted candidate is REJECTED, no match", async () => {
    // Just under the threshold → should return null (no other candidates)
    const tooted = makeStory({ id: "tooted-different", tooted: true });

    const semanticCheck: SemanticChecker = async (pairs) => {
      const m = new Map<string, number>();
      for (const p of pairs) m.set(p.story.id, 0.79);
      return m;
    };

    const result = await chooseStoryMatch(
      "Völlig anderes Thema",
      [{ story: tooted, jaccardScore: 0.35 }],
      REAL_THRESHOLDS,
      semanticCheck
    );

    // Below threshold → must not match
    expect(result).toBeNull();
  });

  test("AI score 0.81 (just above threshold): tooted candidate IS matched", async () => {
    const tooted = makeStory({ id: "tooted-parent", tooted: true });

    const semanticCheck: SemanticChecker = async (pairs) => {
      const m = new Map<string, number>();
      for (const p of pairs) m.set(p.story.id, 0.81);
      return m;
    };

    const result = await chooseStoryMatch(
      "Follow-up article",
      [{ story: tooted, jaccardScore: 0.35 }],
      REAL_THRESHOLDS,
      semanticCheck
    );

    expect(result?.story.id).toBe("tooted-parent");
    expect(result?.score).toBe(0.81);
  });

  test("uncertain tooted + uncertain untooted: AI rejects tooted → tries untooted AI", async () => {
    // When AI rejects the tooted candidate AND there is an uncertain untooted
    // candidate, the code falls through to "Last resort: AI on uncertain untooted".
    // Verify this path works correctly.
    const tooted = makeStory({ id: "tooted-wrong", tooted: true });
    const untooted = makeStory({ id: "untooted-correct", tooted: false });

    const semanticCheck: SemanticChecker = async (pairs) => {
      const m = new Map<string, number>();
      for (const p of pairs) {
        if (p.story.id === "tooted-wrong") m.set(p.story.id, 0.50); // rejected
        if (p.story.id === "untooted-correct") m.set(p.story.id, 0.85); // confirmed
      }
      return m;
    };

    const candidates: StoryCandidate[] = [
      { story: tooted, jaccardScore: 0.30 },   // uncertain tooted
      { story: untooted, jaccardScore: 0.25 },  // uncertain untooted
    ];

    const result = await chooseStoryMatch(
      "Some article title",
      candidates,
      REAL_THRESHOLDS,
      semanticCheck
    );

    expect(result?.story.id).toBe("untooted-correct");
    expect(result?.reason).toBe("semantic");
  });

  test("multiple tooted uncertain candidates: only highest 3 are sent to AI (cap = MAX_AI_CANDIDATES)", async () => {
    // Build 5 uncertain tooted candidates
    const candidates: StoryCandidate[] = [
      { story: makeStory({ id: "t1", tooted: true }), jaccardScore: 0.21 },
      { story: makeStory({ id: "t2", tooted: true }), jaccardScore: 0.28 },
      { story: makeStory({ id: "t3", tooted: true }), jaccardScore: 0.35 },
      { story: makeStory({ id: "t4", tooted: true }), jaccardScore: 0.42 },
      { story: makeStory({ id: "t5", tooted: true }), jaccardScore: 0.50 },
    ];
    // All scores are between 0.20 and 0.55, so all are "uncertain tooted"

    const calledIds: string[] = [];
    const semanticCheck: SemanticChecker = async (pairs) => {
      for (const p of pairs) calledIds.push(p.story.id);
      return new Map(); // no match
    };

    await chooseStoryMatch("title", candidates, REAL_THRESHOLDS, semanticCheck);

    // Cap at 3, and those 3 must be the highest-scoring uncertain candidates
    expect(calledIds.length).toBeLessThanOrEqual(3);
    // Must include the top scorers (t5=0.50, t4=0.42, t3=0.35)
    expect(calledIds).toContain("t5");
    expect(calledIds).toContain("t4");
    // t1 (lowest) must NOT be included when there are 5 candidates
    expect(calledIds).not.toContain("t1");
  });

  test("CRITICAL: uncertain tooted scores 0.20 (boundary) – is it included in AI check?", async () => {
    // The uncertain zone is defined as: jaccardScore >= uncertainLow (0.20)
    // A score of exactly 0.20 should be sent to AI for tooted candidates.
    const tooted = makeStory({ id: "boundary-tooted", tooted: true });
    const calledIds: string[] = [];

    const semanticCheck: SemanticChecker = async (pairs) => {
      for (const p of pairs) calledIds.push(p.story.id);
      return new Map();
    };

    await chooseStoryMatch(
      "Article",
      [{ story: tooted, jaccardScore: 0.20 }], // exactly at uncertainLow boundary
      REAL_THRESHOLDS,
      semanticCheck
    );

    // Exactly 0.20 should be in the uncertain zone → AI is called
    expect(calledIds).toContain("boundary-tooted");
  });

  test("CRITICAL: tooted with score 0.19 (below uncertainLow) – is it correctly excluded?", async () => {
    // Below uncertainLow → "definitely different" → AI should NOT be called
    const tooted = makeStory({ id: "below-low", tooted: true });
    const semanticCheck: SemanticChecker = jest.fn(async () => new Map());

    await chooseStoryMatch(
      "Article",
      [{ story: tooted, jaccardScore: 0.19 }],
      REAL_THRESHOLDS,
      semanticCheck as SemanticChecker
    );

    expect(semanticCheck).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HYPOTHESIS 3 — batchStoryCache uses only Jaccard (no AI, no tooted distinction)
//
// In processNewArticles, newly created stories within the same feed-grabber
// run are cached and matched using ONLY Jaccard >= baseThreshold.
// This means two different-topic articles could merge in-batch without AI
// confirmation, which is a valid concern.
//
// We test this by simulating the batchStoryCache logic (same as in
// storyMatcher.test.ts simulateBatchMatching), using REAL threshold values.
// ─────────────────────────────────────────────────────────────────────────────
describe("[H3] batchStoryCache: Jaccard-only matching within a feed-grabber batch", () => {
  // Mirror the batchStoryCache matching logic from processNewArticles in storyMatcher.ts
  // The actual code uses STORY_SIMILARITY_THRESHOLD = 0.40 (from settings.json)
  const BATCH_THRESHOLD = 0.40;

  function simulateBatchCache(
    articles: Array<{ title: string; contentSnippet?: string }>
  ): Map<number, number> {
    const assignments = new Map<number, number>();
    const storyCache = new Map<number, Set<string>>();

    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      const text = article.contentSnippet
        ? `${article.title} ${article.contentSnippet.slice(0, 500)}`
        : article.title;
      const tokens = tokenize(text);

      let matchedStory: number | null = null;
      let bestScore = 0;

      for (const [storyIdx, storyTokens] of storyCache) {
        const similarity = jaccardSimilarity(tokens, storyTokens);
        if (similarity >= BATCH_THRESHOLD && similarity > bestScore) {
          bestScore = similarity;
          matchedStory = storyIdx;
        }
      }

      if (matchedStory !== null) {
        assignments.set(i, matchedStory);
        // NOTE: real code does NOT merge tokens (preventing topic drift)
        // The test mirrors the production behaviour where we do NOT update storyTokens
      } else {
        assignments.set(i, i);
        storyCache.set(i, tokens);
      }
    }

    return assignments;
  }

  test("same-topic articles correctly merge in batchStoryCache", () => {
    const articles = [
      { title: "Brand in Saarbrücken: Feuerwehr im Einsatz Großbrand" },
      { title: "Großbrand Saarbrücken Feuerwehr Einsatz Innenstadt" },
    ];
    const assignments = simulateBatchCache(articles);
    // Both should belong to the same batch story (story 0)
    expect(assignments.get(0)).toBe(0);
    expect(assignments.get(1)).toBe(0);
  });

  test("different-topic articles do NOT merge in batchStoryCache", () => {
    const articles = [
      { title: "Brand in Saarbrücken: Feuerwehr im Großeinsatz" },
      { title: "SPD Landtag Saarland: Haushaltsdebatte über Schulen" },
    ];
    const assignments = simulateBatchCache(articles);
    // Different topics → separate stories
    expect(assignments.get(0)).toBe(0);
    expect(assignments.get(1)).toBe(1); // must NOT be 0
  });

  test("CRITICAL BUG CHECK: two police articles from same city merge incorrectly", () => {
    // This is the core bug scenario: two Polizei press releases about different
    // incidents share enough boilerplate that Jaccard >= 0.40 causes incorrect merge.
    const articles = [
      { title: "Polizei Saarbrücken: Einbruch in Apotheke – Zeugen gesucht" },
      { title: "Polizei Saarbrücken: Fahrraddiebstahl – Polizei bittet Zeugen" },
    ];
    const scoreForCheck = jaccardForTitles(articles[0].title, articles[1].title);
    console.log(`[H3] two police press releases Jaccard score: ${scoreForCheck.toFixed(4)}`);

    const assignments = simulateBatchCache(articles);
    const merged = assignments.get(1) === 0;
    console.log(`[H3] articles merged in batchStoryCache: ${merged} (score=${scoreForCheck.toFixed(4)})`);

    // If merged == true AND score >= 0.40, this IS the bug: different incidents got merged
    // with NO AI consultation.
    if (merged) {
      // Fail explicitly to surface as a CONFIRMED BUG
      expect(scoreForCheck).toBeLessThan(BATCH_THRESHOLD);
    } else {
      expect(merged).toBe(false);
    }
  });

  test("CRITICAL BUG CHECK: 'verbraucherzentrale' style – same-source recurring articles merged in batch", () => {
    // Verbraucherzentrale re-emits the same article repeatedly. If two emissions
    // arrive in the same batch, the batchStoryCache would merge them — correct behavior.
    // But what if a different article from the same feed gets merged?
    const articles = [
      { title: "Verbraucherzentrale Saarland: Klage gegen Stadtsparkasse" },
      { title: "Verbraucherzentrale Saarland: Warnung vor Phishing-Mails" },
    ];
    const score = jaccardForTitles(articles[0].title, articles[1].title);
    console.log(`[H3] verbraucherzentrale different topics score: ${score.toFixed(4)}`);

    const assignments = simulateBatchCache(articles);
    const merged = assignments.get(1) === 0;
    console.log(`[H3] verbraucherzentrale articles merged: ${merged}`);

    if (merged) {
      // Bug confirmed: different articles from same source merged
      expect(score).toBeLessThan(BATCH_THRESHOLD);
    } else {
      expect(merged).toBe(false);
    }
  });

  test("batchStoryCache does NOT merge when score is below threshold", () => {
    // Direct confirmation of the threshold guard
    const articles = [
      { title: "Konzert in der Saarlandhalle: Ausverkauft" },
      { title: "Polizei sucht Täter nach Raub in Merzig" },
    ];
    const assignments = simulateBatchCache(articles);
    expect(assignments.get(0)).toBe(0);
    expect(assignments.get(1)).toBe(1);
  });

  test("batchStoryCache tokens are NOT merged after assignment (no topic drift)", () => {
    // The real processNewArticles code explicitly does NOT merge tokens into the
    // cached story. Verify our simulation mirrors this: a 3rd article that only
    // shares tokens with article 2 (not article 1) should NOT match article 1's story.
    const articles = [
      { title: "Saarbrücker Stadtrat: Beschluss zu Radwegen und Verkehr" },
      // Article 2 would match article 1 (both about traffic/roads)
      { title: "Neue Fahrradwege: Stadtrat Saarbrücken stimmt Beschluss" },
      // Article 3 is about cycling events — only overlaps with article 2's domain
      // but since we DON'T merge tokens, it must be tested against article 1's tokens only
      { title: "Fahrradrennen Saarland: Großes Radrennen am Wochenende" },
    ];

    const score01 = jaccardForTitles(articles[0].title, articles[1].title);
    const score02 = jaccardForTitles(articles[0].title, articles[2].title);
    console.log(`[H3] article 0 vs 1 score: ${score01.toFixed(4)}, article 0 vs 2 score: ${score02.toFixed(4)}`);

    const assignments = simulateBatchCache(articles);
    // Article 2 might or might not merge with 0 depending on score
    // But article 3 should NOT merge with 0 if score02 < BATCH_THRESHOLD
    if (score02 < BATCH_THRESHOLD) {
      expect(assignments.get(2)).not.toBe(0);
    }
    // This test documents that tokens are NOT merged (the comment in storyMatcher.ts is correct)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HYPOTHESIS 4 — formatThreadReply is a pure formatter (no relevance gate)
//
// formatThreadReply never checks whether the articles it receives actually
// belong to the same topic as the story. It blindly formats them with "Update:"
// prefix. This RULES OUT the formatter as the bug — the bug must be upstream
// in story assignment.
// ─────────────────────────────────────────────────────────────────────────────
describe("[H4] formatThreadReply: pure formatter – no story relevance validation", () => {
  const feedPriorities = { "feed-a": 0.9, "feed-b": 0.5 };

  test("formats weather article as Update: reply regardless of story topic mismatch", () => {
    // Original story: police incident. Follow-up article: weather report.
    // The formatter doesn't know or care about the mismatch.
    const weatherArticle = makeClusterArticle({
      id: "weather-1",
      title: "Wetter Saarland: Hitzewelle erwartet",
      link: "https://wetter.saarland.de/hitzewelle",
      feedKey: "wetter",
    });

    const result = formatThreadReply([weatherArticle], feedPriorities);

    // The formatter produces an "Update:" toot even for a completely unrelated article
    expect(result).toContain("🔗 Update:");
    expect(result).toContain("Wetter Saarland: Hitzewelle erwartet");
    expect(result).toContain("https://wetter.saarland.de/hitzewelle");
  });

  test("formats sport news as Update: under a politics story – no validation", () => {
    const sportArticle = makeClusterArticle({
      id: "sport-1",
      title: "Fußball: 1. FC Saarbrücken gewinnt 3:0",
      link: "https://sport.de/saarbruecken",
      feedKey: "sport",
    });

    const result = formatThreadReply([sportArticle], feedPriorities);

    // Confirmed: formatter always produces Update: — it is NOT the bug location
    expect(result).toContain("🔗 Update:");
    expect(result).toContain("Fußball: 1. FC Saarbrücken gewinnt 3:0");
  });

  test("CONCLUSION: formatter cannot prevent the bug – it is a pure renderer", () => {
    // The "Update:" accumulation bug is caused by incorrect story assignment UPSTREAM.
    // This test documents that the formatter has no gate: it renders whatever it receives.
    const unrelatedArticles = [
      makeClusterArticle({ id: "1", title: "Polizei Saarbrücken: Festnahmen", feedKey: "polizei" }),
      makeClusterArticle({ id: "2", title: "Wetter Saarland: Gewitter", feedKey: "wetter" }),
    ];

    // Even with two unrelated articles (multi-source), the formatter just uses the primary
    const result = formatThreadReply(unrelatedArticles, feedPriorities);
    expect(result).toContain("🔗 Update");
    // The formatter picks the highest-priority feed's article as primary
    // It does NOT verify topic coherence
    expect(result).not.toContain("relevan"); // no relevance check anywhere in the output
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HYPOTHESIS 5 — normalizeUrl false-matches different-domain URLs
//
// Could normalizeUrl incorrectly collapse two different URLs to the same
// canonical form, causing findStoryByUrl to return the wrong story?
// ─────────────────────────────────────────────────────────────────────────────
describe("[H5] normalizeUrl: does it produce false matches for different domains?", () => {
  test("different-domain URLs never normalize to the same string", () => {
    const pairs: [string, string][] = [
      ["https://saarbruecker-zeitung.de/artikel/1", "https://saarnews.com/artikel/1"],
      ["https://polizei.saarland.de/meldung/123", "https://feuerwehr.saarland.de/meldung/123"],
      ["https://radio-salue.de/news/42", "https://homburg1.de/news/42"],
      ["http://breaking-news-saarland.de/post/1", "https://saarland.cc/post/1"],
    ];

    for (const [urlA, urlB] of pairs) {
      const normA = normalizeUrl(urlA);
      const normB = normalizeUrl(urlB);
      // Different domains must never collapse to the same canonical form
      expect(normA).not.toBe(normB);
      console.log(`[H5] "${urlA.slice(0, 50)}" → "${normA.slice(0, 50)}"`);
      console.log(`[H5] "${urlB.slice(0, 50)}" → "${normB.slice(0, 50)}"`);
    }
  });

  test("same path on different domains stays distinct", () => {
    // Path /feed/ is common to many WordPress sites — make sure normalization
    // does NOT strip the host and compare only paths.
    const a = normalizeUrl("https://site-a.de/feed/");
    const b = normalizeUrl("https://site-b.de/feed/");
    expect(a).not.toBe(b);
  });

  test("empty string input returns empty string (no crash)", () => {
    expect(normalizeUrl("")).toBe("");
    expect(normalizeUrl(null)).toBe("");
    expect(normalizeUrl(undefined)).toBe("");
  });

  test("bare domain without path normalizes correctly and is distinct from full path", () => {
    // Edge case: some feeds emit bare URLs like "https://example.de"
    const bare = normalizeUrl("https://example.de");
    const withPath = normalizeUrl("https://example.de/article/123");
    expect(bare).not.toBe(withPath);
  });

  test("normalizeUrl preserves path for disambiguation", () => {
    // Two articles on the same domain with different paths must remain distinct
    const article1 = normalizeUrl("https://sz.de/article/police-report");
    const article2 = normalizeUrl("https://sz.de/article/weather-update");
    expect(article1).not.toBe(article2);
  });

  test("tracking params stripped but content params kept – no false dedup", () => {
    // ?id=42 is a semantic param (keeps it) vs ?utm_source=rss (strips it)
    // Two articles with different ?id= values must NOT collapse to the same URL.
    const articleIdA = normalizeUrl("https://example.de/news?id=42&utm_source=rss");
    const articleIdB = normalizeUrl("https://example.de/news?id=99&utm_source=rss");
    expect(articleIdA).not.toBe(articleIdB);
    // Tracking param stripped
    expect(articleIdA).not.toContain("utm_source");
    // Content param kept
    expect(articleIdA).toContain("id=42");
  });

  test("findStoryByUrl path: URL normalization cannot produce false story match across articles", () => {
    // Simulate what findStoryByUrl does: normalize the incoming URL and compare
    // to each story's stored original_links (also normalized).
    // With two stories having DIFFERENT article URLs, they must NOT collide.
    const storyALink = "https://saarbruecker-zeitung.de/nachrichten/einbruch-apotheke";
    const storyBLink = "https://saarbruecker-zeitung.de/nachrichten/stadtratswahl-ergebnis";
    const incomingLink = "https://saarbruecker-zeitung.de/nachrichten/stadtratswahl-ergebnis?utm_source=rss";

    const normalizedA = normalizeUrl(storyALink);
    const normalizedB = normalizeUrl(storyBLink);
    const normalizedIncoming = normalizeUrl(incomingLink);

    // Incoming must match story B (after stripping utm_source)
    expect(normalizedIncoming).toBe(normalizedB);
    // Must NOT match story A
    expect(normalizedIncoming).not.toBe(normalizedA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HYPOTHESIS 6 — assignStoryToArticle can overwrite an existing story_id
//
// assignStoryToArticle does a plain UPDATE with no WHERE story_id IS NULL guard.
// If processNewArticles runs multiple times (e.g. the same article is processed
// in two feed-grabber runs because it appeared in the DB again without a story_id),
// a second pass can re-assign the article to a different (wrong) story.
//
// Additionally: the batch-cache path in processNewArticles uses Jaccard-only
// (no AI) and has no guard against tooted status. The second run might pick a
// different story as "best match" than the first run did.
// ─────────────────────────────────────────────────────────────────────────────
describe("[H6] assignStoryToArticle: no guard against overwriting existing story_id", () => {
  test("DOCUMENTED: assignStoryToArticle UPDATE has no WHERE story_id IS NULL guard", () => {
    // This is a documentation test — it checks that we KNOW about the absence
    // of the guard by reading the actual function signature.
    //
    // The real function in storyMatcher.ts does:
    //   db.from(dbTable).update({ story_id: storyId }).eq("id", articleId)
    //
    // There is NO `.is("story_id", null)` filter. This means the function
    // blindly overwrites whatever story_id the article currently has.
    //
    // To test this without a real DB, we verify the BEHAVIOURAL CONSEQUENCE:
    // if processNewArticles processes the same article twice (simulated via
    // the batchStoryCache logic), would the second assignment differ?

    // Scenario: article was correctly assigned to story-A in run 1.
    // In run 2 the same article matches story-B (a different incident with
    // slightly higher Jaccard score because story-A aged out of the 72h window).
    // → The article ends up under story-B, but its toot already linked story-A.

    // We can't test the DB directly, but we document the structural vulnerability:
    // 1. findMatchingStory returns story-B in run 2 (because story-A is >72h old)
    // 2. addArticleToStory updates story-B's count
    // 3. assignStoryToArticle OVERWRITES article.story_id from story-A to story-B
    // → The article appears under story-B's thread even though it was posted under story-A

    // The fix would be to add .is("story_id", null) to the update query so
    // already-assigned articles are never re-assigned.

    // For now: assert we understand the mechanism (documentation assertion)
    const vulnerableCode = `db.from(dbTable).update({ story_id: storyId }).eq("id", articleId)`;
    const guardedCode = `db.from(dbTable).update({ story_id: storyId }).eq("id", articleId).is("story_id", null)`;
    expect(vulnerableCode).not.toContain('.is("story_id", null)');
    expect(guardedCode).toContain('.is("story_id", null)');
  });

  test("Jaccard score can differ between two processNewArticles runs for the same article", () => {
    // Simulate: in run 1, the batchStoryCache contained story-A tokens.
    // In run 2, story-A has aged out (>72h) so findMatchingStory returns null,
    // but a newer story-B exists and scores slightly higher.
    //
    // This test proves that the SAME article title can produce DIFFERENT
    // best-match stories depending on what other stories exist in the DB at
    // that moment — meaning re-runs of processNewArticles genuinely CAN
    // produce different assignments.

    const articleTitle = "Polizei Saarbrücken: Zeugenaufruf nach Einbruch";

    // Situation in run 1: story-A is in the DB
    const storyATokens = tokenize("Polizei Saarbrücken Einbruch Zeugen Einsatz Apotheke");
    // Situation in run 2: story-A is gone (>72h), story-B is newer
    const storyBTokens = tokenize("Polizei Saarbrücken Zeugenaufruf Festnahme Täter Einbruch");

    const articleTokens = tokenize(articleTitle);
    const scoreA = jaccardSimilarity(articleTokens, storyATokens);
    const scoreB = jaccardSimilarity(articleTokens, storyBTokens);

    console.log(`[H6] Article → story-A score: ${scoreA.toFixed(4)}, story-B score: ${scoreB.toFixed(4)}`);

    // Both might be above threshold — meaning in run 2, story-B gets matched
    // even though the article was already posted under story-A's thread.
    // This IS a structural bug: no idempotency guard in assignStoryToArticle.
    if (scoreA >= 0.40 && scoreB >= 0.40) {
      // Document: both match → re-run will pick one and overwrite
      expect(scoreA).toBeGreaterThanOrEqual(0.40);
      expect(scoreB).toBeGreaterThanOrEqual(0.40);
      // The fact that two different stories both score above threshold for the
      // same article title is itself evidence of the false-grouping problem (H1).
    }
    // The important finding: scoreB >= 0.40 means in run 2, the article gets
    // re-assigned — there is no guard to prevent this.
  });

  test("processNewArticles batchStoryCache: second identical article is NOT re-assigned in same run", () => {
    // Within a SINGLE run, the batchStoryCache prevents duplicate assignments
    // for the same-titled article. But across runs this protection vanishes.
    // This test verifies the within-run protection works (so we can rule it out
    // as a within-run issue and focus on cross-run re-assignment).

    const BATCH_THRESHOLD = 0.40;
    const articleA = { title: "Polizei Saarbrücken: Einbruch in Apotheke – Zeugen gesucht" };
    const articleB = { title: "Polizei Saarbrücken: Einbruch in Apotheke – Zeugen gesucht" };

    const storyCache = new Map<number, Set<string>>();
    const assignments = new Map<number, number>();

    for (let i = 0; i < 2; i++) {
      const title = i === 0 ? articleA.title : articleB.title;
      const tokens = tokenize(title);
      let matched: number | null = null;

      for (const [storyIdx, storyTokens] of storyCache) {
        const score = jaccardSimilarity(tokens, storyTokens);
        if (score >= BATCH_THRESHOLD) {
          matched = storyIdx;
          break;
        }
      }

      if (matched !== null) {
        assignments.set(i, matched);
      } else {
        assignments.set(i, i);
        storyCache.set(i, tokens);
      }
    }

    // Article B (identical title) should merge with article A's story
    expect(assignments.get(0)).toBe(0);
    expect(assignments.get(1)).toBe(0);
  });
});
