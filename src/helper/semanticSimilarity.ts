import Anthropic from "@anthropic-ai/sdk";
import { hasAiBudget, logAiUsage } from "./costTracker.js";

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

const BATCH_SYSTEM_PROMPT = `Du vergleichst Nachrichtenartikel-Paare und bewertest, wie ähnlich sie thematisch sind.

Gleiche Geschichte (score 0.8-1.0): Selbes Ereignis, selber Ort, selbe Personen
- "Feuer zerstört Lagerhalle" und "Brand in Lagerhalle" = 0.9 (Synonyme)
- "Ministerpräsidentin kündigt Plan an" und "Anke Rehlinger stellt Maßnahmen vor" = 0.85 (selbe Person)

Verwandte Geschichte (score 0.4-0.7): Ähnliches Thema aber anderes Ereignis
- Zwei verschiedene Unfälle am selben Tag = 0.5

Verschiedene Geschichte (score 0.0-0.3): Komplett andere Themen oder Orte

Antworte NUR mit JSON-Array: [{"a":0,"b":1,"s":0.85},...]
Keine Erklärung, nur JSON.`;

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
    if (!(await hasAiBudget())) {
      console.log("Semantic similarity: daily AI budget exceeded, skipping");
      return [];
    }

    // Build prompt with numbered pairs
    const pairLines = pairs.map(
      (p, i) => `${i}: "${p.titleA}" vs "${p.titleB}"`
    );
    const userPrompt = `Bewerte diese ${pairs.length} Artikelpaare:\n${pairLines.join("\n")}`;

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: Math.min(pairs.length * 20 + 50, 1024),
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
    const parsed: { a: number; b: number; s: number }[] = JSON.parse(text);

    // Map back to original indices
    const results: SemanticResult[] = [];
    for (const entry of parsed) {
      const pairIndex = entry.a; // Index in our pairs array
      if (pairIndex >= 0 && pairIndex < pairs.length) {
        results.push({
          indexA: pairs[pairIndex].indexA,
          indexB: pairs[pairIndex].indexB,
          score: Math.max(0, Math.min(1, entry.s)), // Clamp to [0,1]
        });
      }
    }

    console.log(
      `Semantic similarity: scored ${results.length}/${pairs.length} pairs`
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
