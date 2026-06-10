import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const mockMessagesCreate = jest.fn();
const MockedAnthropic = jest.fn(() => ({
  messages: { create: mockMessagesCreate },
}));

const mockHasAiBudgetForSource = jest.fn().mockResolvedValue(true);
const mockLogAiUsage = jest.fn().mockResolvedValue(undefined);
const mockGetCachedRegionalCategories = jest.fn();
const mockSetCachedRegionalCategories = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: MockedAnthropic,
}));

jest.unstable_mockModule("./costTracker", () => ({
  hasAiBudgetForSource: mockHasAiBudgetForSource,
  logAiUsage: mockLogAiUsage,
}));

jest.unstable_mockModule("./aiCache", () => ({
  getCachedRegionalCategories: mockGetCachedRegionalCategories,
  setCachedRegionalCategories: mockSetCachedRegionalCategories,
}));

const { scoreRegionalRelevance } = await import("./regionalRelevance.js");
import type { RegionalRelevanceSettings } from "../types/settings.js";

const defaultConfig: RegionalRelevanceSettings = {
  enabled: true,
  always_local_feeds: [
    "saarnews",
    "breaking-news",
    "polizei",
    "fahrrad",
    "dudplaner",
    "mfw-events",
    "mfw-pressemitteilungen",
  ],
  multipliers: {
    local: 1.5,
    regional: 1.2,
    national: 1.0,
    international: 0.6,
  },
};

function mockApiResponse(text: string) {
  mockMessagesCreate.mockResolvedValue({
    content: [{ type: "text", text }],
    usage: { input_tokens: 200, output_tokens: 80 },
  });
}

