import { getTopicEmoji, analyzeForPoll } from "./engagementEnhancer.js";

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
  it("returns not debatable for police feed", async () => {
    const result = await analyzeForPoll("Test title", "polizei");
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
    // Without API key, should return false
    const result = await analyzeForPoll("Neue Bauvorhaben in Saarbrücken");
    expect(result.isDebatable).toBe(false);
  });
});
