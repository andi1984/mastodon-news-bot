import Anthropic from "@anthropic-ai/sdk";
import { hasAiBudgetForSource, logAiUsage } from "./costTracker.js";
import { parseAiJson } from "./parseAiJson.js";
import {
  getCachedSemanticScores,
  setCachedSemanticScores,
  _pairKeyForTesting as pairKey,
} from "./aiCache.js";

export interface SemanticPair {
  indexA: number;
  indexB: number;
  titleA: string;
  titleB: string;
}

export interface SemanticResult {
  indexA: number;
  indexB: number;
  score: number;
}

const BATCH_SYSTEM_PROMPT = `Bewerte ob zwei Nachrichten DASSELBE spezifische Ereignis beschreiben.
Gleiches Ereignis (0.85-1.0): selber Vorfall, selber Ort UND Thema, gleiche Personen im gleichen Kontext.
Verschiedene Ereignisse (0.0-0.3): anderer Ort, anderes Thema, oder nur Ort gemeinsam.
Im Zweifel unter 0.3.

Nur JSON-Array: [{"a":0,"b":1,"s":0.85},...]`;

/**
 * Batch semantic similarity comparison using Claude.
 * Returns similarity scores for article pairs.
 * Falls back to empty array if budget exceeded or API fails.
 */
export async function batchSemanticSimilarity(
  pairs: SemanticPair[]
): Promise<SemanticResult[]> {
  if (pairs.length === 0) {
    return [];
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    console.log("Semantic similarity: CLAUDE_API_KEY not set, skipping");
    return [];
  }

  try {
    // DB cache: skip pairs we've already scored previously.
    const cachedScores = await getCachedSemanticScores(pairs);
    const results: SemanticResult[] = [];
    const uncachedPairs: SemanticPair[] = [];
    for (const p of pairs) {
      const hit = cachedScores.get(pairKey(p.titleA, p.titleB));
      if (typeof hit === "number") {
        results.push({
          indexA: p.indexA,
          indexB: p.indexB,
          score: Math.max(0, Math.min(1, hit)),
        });
      } else {
        uncachedPairs.push(p);
      }
    }
    if (cachedScores.size > 0) {
      console.log(
        `Semantic similarity: ${cachedScores.size}/${pairs.length} cache hits, ${uncachedPairs.length} to score`
      );
    }
    if (uncachedPairs.length === 0) {
      return results;
    }

    if (!(await hasAiBudgetForSource("semantic_similarity"))) {
      console.log("Semantic similarity: AI budget threshold reached, skipping");
      return results;
    }

    // Build prompt with numbered pairs (indices into uncachedPairs)
    const pairLines = uncachedPairs.map(
      (p, i) => `${i}: "${p.titleA}" vs "${p.titleB}"`
    );
    const userPrompt = `Bewerte diese ${uncachedPairs.length} Artikelpaare:\n${pairLines.join("\n")}`;

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: Math.min(uncachedPairs.length * 20 + 50, 1024),
      system: BATCH_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    logAiUsage(
      "semantic_similarity",
      response.usage.input_tokens,
      response.usage.output_tokens
    );

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Parse JSON response
    const parsed = parseAiJson<{ a: number; b: number; s: number }[]>(text);

    // Map back to original indices and collect for cache persist
    const toCache: { titleA: string; titleB: string; score: number }[] = [];
    for (const entry of parsed) {
      const pairIndex = entry.a; // Index in uncachedPairs array
      if (pairIndex >= 0 && pairIndex < uncachedPairs.length) {
        const clamped = Math.max(0, Math.min(1, entry.s));
        const p = uncachedPairs[pairIndex];
        results.push({
          indexA: p.indexA,
          indexB: p.indexB,
          score: clamped,
        });
        toCache.push({ titleA: p.titleA, titleB: p.titleB, score: clamped });
      }
    }

    await setCachedSemanticScores(toCache);

    console.log(
      `Semantic similarity: scored ${results.length}/${pairs.length} pairs (fresh=${toCache.length}, cached=${cachedScores.size})`
    );
    return results;
  } catch (err) {
    console.error(`Semantic similarity API call failed: ${err}`);
    return [];
  }
}

/**
 * Single-pair semantic similarity check.
 * Returns score between 0-1, or null if unavailable.
 */
export async function semanticSimilarity(
  titleA: string,
  titleB: string
): Promise<number | null> {
  const results = await batchSemanticSimilarity([
    { indexA: 0, indexB: 1, titleA, titleB },
  ]);

  if (results.length > 0) {
    return results[0].score;
  }
  return null;
}
