import { describe, test, expect } from "@jest/globals";
import { scoreFeedItem } from "./feedItemScorer.js";

describe("scoreFeedItem", () => {
  const priorities = {
    udt: 1.0,
    "saarbruecker-zeitung": 0.1,
    saarnews: 0.4,
  };
  const WINDOW = 24;
  const NOW = new Date("2026-04-11T12:00:00Z");

  const hoursAgo = (h: number): string =>
    new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();
  const hoursAhead = (h: number): string =>
    new Date(NOW.getTime() + h * 60 * 60 * 1000).toISOString();

  describe("priority lookup", () => {
    test("uses configured priority for known feedKey", () => {
      const score = scoreFeedItem("udt", hoursAgo(0), priorities, WINDOW, NOW);
      expect(score).toBe(1.0); // priority 1.0 * freshness 1.0
    });

    test("falls back to 0.5 for unknown feedKey", () => {
      const score = scoreFeedItem("unknown", hoursAgo(0), priorities, WINDOW, NOW);
      expect(score).toBe(0.5);
    });

    test("falls back to 0.5 for undefined feedKey", () => {
      const score = scoreFeedItem(undefined, hoursAgo(0), priorities, WINDOW, NOW);
      expect(score).toBe(0.5);
    });

    test("respects low priority", () => {
      const score = scoreFeedItem("saarbruecker-zeitung", hoursAgo(0), priorities, WINDOW, NOW);
      expect(score).toBeCloseTo(0.1);
    });
  });

  describe("freshness decay", () => {
    test("score = priority at age 0", () => {
      expect(scoreFeedItem("udt", hoursAgo(0), priorities, WINDOW, NOW)).toBe(1.0);
    });

    test("score = priority * 0.5 at half-window age", () => {
      expect(scoreFeedItem("udt", hoursAgo(12), priorities, WINDOW, NOW)).toBeCloseTo(0.5);
    });

    test("score = 0 at exactly the freshness window", () => {
      expect(scoreFeedItem("udt", hoursAgo(24), priorities, WINDOW, NOW)).toBe(0);
    });

    test("score clamps to 0 past the freshness window", () => {
      expect(scoreFeedItem("udt", hoursAgo(48), priorities, WINDOW, NOW)).toBe(0);
      expect(scoreFeedItem("udt", hoursAgo(500), priorities, WINDOW, NOW)).toBe(0);
    });

    test("decay scales with window", () => {
      // 12h old, 48h window → 75% fresh
      expect(scoreFeedItem("udt", hoursAgo(12), priorities, 48, NOW)).toBeCloseTo(0.75);
    });
  });

  describe("future pubDate clamp (regression: score 175.764)", () => {
    test("pubDate 1h in the future → freshness 1", () => {
      expect(scoreFeedItem("udt", hoursAhead(1), priorities, WINDOW, NOW)).toBe(1.0);
    });

    test("pubDate 175 days in the future does NOT explode", () => {
      const score = scoreFeedItem("udt", hoursAhead(175 * 24), priorities, WINDOW, NOW);
      expect(score).toBe(1.0);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    test("priority still applies to future-dated items", () => {
      expect(
        scoreFeedItem("saarbruecker-zeitung", hoursAhead(30 * 24), priorities, WINDOW, NOW)
      ).toBeCloseTo(0.1);
    });

    test("future event never outranks a just-published top-priority article", () => {
      const udtFutureEvent = scoreFeedItem("udt", hoursAhead(100 * 24), priorities, WINDOW, NOW);
      const freshUdtArticle = scoreFeedItem("udt", hoursAgo(0), priorities, WINDOW, NOW);
      expect(udtFutureEvent).toBeLessThanOrEqual(freshUdtArticle);
    });
  });

  describe("missing pubDate", () => {
    test("undefined pubDate → priority * 0.5", () => {
      expect(scoreFeedItem("udt", undefined, priorities, WINDOW, NOW)).toBe(0.5);
      expect(scoreFeedItem("saarnews", undefined, priorities, WINDOW, NOW)).toBeCloseTo(0.2);
    });

    test("empty string pubDate → priority * 0.5", () => {
      expect(scoreFeedItem("udt", "", priorities, WINDOW, NOW)).toBe(0.5);
    });
  });
});
