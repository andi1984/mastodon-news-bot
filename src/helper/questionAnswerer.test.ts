import { jest, describe, it, expect, beforeEach, afterEach, beforeAll } from "@jest/globals";

// Reset modules and set up mocks before importing
beforeAll(() => {
  jest.resetModules();
});

const mockMessagesCreate = jest.fn();
const MockedAnthropic = jest.fn(() => ({
  messages: { create: mockMessagesCreate },
}));

const mockHasAiBudgetForSource = jest.fn();
const mockLogAiUsage = jest.fn();

const mockDbFrom = jest.fn();
const mockDbClient = { from: mockDbFrom };

jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: MockedAnthropic,
}));

jest.unstable_mockModule("./db", () => ({
  default: jest.fn(() => mockDbClient),
}));

jest.unstable_mockModule("./costTracker", () => ({
  hasAiBudgetForSource: mockHasAiBudgetForSource,
  logAiUsage: mockLogAiUsage,
}));

const {
  sanitizeHtml,
  extractKeywords,
  searchArticles,
  formatReply,
  answerQuestion,
} = await import("./questionAnswerer.js");
import type { QASettings } from "./questionAnswerer.js";

const defaultSettings: QASettings = {
  db_table: "news",
  qa_max_results: 5,
  qa_min_text_length: 10,
  qa_no_results_text:
    "Leider habe ich dazu keine passenden Nachrichten gefunden. Versuch es gerne mit anderen Suchbegriffen!",
  qa_header_text: "Hier sind passende Nachrichten:",
};

function mockAiResponse(text: string) {
  mockMessagesCreate.mockResolvedValue({
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 50 },
  });
}

function mockDb(data: any[] | null, error: any = null) {
  const mockLimit = jest.fn().mockResolvedValue({ data, error });
  const mockOrder = jest.fn().mockReturnValue({ limit: mockLimit });
  const mockTextSearch = jest.fn().mockReturnValue({ order: mockOrder });
  const mockSelect = jest.fn().mockReturnValue({ textSearch: mockTextSearch });
  mockDbFrom.mockReturnValue({ select: mockSelect });
}

describe("sanitizeHtml", () => {
  it("strips HTML tags", () => {
    expect(sanitizeHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("decodes HTML entities", () => {
    expect(sanitizeHtml("&amp; &lt; &gt; &quot; &#39; &nbsp;")).toBe(
      '& < > " \''
    );
  });

  it("removes @mentions", () => {
    expect(sanitizeHtml("@saarlandnews Gibt es Neuigkeiten?")).toBe(
      "Gibt es Neuigkeiten?"
    );
  });

  it("handles combined HTML + mentions", () => {
    expect(
      sanitizeHtml(
        '<p><span class="mention">@saarlandnews</span> Was gibt es Neues zum Radweg?</p>'
      )
    ).toBe("Was gibt es Neues zum Radweg?");
  });
});

describe("extractKeywords", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CLAUDE_API_KEY: "test-key" };
    mockHasAiBudgetForSource.mockResolvedValue(true);
    mockLogAiUsage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("extracts keywords from structured AI response", async () => {
    mockAiResponse(
      JSON.stringify({
        keywords: ["Radweg", "Saarbrücken"],
        variants: ["Saarbrücker"],
      })
    );

    const result = await extractKeywords("Was gibt es Neues zum Radweg?");

    expect(result).toEqual(["Radweg", "Saarbrücken", "Saarbrücker"]);
  });

  it("deduplicates keywords and variants", async () => {
    mockAiResponse(
      JSON.stringify({
        keywords: ["Unfall"],
        variants: ["Unfall", "Unfälle"],
      })
    );

    const result = await extractKeywords("Gab es einen Unfall?");

    expect(result).toEqual(["Unfall", "Unfälle"]);
  });

  it("still handles plain array format (backwards compat)", async () => {
    mockAiResponse(JSON.stringify(["Radweg", "Saarbrücken"]));

    const result = await extractKeywords("Was gibt es Neues zum Radweg?");

    expect(result).toEqual(["Radweg", "Saarbrücken"]);
  });

  it("returns empty array when API key is missing", async () => {
    delete process.env.CLAUDE_API_KEY;
    MockedAnthropic.mockClear();

    const result = await extractKeywords("Radweg");

    expect(result).toEqual([]);
  });

  it("returns empty array when AI budget is exceeded", async () => {
    mockHasAiBudgetForSource.mockResolvedValue(false);
    MockedAnthropic.mockClear();

    const result = await extractKeywords("Was gibt es Neues zum Radweg?");

    expect(result).toEqual([]);
  });
});

describe("searchArticles", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns articles from database", async () => {
    mockDb([
      {
        data: {
          title: "Neuer Radweg in Saarbrücken",
          link: "https://example.com/1",
        },
      },
      { data: { title: "Radweg-Debatte", link: "https://example.com/2" } },
    ]);

    const result = await searchArticles(["Radweg"], defaultSettings);

    expect(result).toEqual([
      { title: "Neuer Radweg in Saarbrücken", url: "https://example.com/1" },
      { title: "Radweg-Debatte", url: "https://example.com/2" },
    ]);
  });

  it("returns empty array on DB error", async () => {
    mockDb(null, { message: "DB error" });

    const result = await searchArticles(["Radweg"], defaultSettings);

    expect(result).toEqual([]);
  });

  it("returns empty array when no results", async () => {
    mockDb([]);

    const result = await searchArticles(["nonexistent"], defaultSettings);

    expect(result).toEqual([]);
  });
});

