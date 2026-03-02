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

const SYSTEM_PROMPT = `Du bist ein Assistent für eine Nachrichtenbot-Seite im Saarland.
Der Nutzer stellt eine Frage oder nennt ein Thema. Extrahiere 1-5 Suchbegriffe, die geeignet sind, passende Nachrichtenartikel in einer Datenbank zu finden.
Antworte ausschließlich mit einem JSON-Array von Strings, z.B. ["Suchbegriff1", "Suchbegriff2"].
Keine Erklärungen, nur das JSON-Array.`;

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

    const responseText =
      response.content[0].type === "text" ? response.content[0].text : "";
    const parsed = JSON.parse(responseText);

    if (
      !Array.isArray(parsed) ||
      !parsed.every((k) => typeof k === "string")
    ) {
      console.warn("questionAnswerer: invalid AI response format");
      return [];
    }

    return parsed;
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
