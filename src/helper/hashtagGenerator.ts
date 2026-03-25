import Anthropic from "@anthropic-ai/sdk";
import { hasAiBudget, logAiUsage } from "./costTracker.js";

/**
 * Topic keywords → hashtags mapping
 * Extends the TOPIC_EMOJIS pattern from engagementEnhancer.ts
 */
const TOPIC_HASHTAGS: { keywords: string[]; tags: string[] }[] = [
  { keywords: ["polizei", "festnahme", "ermittlung", "diebstahl", "einbruch", "kriminalität"], tags: ["Polizei"] },
  { keywords: ["unfall", "crash", "zusammenstoß", "verunglückt", "kollision"], tags: ["Unfall"] },
  { keywords: ["brand", "feuer", "brennt", "flammen", "feuerwehr"], tags: ["Feuer"] },
  { keywords: ["fahrrad", "radweg", "radverkehr", "radfahrer", "e-bike"], tags: ["Fahrrad"] },
  { keywords: ["wahl", "abstimmung", "landtag", "bundestag", "partei", "cdu", "spd", "grüne", "afd", "fdp"], tags: ["Politik"] },
  { keywords: ["veranstaltung", "festival", "konzert", "fest", "feier", "markt"], tags: ["Veranstaltung"] },
  { keywords: ["baustelle", "sperrung", "stau", "verkehr", "umleitung", "straße"], tags: ["Verkehr"] },
  { keywords: ["schule", "bildung", "uni", "universität", "studenten", "schüler", "kita"], tags: ["Bildung"] },
  { keywords: ["fußball", "1. fc", "fcs", "dfb", "bundesliga", "tor", "spiel"], tags: ["Fussball"] },
  { keywords: ["wetter", "sturm", "unwetter", "regen", "schnee", "gewitter", "hitze"], tags: ["Wetter"] },
  { keywords: ["wirtschaft", "unternehmen", "arbeitsplätze", "insolvenz", "jobs", "industrie"], tags: ["Wirtschaft"] },
  { keywords: ["kultur", "museum", "theater", "ausstellung", "kunst", "galerie"], tags: ["Kultur"] },
  { keywords: ["gesundheit", "krankenhaus", "klinik", "arzt", "pflege", "medizin"], tags: ["Gesundheit"] },
  { keywords: ["umwelt", "klima", "naturschutz", "energie", "solar", "windkraft"], tags: ["Umwelt"] },
  { keywords: ["sport", "turnier", "meisterschaft", "verein", "marathon", "handball"], tags: ["Sport"] },
];

/**
 * Location-based hashtags (Saarland cities/regions)
 * Uses ASCII-safe versions for hashtag compatibility
 */
const LOCATION_HASHTAGS: { keywords: string[]; tags: string[] }[] = [
  { keywords: ["saarbrücken", "saarbruecken"], tags: ["Saarbruecken"] },
  { keywords: ["homburg"], tags: ["Homburg"] },
  { keywords: ["neunkirchen"], tags: ["Neunkirchen"] },
  { keywords: ["völklingen", "voelklingen", "weltkulturerbe"], tags: ["Voelklingen"] },
  { keywords: ["st. ingbert", "st ingbert", "st.ingbert"], tags: ["StIngbert"] },
  { keywords: ["merzig"], tags: ["Merzig"] },
  { keywords: ["saarlouis"], tags: ["Saarlouis"] },
  { keywords: ["dillingen"], tags: ["Dillingen"] },
  { keywords: ["blieskastel"], tags: ["Blieskastel"] },
  { keywords: ["ottweiler"], tags: ["Ottweiler"] },
  { keywords: ["lebach"], tags: ["Lebach"] },
  { keywords: ["wadgassen"], tags: ["Wadgassen"] },
  { keywords: ["saarpfalz"], tags: ["Saarpfalz"] },
];

const AI_HASHTAG_PROMPT = `Du generierst Hashtags für einen Saarland-Nachrichtenbot auf Mastodon.

Regeln:
- Gib 1-2 relevante, deutschsprachige Hashtags zurück
- Nutze CamelCase (z.B. "StadtEntwicklung" statt "stadtentwicklung")
- Keine generischen Tags wie "News", "Nachrichten", "Aktuell"
- Keine Tags die schon in der Liste sind
- Nur relevante, spezifische Tags zum Thema

Bestehende Tags: {existingTags}

Antworte NUR mit JSON: {"tags": ["Tag1", "Tag2"]}
Falls keine sinnvollen Tags möglich: {"tags": []}`;

