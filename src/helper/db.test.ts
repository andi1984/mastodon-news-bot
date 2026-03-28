import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const mockSelect = jest.fn();
const mockFrom = jest.fn().mockReturnValue({
  select: mockSelect,
});

const mockCreateClient = jest.fn().mockReturnValue({
  from: mockFrom,
});

jest.unstable_mockModule("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

const { default: createClient, checkHealth } = await import("./db.js");

describe("db", () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...ORIG_ENV,
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_KEY: "test-key-123",
    };
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = ORIG_ENV;
  });

  describe("createClient", () => {
    test("returns a Supabase client", () => {
      const client = createClient();
      expect(client).toBeDefined();
      expect(client).toHaveProperty("from");
    });

    test("returns the same singleton instance on subsequent calls", () => {
      const client1 = createClient();
      const client2 = createClient();
      expect(client1).toBe(client2);
    });
  });

  describe("checkHealth", () => {
    test("returns true when database is reachable", async () => {
      mockSelect.mockReturnValue({
        limit: jest.fn().mockResolvedValue({ error: null }),
      });

      const result = await checkHealth();
      expect(result).toBe(true);
    });

    test("returns false when database returns error", async () => {
      mockSelect.mockReturnValue({
        limit: jest.fn().mockResolvedValue({ error: { message: "connection failed" } }),
      });

      const result = await checkHealth();
      expect(result).toBe(false);
    });

    test("returns false when database throws", async () => {
      mockSelect.mockReturnValue({
        limit: jest.fn().mockRejectedValue(new Error("network error")),
      });

      const result = await checkHealth();
      expect(result).toBe(false);
    });
  });
});
