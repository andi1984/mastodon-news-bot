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

// -------------------------------------------------------------------------
// fetchWithRetry – tested in isolation by intercepting global.fetch
// -------------------------------------------------------------------------
describe("fetchWithRetry (via Supabase createClient global.fetch)", () => {
  // We need to extract the fetchWithRetry function that db.ts passes to
  // _createClient. We capture it by inspecting what mockCreateClient received.
  //
  // Because db.ts is an ESM module with a singleton, we need to reset modules
  // so we get a fresh import with a fresh client (no singleton cached).

  const ORIG_ENV = process.env;

  // We can't easily reset the singleton across ESM dynamic imports inside the
  // same test file, so instead we intercept `global.fetch` and exercise
  // fetchWithRetry through the Supabase client path by extracting the custom
  // fetch that was passed to `_createClient`.

  let capturedFetch: typeof fetch | undefined;

  beforeEach(() => {
    process.env = {
      ...ORIG_ENV,
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_KEY: "test-key-123",
    };

    // Capture the fetch option passed to _createClient on the NEXT call.
    mockCreateClient.mockImplementation((_url: unknown, _key: unknown, opts: unknown) => {
      const options = opts as { global?: { fetch?: typeof fetch } };
      capturedFetch = options?.global?.fetch;
      return { from: mockFrom };
    });

    jest.clearAllMocks();
    capturedFetch = undefined;
  });

  afterEach(() => {
    process.env = ORIG_ENV;
    jest.restoreAllMocks();
  });

  /**
   * Extract the fetchWithRetry function by triggering a fresh createClient call.
   * Because the singleton is already set inside the module we need to rely on
   * the fact that on first test run the singleton may already exist. Instead,
   * we import db fresh via resetModules each time by spawning a child describe.
   *
   * Alternatively, since the singleton is per-module import we can re-import
   * db.js with resetModules for isolation in each test.
   */

  async function getFreshFetchWithRetry(): Promise<typeof fetch> {
    jest.resetModules();

    // Re-register the mock for the fresh module registry
    jest.unstable_mockModule("@supabase/supabase-js", () => ({
      createClient: mockCreateClient,
    }));

    await import("./db.js");

    // Trigger fresh client creation so mockCreateClient captures opts
    const { default: freshCreateClient } = await import("./db.js");
    freshCreateClient();

    if (!capturedFetch) {
      throw new Error("fetchWithRetry was not captured from _createClient options");
    }
    return capturedFetch;
  }

  test("returns response immediately on 2xx", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    const globalFetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(mockResponse);

    const fetchWithRetry = await getFreshFetchWithRetry();
    const result = await fetchWithRetry("https://example.com");

    expect(result.status).toBe(200);
    expect(globalFetchSpy).toHaveBeenCalledTimes(1);
  });

  test("retries on 5xx and returns success on second attempt", async () => {
    const errorResponse = new Response("error", { status: 500 });
    const successResponse = new Response("ok", { status: 200 });

    const globalFetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(errorResponse)
      .mockResolvedValueOnce(successResponse);

    // Spy on setTimeout so retries don't actually wait
    jest.spyOn(global, "setTimeout").mockImplementation((fn) => {
      (fn as () => void)();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const fetchWithRetry = await getFreshFetchWithRetry();
    const result = await fetchWithRetry("https://example.com");

    expect(result.status).toBe(200);
    expect(globalFetchSpy).toHaveBeenCalledTimes(2);
  });

  test("returns 5xx response on last attempt (no more retries)", async () => {
    const errorResponse = new Response("error", { status: 503 });

    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(errorResponse);

    jest.spyOn(global, "setTimeout").mockImplementation((fn) => {
      (fn as () => void)();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const fetchWithRetry = await getFreshFetchWithRetry();
    // On the last attempt (attempt === MAX_RETRIES - 1), the 5xx branch is
    // skipped and the response is returned as-is.
    const result = await fetchWithRetry("https://example.com");
    expect(result.status).toBe(503);
  });

  test("retries on network error and succeeds on second attempt", async () => {
    const networkError = new Error("network failure");
    const successResponse = new Response("ok", { status: 200 });

    const globalFetchSpy = jest
      .spyOn(global, "fetch")
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(successResponse);

    jest.spyOn(global, "setTimeout").mockImplementation((fn) => {
      (fn as () => void)();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const fetchWithRetry = await getFreshFetchWithRetry();
    const result = await fetchWithRetry("https://example.com");

    expect(result.status).toBe(200);
    expect(globalFetchSpy).toHaveBeenCalledTimes(2);
  });

  test("throws lastError after all retries exhausted on network error", async () => {
    const networkError = new Error("persistent network failure");

    jest.spyOn(global, "fetch").mockRejectedValue(networkError);

    jest.spyOn(global, "setTimeout").mockImplementation((fn) => {
      (fn as () => void)();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const fetchWithRetry = await getFreshFetchWithRetry();

    await expect(fetchWithRetry("https://example.com")).rejects.toThrow(
      "persistent network failure"
    );
  });

  test("throws AbortError immediately without retrying", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");

    const globalFetchSpy = jest
      .spyOn(global, "fetch")
      .mockRejectedValueOnce(abortError);

    const fetchWithRetry = await getFreshFetchWithRetry();

    await expect(fetchWithRetry("https://example.com")).rejects.toMatchObject({
      name: "AbortError",
    });
    // Should only have been called once (no retries on AbortError)
    expect(globalFetchSpy).toHaveBeenCalledTimes(1);
  });

  test("createClient throws when SUPABASE_URL is missing", async () => {
    jest.resetModules();
    jest.unstable_mockModule("@supabase/supabase-js", () => ({
      createClient: mockCreateClient,
    }));

    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_KEY;

    const { default: freshCreateClient } = await import("./db.js");

    expect(() => freshCreateClient()).toThrow(
      "Missing SUPABASE_URL or SUPABASE_KEY environment variables"
    );
  });
});