describe("formatReply", () => {
  it("formats reply with articles", () => {
    const articles = [
      { title: "Neuer Radweg", url: "https://example.com/1" },
      { title: "Radweg-Debatte", url: "https://example.com/2" },
    ];

    const reply = formatReply("user@example.com", articles, defaultSettings);

    expect(reply).toContain("@user@example.com");
    expect(reply).toContain("Hier sind passende Nachrichten:");
    expect(reply).toContain("1. Neuer Radweg");
    expect(reply).toContain("https://example.com/1");
    expect(reply).toContain("2. Radweg-Debatte");
  });

  it("returns no-results message when articles empty", () => {
    const reply = formatReply("user", [], defaultSettings);

    expect(reply).toBe(
      "@user Leider habe ich dazu keine passenden Nachrichten gefunden. Versuch es gerne mit anderen Suchbegriffen!"
    );
  });

  it("respects 500 char limit", () => {
    const articles = Array.from({ length: 20 }, (_, i) => ({
      title: `Article with a very long title number ${i + 1} that takes up space`,
      url: `https://example.com/article/${i + 1}`,
    }));

    const reply = formatReply("user", articles, defaultSettings);

    expect(reply.length).toBeLessThanOrEqual(500);
  });
});

describe("answerQuestion", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CLAUDE_API_KEY: "test-key" };
    mockHasAiBudgetForSource.mockResolvedValue(true);
    mockLogAiUsage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns no-results for short text", async () => {
    MockedAnthropic.mockClear();

    const result = await answerQuestion("user", "<p>hi</p>", defaultSettings);

    expect(result).toContain("@user");
    expect(result).toContain(
      "Leider habe ich dazu keine passenden Nachrichten"
    );
  });

  it("returns no-results when no keywords extracted", async () => {
    mockAiResponse("[]");

    const result = await answerQuestion(
      "user",
      "<p>@saarlandnews hahahaha lol</p>",
      defaultSettings
    );

    expect(result).toContain("@user");
    expect(result).toContain(
      "Leider habe ich dazu keine passenden Nachrichten"
    );
  });

  it("returns articles when keywords and results found", async () => {
    mockAiResponse(
      JSON.stringify({ keywords: ["Radweg"], variants: ["Radwege"] })
    );
    mockDb([
      { data: { title: "Neuer Radweg", link: "https://example.com/1" } },
    ]);

    const result = await answerQuestion(
      "user",
      '<p><span class="mention">@saarlandnews</span> Gibt es Neuigkeiten zum Radweg?</p>',
      defaultSettings
    );

    expect(result).toContain("@user");
    expect(result).toContain("Neuer Radweg");
    expect(result).toContain("https://example.com/1");
  });
});