describe("scoreRegionalRelevance", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CLAUDE_API_KEY: "test-key" };
    mockHasAiBudgetForSource.mockResolvedValue(true);
    mockSetCachedRegionalCategories.mockResolvedValue(undefined);
    // Default: no cache hits
    mockGetCachedRegionalCategories.mockResolvedValue(new Map());
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns correct multipliers per category", async () => {
    mockApiResponse(
      JSON.stringify([
        { i: 0, c: "local" },
        { i: 1, c: "regional" },
        { i: 2, c: "national" },
        { i: 3, c: "international" },
      ])
    );

    const articles = [
      { title: "Brand in Saarbrücken", feedKey: "saarbruecker-zeitung" },
      { title: "Grenzverkehr Luxemburg", feedKey: "saarbruecker-zeitung" },
      { title: "Bundestag beschließt Gesetz", feedKey: "tagesschau" },
      { title: "Erdbeben in Japan", feedKey: "tagesschau" },
    ];

    const result = await scoreRegionalRelevance(articles, defaultConfig);

    expect(result.get(0)).toBe(1.5);
    expect(result.get(1)).toBe(1.2);
    expect(result.get(2)).toBe(1.0);
    expect(result.get(3)).toBe(0.6);
  });

  it("short-circuits always-local feeds without API call", async () => {
    const articles = [
      { title: "Polizeibericht Saarlouis", feedKey: "polizei" },
      { title: "Neuer Radweg", feedKey: "fahrrad" },
      { title: "Nachrichten", feedKey: "saarnews" },
    ];

    const result = await scoreRegionalRelevance(articles, defaultConfig);

    expect(result.get(0)).toBe(1.5);
    expect(result.get(1)).toBe(1.5);
    expect(result.get(2)).toBe(1.5);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("mixes always-local and API-classified articles", async () => {
    mockApiResponse(JSON.stringify([{ i: 1, c: "national" }]));

    const articles = [
      { title: "Polizeibericht", feedKey: "polizei" },
      { title: "Bundestagswahl", feedKey: "tagesschau" },
    ];

    const result = await scoreRegionalRelevance(articles, defaultConfig);

    expect(result.get(0)).toBe(1.5); // always-local
    expect(result.get(1)).toBe(1.0); // classified as national
  });

  it("returns neutral multipliers when CLAUDE_API_KEY is missing", async () => {
    delete process.env.CLAUDE_API_KEY;

    const articles = [
      { title: "Bundestagswahl", feedKey: "tagesschau" },
      { title: "Nachrichten", feedKey: "saarbruecker-zeitung" },
    ];

    const result = await scoreRegionalRelevance(articles, defaultConfig);

    expect(result.get(0)).toBe(1.0);
    expect(result.get(1)).toBe(1.0);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns neutral multipliers when AI budget is exceeded", async () => {
    mockHasAiBudgetForSource.mockResolvedValue(false);

    const articles = [
      { title: "Bundestagswahl", feedKey: "tagesschau" },
    ];

    const result = await scoreRegionalRelevance(articles, defaultConfig);

    expect(result.get(0)).toBe(1.0);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns neutral multipliers when API call throws", async () => {
    mockMessagesCreate.mockRejectedValue(new Error("API error"));

    const articles = [
      { title: "Bundestagswahl", feedKey: "tagesschau" },
    ];

    const result = await scoreRegionalRelevance(articles, defaultConfig);

    expect(result.get(0)).toBe(1.0);
  });

  it("returns empty map for empty input", async () => {
    const result = await scoreRegionalRelevance([], defaultConfig);

    expect(result.size).toBe(0);
  });

  it("returns neutral multipliers when disabled", async () => {
    const disabledConfig = { ...defaultConfig, enabled: false };

    const articles = [
      { title: "Brand in Saarbrücken", feedKey: "saarbruecker-zeitung" },
    ];

    const result = await scoreRegionalRelevance(articles, disabledConfig);

    expect(result.get(0)).toBe(1.0);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("uses cached categories instead of calling the API (lines 71, 77)", async () => {
    // Two articles: one has a cache hit, one needs classification
    mockGetCachedRegionalCategories.mockResolvedValue(
      new Map([["Brand in Saarbrücken", "local"]])
    );
    mockApiResponse(JSON.stringify([{ i: 1, c: "national" }]));

    const articles = [
      { title: "Brand in Saarbrücken", feedKey: "saarbruecker-zeitung" },
      { title: "Bundestagswahl", feedKey: "tagesschau" },
    ];

    const result = await scoreRegionalRelevance(articles, defaultConfig);

    // Cache hit returns local multiplier without API call for index 0
    expect(result.get(0)).toBe(1.5);
    // Index 1 classified via API
    expect(result.get(1)).toBe(1.0);
  });

  it("returns early when all articles resolved from cache (line 82)", async () => {
    // All articles have cache hits
    mockGetCachedRegionalCategories.mockResolvedValue(
      new Map([
        ["Erste Nachricht", "local"],
        ["Zweite Nachricht", "regional"],
      ])
    );

    const articles = [
      { title: "Erste Nachricht", feedKey: "saarbruecker-zeitung" },
      { title: "Zweite Nachricht", feedKey: "saarbruecker-zeitung" },
    ];

    const result = await scoreRegionalRelevance(articles, defaultConfig);

    expect(result.get(0)).toBe(1.5);
    expect(result.get(1)).toBe(1.2);
    // No API call needed since all were cached
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("classifies titles matching local_keywords without API call", async () => {
    const config = {
      ...defaultConfig,
      local_keywords: ["saarbrücken", "saarlouis"],
    };

    const articles = [
      { title: "Brand in Saarbrücken", feedKey: "saarbruecker-zeitung" },
      { title: "Stau bei Saarlouis", feedKey: "radio-salue" },
    ];

    const result = await scoreRegionalRelevance(articles, config);

    expect(result.get(0)).toBe(1.5);
    expect(result.get(1)).toBe(1.5);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("sends only non-keyword titles to the API", async () => {
    const config = { ...defaultConfig, local_keywords: ["saarbrücken"] };
    mockApiResponse(JSON.stringify([{ i: 1, c: "national" }]));

    const articles = [
      { title: "Brand in Saarbrücken", feedKey: "saarbruecker-zeitung" },
      { title: "Bundestagswahl", feedKey: "tagesschau" },
    ];

    const result = await scoreRegionalRelevance(articles, config);

    expect(result.get(0)).toBe(1.5); // keyword match, no AI
    expect(result.get(1)).toBe(1.0); // AI classified
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const call = mockMessagesCreate.mock.calls[0][0] as any;
    expect(call.messages[0].content).not.toContain("Saarbrücken");
  });

  it("splits large batches into chunks with sized max_tokens", async () => {
    // 30 articles -> 2 chunks (25 + 5)
    mockMessagesCreate.mockImplementation(async (req: any) => {
      // Echo back a classification for every index mentioned in the prompt
      const indices = [...req.messages[0].content.matchAll(/^(\d+):/gm)].map(
        (m: any) => Number(m[1])
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(indices.map((i: number) => ({ i, c: "national" }))),
          },
        ],
        usage: { input_tokens: 200, output_tokens: 80 },
      };
    });

    const articles = Array.from({ length: 30 }, (_, i) => ({
      title: `Artikel ${i}`,
      feedKey: "tagesschau",
    }));

    const result = await scoreRegionalRelevance(articles, defaultConfig);

    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    const firstCall = mockMessagesCreate.mock.calls[0][0] as any;
    const secondCall = mockMessagesCreate.mock.calls[1][0] as any;
    expect(firstCall.max_tokens).toBe(25 * 16 + 64);
    expect(secondCall.max_tokens).toBe(5 * 16 + 64);
    for (let i = 0; i < 30; i++) {
      expect(result.get(i)).toBe(1.0);
    }
  });

  it("fills missing indices with neutral multiplier when AI omits them (line 150)", async () => {
    // AI response is missing index 1 entirely
    mockApiResponse(JSON.stringify([{ i: 0, c: "local" }]));

    const articles = [
      { title: "Artikel A", feedKey: "saarbruecker-zeitung" },
      { title: "Artikel B", feedKey: "tagesschau" },
    ];

    const result = await scoreRegionalRelevance(articles, defaultConfig);

    expect(result.get(0)).toBe(1.5); // classified as local
    expect(result.get(1)).toBe(1.0); // fallback neutral
  });
});
