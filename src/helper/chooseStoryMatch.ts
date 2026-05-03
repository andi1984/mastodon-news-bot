import type { StoryRecord } from "./storyMatcher.js";

export type StoryCandidate = {
  story: StoryRecord;
  jaccardScore: number;
};

export type MatchThresholds = {
  baseThreshold: number;
  followUpThreshold: number;
  uncertainLow: number;
  semanticMatchThreshold: number;
};

export type SemanticChecker = (
  pairs: { story: StoryRecord; titleA: string; titleB: string }[]
) => Promise<Map<string, number>>;

export type MatchResult = {
  story: StoryRecord;
  reason: "token" | "semantic";
  score: number;
};

const MAX_AI_CANDIDATES = 3;

// Decide which story (if any) an article matches.
//
// The previous implementation early-returned on the first untooted definite
// match (jaccard >= baseThreshold) and never consulted AI for borderline tooted
// candidates. In production this caused follow-up articles to be attached to a
// new untooted "sibling" story instead of being threaded under the original
// tooted one - the bot stopped posting "Update" thread replies entirely.
//
// This selector ALWAYS sends uncertain tooted candidates through AI when their
// jaccard is between uncertainLow and followUpThreshold. An AI-confirmed tooted
// match is preferred over any untooted definite match because the tooted story
// is the canonical thread parent. False positives are still guarded: AI scores
// below semanticMatchThreshold drop the tooted candidate and we fall back to
// the untooted definite match.
export async function chooseStoryMatch(
  articleTitle: string,
  candidates: StoryCandidate[],
  thresholds: MatchThresholds,
  semanticCheck: SemanticChecker
): Promise<MatchResult | null> {
  if (candidates.length === 0) return null;

  let bestTootedDefinite: StoryCandidate | null = null;
  let bestUntootedDefinite: StoryCandidate | null = null;
  const uncertainTooted: StoryCandidate[] = [];
  const uncertainUntooted: StoryCandidate[] = [];

  for (const c of candidates) {
    const isTooted = c.story.tooted;
    const definiteThreshold = isTooted
      ? thresholds.followUpThreshold
      : thresholds.baseThreshold;

    if (c.jaccardScore >= definiteThreshold) {
      if (isTooted) {
        if (!bestTootedDefinite || c.jaccardScore > bestTootedDefinite.jaccardScore) {
          bestTootedDefinite = c;
        }
      } else {
        if (!bestUntootedDefinite || c.jaccardScore > bestUntootedDefinite.jaccardScore) {
          bestUntootedDefinite = c;
        }
      }
    } else if (c.jaccardScore >= thresholds.uncertainLow) {
      if (isTooted) uncertainTooted.push(c);
      else uncertainUntooted.push(c);
    }
  }

  // Tooted definite > everything else: it's the unambiguous thread parent.
  if (bestTootedDefinite) {
    return {
      story: bestTootedDefinite.story,
      reason: "token",
      score: bestTootedDefinite.jaccardScore,
    };
  }

  // Always try AI on borderline tooted candidates - even if an untooted definite
  // exists - so a borderline-jaccard parent thread isn't silently dropped in
  // favour of a sibling untooted story.
  if (uncertainTooted.length > 0) {
    uncertainTooted.sort((a, b) => b.jaccardScore - a.jaccardScore);
    const toCheck = uncertainTooted.slice(0, MAX_AI_CANDIDATES);
    const aiTooted = await runSemanticCheck(
      articleTitle,
      toCheck,
      semanticCheck,
      thresholds.semanticMatchThreshold
    );
    if (aiTooted) return aiTooted;
  }

  // No tooted match (definite or AI-confirmed) - fall back to untooted definite.
  if (bestUntootedDefinite) {
    return {
      story: bestUntootedDefinite.story,
      reason: "token",
      score: bestUntootedDefinite.jaccardScore,
    };
  }

  // Last resort: AI on uncertain untooted candidates.
  if (uncertainUntooted.length > 0) {
    uncertainUntooted.sort((a, b) => b.jaccardScore - a.jaccardScore);
    const toCheck = uncertainUntooted.slice(0, MAX_AI_CANDIDATES);
    const aiUntooted = await runSemanticCheck(
      articleTitle,
      toCheck,
      semanticCheck,
      thresholds.semanticMatchThreshold
    );
    if (aiUntooted) return aiUntooted;
  }

  return null;
}

async function runSemanticCheck(
  articleTitle: string,
  candidates: StoryCandidate[],
  semanticCheck: SemanticChecker,
  threshold: number
): Promise<MatchResult | null> {
  let scores: Map<string, number>;
  try {
    scores = await semanticCheck(
      candidates.map((c) => ({
        story: c.story,
        titleA: articleTitle,
        titleB: c.story.primary_title,
      }))
    );
  } catch {
    return null;
  }

  let best: { candidate: StoryCandidate; score: number } | null = null;
  for (const c of candidates) {
    const s = scores.get(c.story.id);
    if (typeof s === "number" && s >= threshold) {
      if (!best || s > best.score) best = { candidate: c, score: s };
    }
  }

  if (!best) return null;
  return {
    story: best.candidate.story,
    reason: "semantic",
    score: best.score,
  };
}
