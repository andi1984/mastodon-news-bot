import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

// ─── Mock @anthropic-ai/sdk ───────────────────────────────────────────────────
const mockMessagesCreate = jest.fn();
jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));

// ─── Mock costTracker ─────────────────────────────────────────────────────────
const mockHasAiBudgetForSource = jest.fn<() => Promise<boolean>>();
const mockLogAiUsage = jest.fn<() => Promise<void>>();
jest.unstable_mockModule("./costTracker.js", () => ({
  hasAiBudgetForSource: mockHasAiBudgetForSource,
  logAiUsage: mockLogAiUsage,
}));

// ─── Mock parseAiJson ─────────────────────────────────────────────────────────
const mockParseAiJson = jest.fn<(text: string) => any>();
jest.unstable_mockModule("./parseAiJson.js", () => ({
  parseAiJson: mockParseAiJson,
}));

const { getTopicEmoji, analyzeForPoll } = await import("./engagementEnhancer.js");

describe("getTopicEmoji", () => {
  it("returns fire emoji for fire-related titles", () => {
    expect(getTopicEmoji("Brand in Saarbrücken")).toBe("🔥");
    expect(getTopicEmoji("Feuer in Wohnhaus")).toBe("🔥");
  });

  it("returns police emoji for police-related titles", () => {
    expect(getTopicEmoji("Polizei sucht Zeugen")).toBe("🚔");
    expect(getTopicEmoji("Festnahme nach Einbruch")).toBe("🚔");
  });

  it("returns warning emoji for accidents", () => {
    expect(getTopicEmoji("Schwerer Unfall auf A1")).toBe("⚠️");
  });

  it("returns bike emoji for cycling news", () => {
    expect(getTopicEmoji("Neuer Radweg eröffnet")).toBe("🚲");
  });

  it("returns party emoji for events", () => {
    expect(getTopicEmoji("Stadtfest am Wochenende")).toBe("🎉");
    expect(getTopicEmoji("Konzert im Staatstheater")).toBe("🎉");
  });

  it("returns empty string for generic titles", () => {
    expect(getTopicEmoji("Neue Regelung tritt in Kraft")).toBe("");
    expect(getTopicEmoji("Bürgermeister trifft Minister")).toBe("");
  });

  it("is case insensitive", () => {
    expect(getTopicEmoji("BRAND IN VÖLKLINGEN")).toBe("🔥");
    expect(getTopicEmoji("polizei ermittelt")).toBe("🚔");
  });

  describe("soccer emoji false positive regression", () => {
    it("does not fire for city name alone", () => {
      expect(getTopicEmoji("Saarbrücken plant neues Stadtentwicklungsprojekt")).toBe("");
    });

    it("does not fire for generic 'spiel' in political context", () => {
      expect(getTopicEmoji("Im Spiel der politischen Kräfte gewinnt die CDU")).toBe("");
    });

    it("does not fire for 'tor' meaning gate/door", () => {
      expect(getTopicEmoji("Stadttor saniert: Historisches Gemäuer bekommt neuen Anstrich")).toBe("");
      expect(getTopicEmoji("Historisches Tor zur Altstadt wird saniert")).toBe("");
    });

    it("still fires for genuine soccer headlines", () => {
      expect(getTopicEmoji("1. FC Saarbrücken gewinnt Heimspiel gegen Kaiserslautern")).toBe("⚽");
      expect(getTopicEmoji("Fußball: Bundesliga-Relegation live")).toBe("⚽");
    });
  });
});

