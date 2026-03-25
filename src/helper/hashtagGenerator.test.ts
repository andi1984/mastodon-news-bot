import { generateHashtags, generateHashtagsSync } from "./hashtagGenerator.js";

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
    it("returns rule-based hashtags without API key", async () => {
      // Without CLAUDE_API_KEY, should still return rule-based matches
      const result = await generateHashtags("Polizei in Saarbrücken", ["SaarlandNews"]);
      expect(result).toContain("SaarlandNews");
      expect(result).toContain("Polizei");
      expect(result).toContain("Saarbruecken");
    });

    it("includes base hashtags", async () => {
      const result = await generateHashtags("Random title", ["News", "SaarlandNews"]);
      expect(result).toContain("News");
      expect(result).toContain("SaarlandNews");
    });
  });
});
