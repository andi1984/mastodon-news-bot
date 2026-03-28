import Anthropic from "@anthropic-ai/sdk";
import { hasAiBudgetForSource, logAiUsage } from "./costTracker.js";
import { parseAiJson } from "./parseAiJson.js";

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

const BATCH_SYSTEM_PROMPT = `Du entscheidest ob zwei Nachrichtenartikel über DASSELBE SPEZIFISCHE EREIGNIS berichten.

WICHTIG: Zwei Artikel gehören NUR zusammen wenn sie über EXAKT DASSELBE berichten:
- Selber Vorfall (gleicher Brand, gleicher Unfall, gleiche Ankündigung)
- Selber Ort UND selbes Thema
- Gleiche handelnde Personen im gleichen Kontext

GLEICHE GESCHICHTE (score 0.85-1.0):
✓ "Feuer zerstört Lagerhalle Homburg" + "Brand in Homburger Lagerhalle" = 0.9
✓ "Anke Rehlinger kündigt Wirtschaftsplan an" + "Ministerpräsidentin stellt Maßnahmen vor" = 0.85
✓ "Unfall A1 Saarbrücken 3 Verletzte" + "A1: Schwerer Unfall bei Saarbrücken" = 0.9

VERSCHIEDENE GESCHICHTEN (score 0.0-0.3):
✗ Zwei verschiedene Brände (anderer Ort) = 0.2
✗ Zwei verschiedene Unfälle (anderer Ort/Tag) = 0.2
✗ Wirtschaftsnachrichten + Feuerwehreinsatz = 0.0
✗ Zugverkehr + Hausbrand = 0.0
✗ Politik + Kriminalität = 0.1
✗ Gleicher Ort aber anderes Thema = 0.1

NIEMALS zusammenführen:
- Artikel über komplett unterschiedliche Themen
- Artikel die nur den Ort gemeinsam haben
- Artikel über ähnliche aber SEPARATE Ereignisse

Im Zweifel: Score unter 0.3 vergeben!

Antworte NUR mit JSON-Array: [{"a":0,"b":1,"s":0.85},...]`;

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
    if (!(await hasAiBudgetForSource("semantic_similarity"))) {
      console.log("Semantic similarity: AI budget threshold reached, skipping");
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
    const parsed = parseAiJson<{ a: number; b: number; s: number }[]>(text);

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
