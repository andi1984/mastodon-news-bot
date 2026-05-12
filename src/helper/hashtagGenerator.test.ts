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

const { generateHashtags, generateHashtagsSync } = await import("./hashtagGenerator.js");

describe("hashtagGenerator", () => {
  describe("generateHashtagsSync", () => {
    it("includes base hashtags", () => {
      const result = generateHashtagsSync("Random title", ["News", "SaarlandNews"]);
      expect(result).toContain("News");
      expect(result).toContain("SaarlandNews");
    });

    it("detects police topic", () => {
      const result = generateHashtagsSync("Polizei fasst Einbrecher", ["SaarlandNews"]);
      expect(result).toContain("Polizei");
      expect(result).toContain("SaarlandNews");
    });

    it("detects accident topic", () => {
      const result = generateHashtagsSync("Schwerer Unfall auf der A1", ["SaarlandNews"]);
      expect(result).toContain("Unfall");
    });

    it("detects fire topic", () => {
      const result = generateHashtagsSync("Brand in Mehrfamilienhaus", ["SaarlandNews"]);
      expect(result).toContain("Feuer");
    });

    it("detects bicycle topic", () => {
      const result = generateHashtagsSync("Neuer Radweg eröffnet", ["SaarlandNews"]);
      expect(result).toContain("Fahrrad");
    });

    it("detects politics topic", () => {
      const result = generateHashtagsSync("Landtag beschließt neues Gesetz", ["SaarlandNews"]);
      expect(result).toContain("Politik");
    });

    it("detects location Saarbruecken", () => {
      const result = generateHashtagsSync("Festival in Saarbrücken", ["SaarlandNews"]);
      expect(result).toContain("Saarbruecken");
    });

    it("detects location Homburg", () => {
      const result = generateHashtagsSync("Konzert in Homburg", ["SaarlandNews"]);
      expect(result).toContain("Homburg");
    });

    it("caps at 4 hashtags", () => {
      // Title with multiple topics and location
      const result = generateHashtagsSync(
        "Polizei ermittelt nach Unfall und Brand in Saarbrücken",
        ["SaarlandNews"]
      );
      expect(result.length).toBeLessThanOrEqual(4);
    });

    it("avoids duplicate hashtags", () => {
      const result = generateHashtagsSync("Polizei Polizei Polizei", ["SaarlandNews"]);
      const polizeiCount = result.filter((t) => t === "Polizei").length;
      expect(polizeiCount).toBe(1);
    });

    it("works with empty base hashtags", () => {
      const result = generateHashtagsSync("Feuer in Saarbrücken");
      expect(result).toContain("Feuer");
      expect(result).toContain("Saarbruecken");
    });
  });

  describe("generateHashtags (async)", () => {
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

    it("returns rule-based hashtags without API key", async () => {
      delete process.env.CLAUDE_API_KEY;
      // Without CLAUDE_API_KEY, should still return rule-based matches
      const result = await generateHashtags("Polizei in Saarbrücken", ["SaarlandNews"]);
      expect(result).toContain("SaarlandNews");
      expect(result).toContain("Polizei");
      expect(result).toContain("Saarbruecken");
    });

    it("includes base hashtags", async () => {
      delete process.env.CLAUDE_API_KEY;
      const result = await generateHashtags("Random title", ["News", "SaarlandNews"]);
      expect(result).toContain("News");
      expect(result).toContain("SaarlandNews");
    });

    // ─── AI fallback path (lines 130-167) ───────────────────────────────────

    it("calls AI when no rule-based topic matches and API key is set", async () => {
      process.env.CLAUDE_API_KEY = "test-key";
      mockMessagesCreate.mockResolvedValue({
        usage: { input_tokens: 15, output_tokens: 10 },
        content: [{ type: "text", text: '{"tags":["Stadtentwicklung"]}' }],
      });
      mockParseAiJson.mockReturnValue({ tags: ["Stadtentwicklung"] });

      // Title that matches no keywords in TOPIC_HASHTAGS or LOCATION_HASHTAGS
      const result = await generateHashtags(
        "Neue Initiative zur Stadtplanung startet",
        ["SaarlandNews"]
      );
      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
      expect(result).toContain("Stadtentwicklung");
      expect(result).toContain("SaarlandNews");
    });

    it("does not call AI when rule-based matches are found", async () => {
      process.env.CLAUDE_API_KEY = "test-key";

      // Title matches 'polizei' keyword — rule-based match found, AI skipped
      const result = await generateHashtags("Polizei ermittelt", ["SaarlandNews"]);
      expect(mockMessagesCreate).not.toHaveBeenCalled();
      expect(result).toContain("Polizei");
    });

    it("does not call AI when budget is exhausted", async () => {
      process.env.CLAUDE_API_KEY = "test-key";
      mockHasAiBudgetForSource.mockResolvedValue(false);

      const result = await generateHashtags(
        "Neue Initiative zur Stadtplanung",
        ["SaarlandNews"]
      );
      expect(mockMessagesCreate).not.toHaveBeenCalled();
      // Should still return base + any rule-based tags
      expect(result).toContain("SaarlandNews");
    });

    it("AI tags are deduplicated against existing tags (line 107)", async () => {
      process.env.CLAUDE_API_KEY = "test-key";
      mockMessagesCreate.mockResolvedValue({
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: "text", text: '{"tags":["SaarlandNews","NeuesTag"]}' }],
      });
      // AI returns SaarlandNews which is already in base tags
      mockParseAiJson.mockReturnValue({ tags: ["SaarlandNews", "NeuesTag"] });

      const result = await generateHashtags(
        "Irgendwas ohne Keywords",
        ["SaarlandNews"]
      );
      // SaarlandNews should appear only once
      const count = result.filter((t) => t === "SaarlandNews").length;
      expect(count).toBe(1);
      expect(result).toContain("NeuesTag");
    });

    it("strips leading # from AI-returned tags", async () => {
      process.env.CLAUDE_API_KEY = "test-key";
      mockMessagesCreate.mockResolvedValue({
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: "text", text: '{"tags":["#Saarland","#Nachrichten"]}' }],
      });
      mockParseAiJson.mockReturnValue({ tags: ["#Saarland", "#Nachrichten"] });

      const result = await generateHashtags("Neues Thema", ["News"]);
      expect(result).toContain("Saarland");
      expect(result).not.toContain("#Saarland");
    });

    it("filters out AI tags that are empty or too long (>30 chars)", async () => {
      process.env.CLAUDE_API_KEY = "test-key";
      const tooLong = "A".repeat(31);
      mockMessagesCreate.mockResolvedValue({
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: "text", text: "{}" }],
      });
      mockParseAiJson.mockReturnValue({ tags: ["", tooLong, "GutesTag"] });

      const result = await generateHashtags("Neues Thema", ["News"]);
      expect(result).toContain("GutesTag");
      expect(result).not.toContain("");
      expect(result).not.toContain(tooLong);
    });

    it("AI returns no tags array — returns only base tags", async () => {
      process.env.CLAUDE_API_KEY = "test-key";
      mockMessagesCreate.mockResolvedValue({
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: "text", text: '{"error":"none"}' }],
      });
      mockParseAiJson.mockReturnValue({ error: "none" });

      const result = await generateHashtags("Irgendwas", ["SaarlandNews"]);
      expect(result).toContain("SaarlandNews");
      expect(result).not.toContain(undefined);
    });

    it("handles non-string elements in AI tags array gracefully", async () => {
      process.env.CLAUDE_API_KEY = "test-key";
      mockMessagesCreate.mockResolvedValue({
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: "text", text: "{}" }],
      });
      mockParseAiJson.mockReturnValue({ tags: [42, null, "ValidTag"] });

      const result = await generateHashtags("Neues Thema", ["News"]);
      expect(result).toContain("ValidTag");
      // Non-strings should not appear
      expect(result).not.toContain(42);
      expect(result).not.toContain(null);
    });

    it("AI call throws — falls back gracefully to base/rule-based tags", async () => {
      process.env.CLAUDE_API_KEY = "test-key";
      mockMessagesCreate.mockRejectedValue(new Error("AI boom"));

      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const result = await generateHashtags("Neues Thema ohne Keywords", ["SaarlandNews"]);
      expect(result).toContain("SaarlandNews");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("AI hashtag generation failed")
      );
      errorSpy.mockRestore();
    });

    it("handles non-text AI response content type", async () => {
      process.env.CLAUDE_API_KEY = "test-key";
      mockMessagesCreate.mockResolvedValue({
        usage: { input_tokens: 10, output_tokens: 0 },
        content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
      });
      mockParseAiJson.mockReturnValue({ tags: [] });

      const result = await generateHashtags("Neues Thema", ["News"]);
      // Should return base tags only — no crash
      expect(result).toContain("News");
    });

    it("logs AI usage after successful API call", async () => {
      process.env.CLAUDE_API_KEY = "test-key";
      mockMessagesCreate.mockResolvedValue({
        usage: { input_tokens: 25, output_tokens: 15 },
        content: [{ type: "text", text: '{"tags":["StadtEntwicklung"]}' }],
      });
      mockParseAiJson.mockReturnValue({ tags: ["StadtEntwicklung"] });

      await generateHashtags("Neues Stadtthema ohne Keywords", ["SaarlandNews"]);
      expect(mockLogAiUsage).toHaveBeenCalledWith("hashtag_generation", 25, 15);
    });

    it("caps total hashtags at 4 even when AI returns extras", async () => {
      process.env.CLAUDE_API_KEY = "test-key";
      mockMessagesCreate.mockResolvedValue({
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: "text", text: "{}" }],
      });
      mockParseAiJson.mockReturnValue({ tags: ["TagA", "TagB"] });

      // Start with 3 base tags + 2 AI tags would be 5 — capped at 4
      const result = await generateHashtags(
        "Neues Thema ohne Keywords",
        ["T1", "T2", "T3"]
      );
      expect(result.length).toBeLessThanOrEqual(4);
    });
  });
});
