jest.mock("@anthropic-ai/sdk", () => {
  return {
    __esModule: true,
    default: jest.fn(),
  };
});

import Anthropic from "@anthropic-ai/sdk";
import { scoreRegionalRelevance } from "./regionalRelevance.js";
import { RegionalRelevanceSettings } from "../types/settings.js";

const MockedAnthropic = Anthropic as jest.MockedClass<typeof Anthropic>;

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
  MockedAnthropic.mockImplementation(
    () =>
      ({
        messages: {
          create: jest.fn().mockResolvedValue({
            content: [{ type: "text", text }],
          }),
        },
      }) as any
  );
}

function mockApiError() {
  MockedAnthropic.mockImplementation(
    () =>
      ({
        messages: {
          create: jest.fn().mockRejectedValue(new Error("API error")),
        },
      }) as any
  );
}

describe("scoreRegionalRelevance", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CLAUDE_API_KEY: "test-key" };
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
    expect(MockedAnthropic).not.toHaveBeenCalled();
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
    expect(MockedAnthropic).not.toHaveBeenCalled();
  });

  it("returns neutral multipliers when API call throws", async () => {
    mockApiError();

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
    expect(MockedAnthropic).not.toHaveBeenCalled();
  });
});
