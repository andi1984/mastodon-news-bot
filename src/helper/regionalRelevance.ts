import Anthropic from "@anthropic-ai/sdk";
import { RegionalRelevanceSettings } from "../types/settings.js";
import { hasAiBudget, logAiUsage } from "./costTracker.js";

type RelevanceCategory = "local" | "regional" | "national" | "international";

export interface ArticleInput {
  title: string;
  feedKey?: string;
}

const SYSTEM_PROMPT = `Du bist ein Klassifikator für regionale Nachrichtenrelevanz im Saarland.
Ordne jeden Artikel einer Kategorie zu:
- "local": Direkter Bezug zum Saarland (Orte, Personen, Institutionen im Saarland)
- "regional": Bezug zur Großregion SaarLorLux / Grenzregion (Luxemburg, Lothringen, Westpfalz, Trier)
- "national": Deutsche Nachrichten ohne spezifischen Saarland-Bezug
- "international": Weltnachrichten ohne Saarland-Bezug

Antworte ausschließlich mit einem JSON-Array: [{"i":0,"c":"local"},...]
Keine Erklärungen, nur JSON.`;

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
  const toClassify: { index: number; title: string }[] = [];

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    if (a.feedKey && alwaysLocal.has(a.feedKey)) {
      result.set(i, categoryToMultiplier("local", config));
    } else {
      toClassify.push({ index: i, title: a.title });
    }
  }

  if (toClassify.length === 0) {
    return result;
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    console.warn(
      "Regional relevance: CLAUDE_API_KEY not set, using neutral multipliers"
    );
    for (const item of toClassify) {
      result.set(item.index, 1.0);
    }
    return result;
  }

  try {
    if (!(await hasAiBudget())) {
      console.warn(
        "Regional relevance: daily AI budget exceeded, using neutral multipliers"
      );
      for (const item of toClassify) {
        result.set(item.index, 1.0);
      }
      return result;
    }

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(toClassify) }],
    });

    logAiUsage(
      "regional_relevance",
      response.usage.input_tokens,
      response.usage.output_tokens
    );

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const parsed: { i: number; c: RelevanceCategory }[] = JSON.parse(text);

    const counts: Record<string, number> = {
      local: 0,
      regional: 0,
      national: 0,
      international: 0,
    };

    for (const entry of parsed) {
      const multiplier = categoryToMultiplier(entry.c, config);
      result.set(entry.i, multiplier);
      if (entry.c in counts) counts[entry.c]++;
    }

    // Fill any missing indices with neutral multiplier
    for (const item of toClassify) {
      if (!result.has(item.index)) {
        result.set(item.index, 1.0);
      }
    }

    // Count always-local articles
    const alwaysLocalCount = articles.length - toClassify.length;
    counts.local += alwaysLocalCount;

    console.log(
      `Regional relevance scored ${articles.length} articles: ${counts.local} local, ${counts.regional} regional, ${counts.national} national, ${counts.international} international`
    );
  } catch (err) {
    console.error(
      `Regional relevance API call failed, using neutral multipliers: ${err}`
    );
    for (const item of toClassify) {
      result.set(item.index, 1.0);
    }
  }

  return result;
}
