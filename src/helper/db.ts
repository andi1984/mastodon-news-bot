import { createClient as _createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

/**
 * Sleep helper for retry delays with exponential backoff.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Custom fetch wrapper with retry logic for transient network errors.
 */
const fetchWithRetry: typeof fetch = async (input, init) => {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(input, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(30000), // 30s timeout
      });

      // Retry on 5xx errors (server issues)
      if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
        console.warn(`Supabase: ${response.status} on attempt ${attempt + 1}, retrying...`);
        await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
        continue;
      }

      return response;
    } catch (err) {
      lastError = err as Error;

      // Don't retry on abort/timeout or final attempt
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }

      if (attempt < MAX_RETRIES - 1) {
        console.warn(`Supabase: network error on attempt ${attempt + 1}, retrying...`);
        await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }

  throw lastError ?? new Error("Supabase fetch failed after retries");
};

/**
 * Singleton Supabase client with optimized configuration:
 * - Connection reuse across all calls
 * - Automatic retry for transient failures
 * - 30s request timeout
 * - Keep-alive enabled for connection pooling
 * - No auth session overhead (service key usage)
 */
const createClient = (): SupabaseClient => {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;

    if (!url || !key) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_KEY environment variables");
    }

    client = _createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: fetchWithRetry,
        headers: {
          "x-client-info": "mastodon-news-bot",
        },
      },
      db: {
        schema: "public",
      },
    });
  }
  return client;
};

/**
 * Health check for Supabase connection.
 * Useful for monitoring and startup validation.
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const db = createClient();
    const { error } = await db.from("news").select("id").limit(1);
    return !error;
  } catch {
    return false;
  }
}

export default createClient;
