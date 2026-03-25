import Anthropic from "@anthropic-ai/sdk";
import { hasAiBudget, logAiUsage } from "./costTracker.js";
import { parseAiJson } from "./parseAiJson.js";

/**
 * Topic emoji mapping - one subtle emoji prefix based on content category.
 * Keeps it professional, not spammy.
 */
const TOPIC_EMOJIS: { keywords: string[]; emoji: string }[] = [
  { keywords: ["brand", "feuer", "brennt", "flammen"], emoji: "🔥" },
  { keywords: ["polizei", "festnahme", "ermittlung", "diebstahl", "einbruch"], emoji: "🚔" },
  { keywords: ["unfall", "crash", "zusammenstoß", "verunglückt"], emoji: "⚠️" },
  { keywords: ["fahrrad", "radweg", "radverkehr", "radfahrer"], emoji: "🚲" },
  { keywords: ["veranstaltung", "festival", "konzert", "feier", "fest"], emoji: "🎉" },
  { keywords: ["wahl", "abstimmung", "landtag", "bundestag"], emoji: "🗳️" },
  { keywords: ["wetter", "sturm", "regen", "schnee", "unwetter"], emoji: "🌦️" },
  { keywords: ["fußball", "saarbrücken", "1. fc", "spiel", "tor"], emoji: "⚽" },
  { keywords: ["baustelle", "sperrung", "stau", "verkehr"], emoji: "🚧" },
  { keywords: ["schule", "bildung", "uni", "studenten"], emoji: "🎓" },
  { keywords: ["eilmeldung", "breaking"], emoji: "📰" },
];

/**
 * Get a topic-appropriate emoji for the article title.
 * Returns empty string if no clear match (to avoid forced emojis).
 */
export function getTopicEmoji(title: string): string {
  const lowerTitle = title.toLowerCase();

  for (const { keywords, emoji } of TOPIC_EMOJIS) {
    if (keywords.some((kw) => lowerTitle.includes(kw))) {
      return emoji;
    }
  }

  return "";
}

export interface PollSuggestion {
  question: string;
  options: string[];
  expiresInSeconds: number;
}

export interface EngagementAnalysis {
  isDebatable: boolean;
  poll?: PollSuggestion;
}

const POLL_SYSTEM_PROMPT = `Du analysierst Nachrichtenartikel für einen Saarland-News-Bot auf Mastodon.

Bestimme, ob der Artikel ein debattierbares Thema behandelt, bei dem eine Umfrage sinnvoll wäre.

Geeignete Themen für Umfragen:
- Politische Entscheidungen (z.B. Bauvorhaben, Gesetze)
- Gesellschaftliche Debatten
- Zukunftspläne für die Region
- Meinungsfragen zu lokalen Themen

NICHT geeignet:
- Unfälle, Verbrechen, Tragödien
- Reine Fakten-Nachrichten
- Veranstaltungsankündigungen
- Pressemitteilungen

Wenn geeignet, erstelle eine kurze, neutrale Umfragefrage mit 2-4 Antwortoptionen.
WICHTIG: Frage und Optionen MÜSSEN auf Deutsch sein!
Die Optionen sollten verschiedene Meinungen abdecken, nicht wertend sein.
Halte die Optionen kurz (max. 25 Zeichen).

Beispiel für gute Optionen:
- "Finde ich gut", "Bin dagegen", "Abwarten"
- "Ja, unbedingt", "Nein", "Mir egal"

Antworte NUR mit JSON:
{"debatable": true/false, "poll": {"q": "Frage auf Deutsch?", "opts": ["Option 1", "Option 2", ...]}}

Wenn nicht debattierbar: {"debatable": false}`;

/**
 * Analyze if an article topic is debatable and could benefit from a poll.
 * Uses AI sparingly - should only be called for top-scoring stories.
 */
export async function analyzeForPoll(
  title: string,
  feedKey?: string
): Promise<EngagementAnalysis> {
  // Skip certain feed types that are never debatable
  const skipFeeds = ["polizei", "blaulichtreport"];
  if (feedKey && skipFeeds.includes(feedKey)) {
    return { isDebatable: false };
  }

  // Quick keyword filter to avoid API calls for obvious non-debates
  const nonDebatableKeywords = [
    "unfall", "tot", "verstorben", "festnahme", "diebstahl",
    "brand", "feuer", "verletzt", "vermisst"
  ];
  const lowerTitle = title.toLowerCase();
  if (nonDebatableKeywords.some((kw) => lowerTitle.includes(kw))) {
    return { isDebatable: false };
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return { isDebatable: false };
  }

  try {
    if (!(await hasAiBudget())) {
      return { isDebatable: false };
    }

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: POLL_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Artikel: "${title}"` }],
    });

    logAiUsage(
      "poll_analysis",
      response.usage.input_tokens,
      response.usage.output_tokens
    );

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const parsed = parseAiJson<{ debatable?: boolean; poll?: { q?: string; opts?: string[] } }>(text);

    if (!parsed.debatable) {
      return { isDebatable: false };
    }

    // Validate poll structure
    if (
      parsed.poll?.q &&
      Array.isArray(parsed.poll.opts) &&
      parsed.poll.opts.length >= 2 &&
      parsed.poll.opts.length <= 4
    ) {
      return {
        isDebatable: true,
        poll: {
          question: parsed.poll.q,
          options: parsed.poll.opts.map((o: string) => o.slice(0, 50)), // Mastodon limit
          expiresInSeconds: 24 * 60 * 60, // 24 hours
        },
      };
    }

    return { isDebatable: true };
  } catch (err) {
    console.error(`Poll analysis failed: ${err}`);
    return { isDebatable: false };
  }
}
