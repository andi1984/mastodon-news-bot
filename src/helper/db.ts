import { createClient as _createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * Singleton Supabase client - reuses connection across all calls.
 * This avoids the overhead of creating new connections on every request.
 */
const createClient = (): SupabaseClient => {
  if (!client) {
    client = _createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_KEY as string,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );
  }
  return client;
};

export default createClient;
