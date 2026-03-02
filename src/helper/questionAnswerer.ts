import Anthropic from "@anthropic-ai/sdk";
import createClient from "./db.js";
import { hasAiBudget, logAiUsage } from "./costTracker.js";

export interface QASettings {
  db_table: string;
  qa_max_results?: number;
  qa_min_text_length?: number;
  qa_no_results_text?: string;
  qa_header_text?: string;
}

const SYSTEM_PROMPT = `Du bist ein Assistent für einen Nachrichtenbot im Saarland.
Der Nutzer stellt eine Frage oder nennt ein Thema. Generiere Suchbegriffe für eine SQL-ILIKE-Datenbanksuche (Muster: %Begriff%).

Antworte mit einem JSON-Objekt:
{
  "keywords": ["..."],
  "variants": ["..."]
}

keywords (1-5): Hauptbegriffe in kürzester sinnvoller Stammform.
Da ILIKE mit %...% sucht, matcht "%Radweg%" bereits "Radwege", "Radwegen" usw.
Nutze daher immer die kürzeste Form, die noch eindeutig ist.

variants (0-10): Zusätzliche Formen, die NICHT bereits durch %keyword% als Teilstring abgedeckt sind:
- Plurale mit Umlaut: "Unfall" wird zu keyword, aber "Unfälle" als variant (ä ist nicht in "Unfall")
- Plurale mit Stammänderung: "Kind"→"Kinder", "Haus"→"Häuser"
- Komposita-Teile: "Straßenbau"→"Straße","Bau"
- Umlaut-Alternativen: "Straße"→"Strasse", "über"→"ueber"
- Synonyme/Abkürzungen: "Universität"→"Uni", "Kfz"→"Auto"
- Ableitungen: "Saarbrücken"→"Saarbrücker"

Nur das JSON-Objekt ausgeben. Keine Erklärungen.`;

export function sanitizeHtml(html: string): string {
  let text = html.replace(/<[^>]*>/g, "");
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  text = text.replace(/@\S+/g, "");
  return text.trim();
}

function escapeIlike(keyword: string): string {
  return keyword
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

export async function extractKeywords(text: string): Promise<string[]> {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    console.warn("questionAnswerer: CLAUDE_API_KEY not set");
    return [];
  }

  try {
    if (!(await hasAiBudget())) {
      console.warn("questionAnswerer: daily AI budget exceeded");
      return [];
    }

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    });

    logAiUsage(
      "question_answerer",
      response.usage.input_tokens,
      response.usage.output_tokens
    );

    let responseText =
      response.content[0].type === "text" ? response.content[0].text : "";
    // Strip markdown code fences if present (e.g. ```json ... ```)
    responseText = responseText
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(responseText);

    // Handle structured format: { keywords: [...], variants: [...] }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const keywords = Array.isArray(parsed.keywords)
        ? parsed.keywords.filter((k: unknown) => typeof k === "string")
        : [];
      const variants = Array.isArray(parsed.variants)
        ? parsed.variants.filter((v: unknown) => typeof v === "string")
        : [];
      const allTerms = [...new Set([...keywords, ...variants])];
      if (allTerms.length === 0) {
        console.warn("questionAnswerer: AI returned empty search terms");
        return [];
      }
      return allTerms.slice(0, 15);
    }

    // Backwards compatibility: plain array format
    if (
      Array.isArray(parsed) &&
      parsed.every((k) => typeof k === "string")
    ) {
      return parsed;
    }

    console.warn("questionAnswerer: invalid AI response format");
    return [];
  } catch (err) {
    console.error(`questionAnswerer: keyword extraction failed: ${err}`);
    return [];
  }
}

export async function searchArticles(
  keywords: string[],
  settings: QASettings
): Promise<{ title: string; url: string }[]> {
  const maxResults = settings.qa_max_results ?? 5;
  const dbTable = settings.db_table ?? "news";

  const supabase = createClient();

  const filters = keywords.flatMap((kw) => {
    const escaped = escapeIlike(kw);
    return [
      `data->>title.ilike.%${escaped}%`,
      `data->>content.ilike.%${escaped}%`,
    ];
  });

  const { data, error } = await supabase
    .from(dbTable)
    .select("data")
    .or(filters.join(","))
    .order("pub_date", { ascending: false })
    .limit(maxResults);

  if (error) {
    console.error(`questionAnswerer: DB query failed: ${error.message}`);
    return [];
  }

  if (!data || data.length === 0) {
    return [];
  }

  return data.map((row: any) => ({
    title: row.data?.title ?? "Ohne Titel",
    url: row.data?.link ?? row.data?.url ?? "",
  }));
}

export function formatReply(
  userAcct: string,
  articles: { title: string; url: string }[],
  settings: QASettings
): string {
  const noResultsText =
    settings.qa_no_results_text ??
    "Leider habe ich dazu keine passenden Nachrichten gefunden.";
  const headerText =
    settings.qa_header_text ?? "Hier sind passende Nachrichten:";

  const prefix = `@${userAcct} `;

  if (articles.length === 0) {
    return `${prefix}${noResultsText}`;
  }

  let reply = `${prefix}${headerText}\n`;

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const line = `\n${i + 1}. ${article.title}\n${article.url}`;

    if (reply.length + line.length > 500) {
      break;
    }
    reply += line;
  }

  return reply;
}

export async function answerQuestion(
  userAcct: string,
  htmlContent: string,
  settings: QASettings
): Promise<string> {
  const minLength = settings.qa_min_text_length ?? 10;
  const noResultsText =
    settings.qa_no_results_text ??
    "Leider habe ich dazu keine passenden Nachrichten gefunden.";

  const text = sanitizeHtml(htmlContent);

  if (text.length < minLength) {
    return `@${userAcct} ${noResultsText}`;
  }

  const keywords = await extractKeywords(text);

  if (keywords.length === 0) {
    return `@${userAcct} ${noResultsText}`;
  }

  const articles = await searchArticles(keywords, settings);
  return formatReply(userAcct, articles, settings);
}