describe("analyzeForPoll", () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.CLAUDE_API_KEY;
    mockHasAiBudgetForSource.mockResolvedValue(true);
    mockLogAiUsage.mockResolvedValue(undefined);
    mockMessagesCreate.mockReset();
    mockParseAiJson.mockReset();
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.CLAUDE_API_KEY;
    } else {
      process.env.CLAUDE_API_KEY = originalApiKey;
    }
  });

  it("returns not debatable for police feed", async () => {
    const result = await analyzeForPoll("Test title", "polizei");
    expect(result.isDebatable).toBe(false);
  });

  it("returns not debatable for blaulichtreport feed", async () => {
    const result = await analyzeForPoll("Test title", "blaulichtreport");
    expect(result.isDebatable).toBe(false);
  });

  it("returns not debatable for accident titles", async () => {
    const result = await analyzeForPoll("Schwerer Unfall auf A1");
    expect(result.isDebatable).toBe(false);
  });

  it("returns not debatable for crime titles", async () => {
    const result = await analyzeForPoll("Festnahme nach Diebstahl");
    expect(result.isDebatable).toBe(false);
  });

  it("returns not debatable when no API key", async () => {
    delete process.env.CLAUDE_API_KEY;
    const result = await analyzeForPoll("Neue Bauvorhaben in Saarbrücken");
    expect(result.isDebatable).toBe(false);
  });

  it("returns not debatable when AI budget is exhausted", async () => {
    process.env.CLAUDE_API_KEY = "test-key";
    mockHasAiBudgetForSource.mockResolvedValue(false);

    const result = await analyzeForPoll("Neue Pläne für Stadtentwicklung");
    expect(result.isDebatable).toBe(false);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns not debatable when AI says not debatable", async () => {
    process.env.CLAUDE_API_KEY = "test-key";
    mockMessagesCreate.mockResolvedValue({
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "text", text: '{"debatable":false}' }],
    });
    mockParseAiJson.mockReturnValue({ debatable: false });

    const result = await analyzeForPoll("Neue Regelung verabschiedet");
    expect(result.isDebatable).toBe(false);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(mockLogAiUsage).toHaveBeenCalledWith("poll_analysis", 10, 5);
  });

  it("returns debatable with poll when AI returns valid poll structure", async () => {
    process.env.CLAUDE_API_KEY = "test-key";
    mockMessagesCreate.mockResolvedValue({
      usage: { input_tokens: 20, output_tokens: 30 },
      content: [
        {
          type: "text",
          text: '{"debatable":true,"poll":{"q":"Soll das gebaut werden?","opts":["Ja","Nein"]}}',
        },
      ],
    });
    mockParseAiJson.mockReturnValue({
      debatable: true,
      poll: { q: "Soll das gebaut werden?", opts: ["Ja", "Nein"] },
    });

    const result = await analyzeForPoll("Neues Bauprojekt in der Innenstadt");
    expect(result.isDebatable).toBe(true);
    expect(result.poll).toBeDefined();
    expect(result.poll!.question).toBe("Soll das gebaut werden?");
    expect(result.poll!.options).toEqual(["Ja", "Nein"]);
    expect(result.poll!.expiresInSeconds).toBe(24 * 60 * 60);
  });

  it("caps poll options at 50 characters each", async () => {
    process.env.CLAUDE_API_KEY = "test-key";
    const longOpt = "A".repeat(60);
    mockMessagesCreate.mockResolvedValue({
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: "text", text: "{}" }],
    });
    mockParseAiJson.mockReturnValue({
      debatable: true,
      poll: { q: "Frage?", opts: [longOpt, "Kurz"] },
    });

    const result = await analyzeForPoll("Politikthema ohne Keywords");
    expect(result.isDebatable).toBe(true);
    expect(result.poll!.options[0]).toHaveLength(50);
    expect(result.poll!.options[1]).toBe("Kurz");
  });

  it("returns isDebatable:true without poll when poll structure is missing", async () => {
    process.env.CLAUDE_API_KEY = "test-key";
    mockMessagesCreate.mockResolvedValue({
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: "text", text: '{"debatable":true}' }],
    });
    mockParseAiJson.mockReturnValue({ debatable: true });

    const result = await analyzeForPoll("Politikthema ohne Keywords");
    expect(result.isDebatable).toBe(true);
    expect(result.poll).toBeUndefined();
  });

  it("returns isDebatable:true without poll when poll has too few options", async () => {
    process.env.CLAUDE_API_KEY = "test-key";
    mockMessagesCreate.mockResolvedValue({
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: "text", text: "{}" }],
    });
    // Only 1 option — invalid
    mockParseAiJson.mockReturnValue({
      debatable: true,
      poll: { q: "Frage?", opts: ["NurEins"] },
    });

    const result = await analyzeForPoll("Politikthema ohne Keywords");
    expect(result.isDebatable).toBe(true);
    expect(result.poll).toBeUndefined();
  });

  it("returns isDebatable:true without poll when poll has too many options (>4)", async () => {
    process.env.CLAUDE_API_KEY = "test-key";
    mockMessagesCreate.mockResolvedValue({
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: "text", text: "{}" }],
    });
    mockParseAiJson.mockReturnValue({
      debatable: true,
      poll: { q: "Frage?", opts: ["A", "B", "C", "D", "E"] },
    });

    const result = await analyzeForPoll("Politikthema ohne Keywords");
    expect(result.isDebatable).toBe(true);
    expect(result.poll).toBeUndefined();
  });

  it("handles non-text AI response content type gracefully", async () => {
    process.env.CLAUDE_API_KEY = "test-key";
    mockMessagesCreate.mockResolvedValue({
      usage: { input_tokens: 10, output_tokens: 0 },
      content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
    });
    mockParseAiJson.mockReturnValue({ debatable: false });

    const result = await analyzeForPoll("Politikthema");
    expect(result.isDebatable).toBe(false);
  });

  it("returns not debatable and logs error when AI call throws", async () => {
    process.env.CLAUDE_API_KEY = "test-key";
    mockMessagesCreate.mockRejectedValue(new Error("network error"));

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const result = await analyzeForPoll("Politikthema");
    expect(result.isDebatable).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Poll analysis failed")
    );
    errorSpy.mockRestore();
  });
});