/**
 * Generate content-derived hashtags for a news article.
 * Uses rule-based matching first, AI fallback for unclear cases.
 *
 * @param title - Article title to analyze
 * @param baseHashtags - Base hashtags from settings (e.g., feed_hashtags)
 * @returns Array of hashtags (max 4, includes base tags + content-derived)
 */
export async function generateHashtags(
  title: string,
  baseHashtags: string[] = []
): Promise<string[]> {
  const MAX_HASHTAGS = 4;
  const hashtags: string[] = [...baseHashtags];
  const lowerTitle = title.toLowerCase();

  // 1. Match topic hashtags (collect up to 2)
  const topicMatches: string[] = [];
  for (const { keywords, tags } of TOPIC_HASHTAGS) {
    if (keywords.some((kw) => lowerTitle.includes(kw))) {
      for (const tag of tags) {
        if (!topicMatches.includes(tag)) {
          topicMatches.push(tag);
        }
      }
    }
    if (topicMatches.length >= 2) break;
  }
  hashtags.push(...topicMatches.slice(0, 2));

  // 2. Match location hashtags (add 1 if found)
  for (const { keywords, tags } of LOCATION_HASHTAGS) {
    if (keywords.some((kw) => lowerTitle.includes(kw))) {
      const locationTag = tags[0];
      if (!hashtags.includes(locationTag)) {
        hashtags.push(locationTag);
        break;
      }
    }
  }

  // 3. AI fallback if we have < 3 tags and budget available
  if (hashtags.length < 3) {
    const aiTags = await getAiHashtags(title, hashtags);
    for (const tag of aiTags) {
      if (!hashtags.includes(tag) && hashtags.length < MAX_HASHTAGS) {
        hashtags.push(tag);
      }
    }
  }

  // 4. Cap at MAX_HASHTAGS
  return hashtags.slice(0, MAX_HASHTAGS);
}

/**
 * Get AI-suggested hashtags using Claude Haiku.
 * Only called when rule-based matching doesn't find enough tags.
 */
async function getAiHashtags(
  title: string,
  existingTags: string[]
): Promise<string[]> {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return [];
  }

  try {
    if (!(await hasAiBudget())) {
      return [];
    }

    const client = new Anthropic({ apiKey });
    const prompt = AI_HASHTAG_PROMPT.replace("{existingTags}", existingTags.join(", "));

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      system: prompt,
      messages: [{ role: "user", content: `Artikel: "${title}"` }],
    });

    logAiUsage(
      "hashtag_generation",
      response.usage.input_tokens,
      response.usage.output_tokens
    );

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed.tags)) {
      // Clean and validate tags
      return parsed.tags
        .filter((tag: unknown): tag is string => typeof tag === "string")
        .map((tag: string) => tag.replace(/^#/, "").trim())
        .filter((tag: string) => tag.length > 0 && tag.length <= 30)
        .slice(0, 2);
    }

    return [];
  } catch (err) {
    console.error(`AI hashtag generation failed: ${err}`);
    return [];
  }
}

/**
 * Synchronous rule-based hashtag generation (no AI fallback).
 * Useful for thread replies where we want consistent, fast results.
 */
export function generateHashtagsSync(title: string, baseHashtags: string[] = []): string[] {
  const MAX_HASHTAGS = 4;
  const hashtags: string[] = [...baseHashtags];
  const lowerTitle = title.toLowerCase();

  // Match topic hashtags
  for (const { keywords, tags } of TOPIC_HASHTAGS) {
    if (keywords.some((kw) => lowerTitle.includes(kw))) {
      for (const tag of tags) {
        if (!hashtags.includes(tag) && hashtags.length < MAX_HASHTAGS) {
          hashtags.push(tag);
        }
      }
    }
    if (hashtags.length >= 3) break;
  }

  // Match location hashtags
  for (const { keywords, tags } of LOCATION_HASHTAGS) {
    if (keywords.some((kw) => lowerTitle.includes(kw))) {
      const locationTag = tags[0];
      if (!hashtags.includes(locationTag) && hashtags.length < MAX_HASHTAGS) {
        hashtags.push(locationTag);
        break;
      }
    }
  }

  return hashtags;
}
