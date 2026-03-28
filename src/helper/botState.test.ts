import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// In-memory store for bot_state table
let store: Map<string, { key: string; value: any; updated_at: string }>;

const mockFrom = jest.fn().mockImplementation(() => {
  return {
    select: jest.fn().mockImplementation(() => ({
      eq: jest.fn().mockImplementation((_col: string, keyVal: string) => {
        const row = store.get(keyVal);
        const rows = row ? [row] : [];
        return {
          data: rows,
          error: rows.length ? null : { message: "not found" },
          single: jest.fn().mockImplementation(() => {
            if (row) return { data: row, error: null };
            return { data: null, error: { message: "not found" } };
          }),
        };
      }),
      like: jest.fn().mockImplementation((_col: string, pattern: string) => {
        const prefix = pattern.replace("%", "");
        const rows = Array.from(store.values()).filter((r) =>
          r.key.startsWith(prefix)
        );
        return { data: rows, error: null };
      }),
    })),
    upsert: jest.fn().mockImplementation((row: any) => {
      store.set(row.key, row);
      return { error: null };
    }),
    delete: jest.fn().mockImplementation(() => ({
      eq: jest.fn().mockImplementation((_col: string, keyVal: string) => {
        store.delete(keyVal);
        return { error: null };
      }),
    })),
  };
});

jest.unstable_mockModule("./db", () => ({
  default: () => ({ from: mockFrom }),
}));

jest.unstable_mockModule("../data/settings.json", () => ({
  default: {
    adaptive_tooting: {
      cooldown_hours: 1,
      pin_duration_hours: 48,
    },
  },
}));

const {
  isInCooldown,
  setCooldown,
  clearCooldown,
  recordLastToot,
  getMinutesSinceLastToot,
  recordPinnedToot,
  getExpiredPins,
  removePinRecord,
  cleanupExpiredState,
} = await import("./botState.js");

describe("botState", () => {
  beforeEach(() => {
    store = new Map();
    jest.clearAllMocks();
  });

  describe("isInCooldown", () => {
    test("returns false when no cooldown is set", async () => {
      const result = await isInCooldown();
      expect(result.inCooldown).toBe(false);
    });

    test("returns true when cooldown is in the future", async () => {
      const futureTime = new Date();
      futureTime.setHours(futureTime.getHours() + 2);
      store.set("cooldown_until", {
        key: "cooldown_until",
        value: { timestamp: futureTime.toISOString(), reason: "breaking news" },
        updated_at: new Date().toISOString(),
      });

      const result = await isInCooldown();
      expect(result.inCooldown).toBe(true);
      expect(result.reason).toBe("breaking news");
    });

    test("returns false when cooldown has expired", async () => {
      const pastTime = new Date();
      pastTime.setHours(pastTime.getHours() - 2);
      store.set("cooldown_until", {
        key: "cooldown_until",
        value: { timestamp: pastTime.toISOString(), reason: "old news" },
        updated_at: new Date().toISOString(),
      });

      const result = await isInCooldown();
      expect(result.inCooldown).toBe(false);
    });
  });

  describe("setCooldown", () => {
    test("stores cooldown with reason and toot ID", async () => {
      await setCooldown("breaking story", "toot-123");
      const stored = store.get("cooldown_until");
      expect(stored).toBeDefined();
      expect(stored!.value.reason).toBe("breaking story");
      expect(stored!.value.toot_id).toBe("toot-123");
    });

    test("sets cooldown timestamp in the future", async () => {
      await setCooldown("test reason");
      const stored = store.get("cooldown_until");
      const ts = new Date(stored!.value.timestamp);
      expect(ts.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("clearCooldown", () => {
    test("removes cooldown entry", async () => {
      store.set("cooldown_until", {
        key: "cooldown_until",
        value: { timestamp: new Date().toISOString(), reason: "test" },
        updated_at: new Date().toISOString(),
      });

      await clearCooldown();
      expect(store.has("cooldown_until")).toBe(false);
    });
  });

  describe("recordLastToot / getMinutesSinceLastToot", () => {
    test("returns Infinity when no toot has been recorded", async () => {
      const minutes = await getMinutesSinceLastToot();
      expect(minutes).toBe(Infinity);
    });

    test("records a toot and returns small elapsed minutes", async () => {
      await recordLastToot();
      const minutes = await getMinutesSinceLastToot();
      // Should be very close to 0 since we just recorded
      expect(minutes).toBeLessThan(1);
      expect(minutes).toBeGreaterThanOrEqual(0);
    });
  });

  describe("recordPinnedToot / getExpiredPins / removePinRecord", () => {
    test("records a pinned toot", async () => {
      await recordPinnedToot("toot-456");
      const stored = store.get("pinned_toot_toot-456");
      expect(stored).toBeDefined();
      expect(stored!.value.toot_id).toBe("toot-456");
    });

    test("returns empty array when no pins exist", async () => {
      const expired = await getExpiredPins();
      expect(expired).toEqual([]);
    });

    test("returns expired pins", async () => {
      const oldTime = new Date();
      oldTime.setHours(oldTime.getHours() - 50); // 50h ago, > 48h threshold
      store.set("pinned_toot_old-1", {
        key: "pinned_toot_old-1",
        value: { toot_id: "old-1", pinned_at: oldTime.toISOString() },
        updated_at: oldTime.toISOString(),
      });

      const expired = await getExpiredPins();
      expect(expired).toContain("old-1");
    });

    test("does not return fresh pins as expired", async () => {
      const recentTime = new Date();
      recentTime.setHours(recentTime.getHours() - 1); // 1h ago, < 48h threshold
      store.set("pinned_toot_fresh-1", {
        key: "pinned_toot_fresh-1",
        value: { toot_id: "fresh-1", pinned_at: recentTime.toISOString() },
        updated_at: recentTime.toISOString(),
      });

      const expired = await getExpiredPins();
      expect(expired).not.toContain("fresh-1");
    });

    test("removes pin record", async () => {
      store.set("pinned_toot_del-1", {
        key: "pinned_toot_del-1",
        value: { toot_id: "del-1", pinned_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      });

      await removePinRecord("del-1");
      expect(store.has("pinned_toot_del-1")).toBe(false);
    });
  });

  describe("cleanupExpiredState", () => {
    test("removes expired cooldowns", async () => {
      const pastTime = new Date();
      pastTime.setHours(pastTime.getHours() - 2);
      store.set("cooldown_until", {
        key: "cooldown_until",
        value: { timestamp: pastTime.toISOString(), reason: "old" },
        updated_at: pastTime.toISOString(),
      });

      const cleaned = await cleanupExpiredState();
      expect(cleaned).toBe(1);
    });

    test("does not remove active cooldowns", async () => {
      const futureTime = new Date();
      futureTime.setHours(futureTime.getHours() + 2);
      store.set("cooldown_until", {
        key: "cooldown_until",
        value: { timestamp: futureTime.toISOString(), reason: "active" },
        updated_at: new Date().toISOString(),
      });

      const cleaned = await cleanupExpiredState();
      expect(cleaned).toBe(0);
    });

    test("returns 0 when no state exists", async () => {
      const cleaned = await cleanupExpiredState();
      expect(cleaned).toBe(0);
    });
  });
});
