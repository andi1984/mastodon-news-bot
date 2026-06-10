import Anthropic from "@anthropic-ai/sdk";
import { RegionalRelevanceSettings } from "../types/settings.js";
import { hasAiBudgetForSource, logAiUsage } from "./costTracker.js";
import { parseAiJson } from "./parseAiJson.js";
import {
  getCachedRegionalCategories,
  setCachedRegionalCategories,
  type RelevanceCategory,
} from "./aiCache.js";

let _anthropicClient: Anthropic | null = null;
function getAnthropicClient(apiKey: string): Anthropic {
  if (!_anthropicClient) _anthropicClient = new Anthropic({ apiKey });
  return _anthropicClient;
}

export interface ArticleInput {
  title: string;
  feedKey?: string;
}

const SYSTEM_PROMPT = `Klassifiziere Saarland-Nachrichten:
- local: Saarland-Bezug
- regional: SaarLorLux-Grenzregion (Luxemburg, Lothringen, Westpfalz, Trier)
- national: DE ohne Saarland
- international: Welt ohne Saarland

Nur JSON-Array: [{"i":0,"c":"local"},...]`;

// Max titles per API call. Output budget is sized per chunk; oversized
// batches previously hit max_tokens, truncated the JSON, and re-billed the
// same titles on every run because nothing reached the cache.
const AI_CHUNK_SIZE = 25;
// Worst-case output tokens per array entry ("{\"i\":123,\"c\":\"international\"},").
const OUTPUT_TOKENS_PER_ENTRY = 16;

function titleMatchesLocalKeyword(title: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const lower = title.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

function buildUserPrompt(articles: { index: number; title: string }[]): string {
  const lines = articles.map((a) => `${a.index}: ${a.title}`);
  return `Klassifiziere diese Artikel:\n${lines.join("\n")}`;
}

function categoryToMultiplier(
  category: RelevanceCategory,
  config: RegionalRelevanceSettings
): number {
  return config.multipliers[category] ?? 1.0;
}

export async function scoreRegionalRelevance(
  articles: ArticleInput[],
  config: RegionalRelevanceSettings
): Promise<Map<number, number>> {
  const result = new Map<number, number>();

  if (!config.enabled || articles.length === 0) {
    for (let i = 0; i < articles.length; i++) {
      result.set(i, 1.0);
    }
    return result;
  }

  const alwaysLocal = new Set(config.always_local_feeds ?? []);
  const localKeywords = config.local_keywords ?? [];
  const toClassify: { index: number; title: string }[] = [];
  let keywordLocalCount = 0;

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    if (a.feedKey && alwaysLocal.has(a.feedKey)) {
      result.set(i, categoryToMultiplier("local", config));
    } else if (titleMatchesLocalKeyword(a.title, localKeywords)) {
      // Free programmatic classification: a Saarland place name in the title
      // means "local" - no need to pay Claude to confirm that.
      result.set(i, categoryToMultiplier("local", config));
      keywordLocalCount++;
    } else {
      toClassify.push({ index: i, title: a.title });
    }
  }

  if (keywordLocalCount > 0) {
    console.log(
      `Regional relevance: ${keywordLocalCount} articles classified local via keyword match (no AI)`
    );
  }

  if (toClassify.length === 0) {
    return result;
  }

  // DB cache: skip articles we've already classified in a previous run.
  const cached = await getCachedRegionalCategories(toClassify.map((t) => t.title));
  const stillToClassify: { index: number; title: string }[] = [];
  for (const item of toClassify) {
    const hit = cached.get(item.title);
    if (hit) {
      result.set(item.index, categoryToMultiplier(hit, config));
    } else {
      stillToClassify.push(item);
    }
  }
  if (cached.size > 0) {
    console.log(
      `Regional relevance: ${cached.size}/${toClassify.length} cache hits, ${stillToClassify.length} to classify`
    );
  }
  if (stillToClassify.length === 0) {
    return result;
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    console.warn(
      "Regional relevance: CLAUDE_API_KEY not set, using neutral multipliers"
    );
    for (const item of stillToClassify) {
      result.set(item.index, 1.0);
    }
    return result;
  }

  const counts: Record<string, number> = {
    local: 0,
    regional: 0,
    national: 0,
    international: 0,
  };
  const client = getAnthropicClient(apiKey);
  const indexToTitle = new Map(stillToClassify.map((t) => [t.index, t.title]));

  for (let start = 0; start < stillToClassify.length; start += AI_CHUNK_SIZE) {
    const chunk = stillToClassify.slice(start, start + AI_CHUNK_SIZE);
    try {
      // Re-check between chunks so a long backlog can't blow past the limit.
      if (!(await hasAiBudgetForSource("regional_relevance"))) {
        console.warn(
          "Regional relevance: AI budget threshold reached, using neutral multipliers for remaining articles"
        );
        break;
      }

      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: chunk.length * OUTPUT_TOKENS_PER_ENTRY + 64,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(chunk) }],
      });

      await logAiUsage(
        "regional_relevance",
        response.usage.input_tokens,
        response.usage.output_tokens
      );

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";
      const parsed = parseAiJson<{ i: number; c: RelevanceCategory }[]>(text);

      const toCache: { title: string; category: RelevanceCategory }[] = [];
      for (const entry of parsed) {
        const multiplier = categoryToMultiplier(entry.c, config);
        result.set(entry.i, multiplier);
        if (entry.c in counts) counts[entry.c]++;
        const title = indexToTitle.get(entry.i);
        if (title) toCache.push({ title, category: entry.c });
      }

      // Persist fresh classifications so future runs hit the cache.
      await setCachedRegionalCategories(toCache);
    } catch (err) {
      console.error(
        `Regional relevance API call failed, using neutral multipliers: ${err}`
      );
    }
  }

  // Fill any missing indices with neutral multiplier
  for (const item of stillToClassify) {
    if (!result.has(item.index)) {
      result.set(item.index, 1.0);
    }
  }

  // Count always-local and keyword-local articles
  counts.local += articles.length - toClassify.length;

  console.log(
    `Regional relevance scored ${articles.length} articles: ${counts.local} local, ${counts.regional} regional, ${counts.national} national, ${counts.international} international`
  );

  return result;
}
