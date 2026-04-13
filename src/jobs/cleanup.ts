import "dotenv/config";
import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");
import createClient from "../helper/db.js";
import getInstance from "../helper/login.js";
import {
  getExpiredPins,
  removePinRecord,
  cleanupExpiredState,
} from "../helper/botState.js";
import { cleanupTootedArticles as cleanupTootedArticlesHelper } from "../helper/cleanupHelpers.js";

const supabase = createClient();

// Configurable retention periods (in hours unless noted)
const TOOTED_ARTICLE_RETENTION_HOURS = 0; // Delete immediately after tooting
const STALE_UNTOOTED_RETENTION_HOURS = settings.min_freshness_hours || 24;
const TOOTED_STORY_RETENTION_DAYS = (settings as any).story_retention_days ?? 3;
const UNTOOTED_STORY_RETENTION_DAYS = (settings as any).untooted_story_retention_days ?? 1;
const AI_USAGE_RETENTION_DAYS = (settings as any).ai_usage_retention_days ?? 14;
const TOOTED_HASH_RETENTION_DAYS = (settings as any).tooted_hash_retention_days ?? 7;
const MAX_STORY_TOKENS = 150; // Prune token arrays larger than this

interface CleanupStats {
  tootedArticles: number;
  staleArticles: number;
  tootedStories: number;
  untootedStories: number;
  orphanedStoryRefs: number;
  aiUsageRows: number;
  tootedHashes: number;
  prunedStoryTokens: number;
  unpinnedToots: number;
  expiredBotState: number;
}

async function cleanupTootedArticles(): Promise<number> {
  return cleanupTootedArticlesHelper(supabase);
}

async function cleanupStaleArticles(): Promise<number> {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - STALE_UNTOOTED_RETENTION_HOURS);

  // Persist hashes to tooted_hashes BEFORE deleting so they stay deduped
  // even if the item keeps reappearing in the RSS feed (event feeds etc.).
  // Without this, stale untooted items are silently re-ingested next grabber run.
  const { data, error } = await supabase
    .from(settings.db_table)
    .delete()
    .eq("tooted", false)
    .or(`pub_date.lt.${cutoff.toISOString()},created_at.lt.${cutoff.toISOString()}`)
    .select("id, hash");

  if (error) {
    console.error(`Cleanup stale articles: ${error.message}`);
    return 0;
  }

  const rows = (data ?? []) as { id: string; hash: string | null }[];
  const hashRecords = rows
    .map((r) => r.hash)
    .filter((h): h is string => !!h)
    .map((hash) => ({ hash }));

  if (hashRecords.length > 0) {
    const { error: hashErr } = await supabase
      .from("tooted_hashes")
      .upsert(hashRecords, { onConflict: "hash" });
    if (hashErr) {
      console.error(`Cleanup stale: failed to persist hashes: ${hashErr.message}`);
    }
  }

  return rows.length;
}

async function cleanupTootedStories(): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - TOOTED_STORY_RETENTION_DAYS);

  const { data, error } = await supabase
    .from("stories")
    .delete()
    .eq("tooted", true)
    .lt("updated_at", cutoff.toISOString())
    .select("id");

  if (error) {
    console.error(`Cleanup tooted stories: ${error.message}`);
    return 0;
  }
  return data?.length ?? 0;
}

async function cleanupUntootedStories(): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - UNTOOTED_STORY_RETENTION_DAYS);

  const { data, error } = await supabase
    .from("stories")
    .delete()
    .eq("tooted", false)
    .lt("updated_at", cutoff.toISOString())
    .select("id");

  if (error) {
    console.error(`Cleanup untooted stories: ${error.message}`);
    return 0;
  }
  return data?.length ?? 0;
}

async function cleanupOrphanedStoryRefs(): Promise<number> {
  // Find articles with story_id that no longer exist in stories table
  const { data: articlesWithStories, error: fetchError } = await supabase
    .from(settings.db_table)
    .select("id, story_id")
    .not("story_id", "is", null);

  if (fetchError || !articlesWithStories || articlesWithStories.length === 0) {
    return 0;
  }

  // Get all existing story IDs
  const storyIds = [...new Set(articlesWithStories.map((a: any) => a.story_id))];
  const { data: existingStories, error: storyError } = await supabase
    .from("stories")
    .select("id")
    .in("id", storyIds);

  if (storyError) {
    console.error(`Cleanup orphan refs: ${storyError.message}`);
    return 0;
  }

  const existingStoryIds = new Set((existingStories ?? []).map((s: any) => s.id));
  const orphanedArticleIds = articlesWithStories
    .filter((a: any) => !existingStoryIds.has(a.story_id))
    .map((a: any) => a.id);

  if (orphanedArticleIds.length === 0) {
    return 0;
  }

  // Clear orphaned story_id references
  const { error: updateError } = await supabase
    .from(settings.db_table)
    .update({ story_id: null })
    .in("id", orphanedArticleIds);

  if (updateError) {
    console.error(`Cleanup orphan refs update: ${updateError.message}`);
    return 0;
  }

  return orphanedArticleIds.length;
}

async function cleanupAiUsage(): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - AI_USAGE_RETENTION_DAYS);

  const { data, error } = await supabase
    .from("ai_usage")
    .delete()
    .lt("created_at", cutoff.toISOString())
    .select("id");

  if (error) {
    // Table might not exist - that's ok
    if (!error.message.includes("does not exist")) {
      console.error(`Cleanup AI usage: ${error.message}`);
    }
    return 0;
  }
  return data?.length ?? 0;
}

async function cleanupTootedHashes(): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - TOOTED_HASH_RETENTION_DAYS);

  const { data, error } = await supabase
    .from("tooted_hashes")
    .delete()
    .lt("created_at", cutoff.toISOString())
    .select("hash");

  if (error) {
    // Table might not exist yet - that's ok
    if (!error.message.includes("does not exist")) {
      console.error(`Cleanup tooted hashes: ${error.message}`);
    }
    return 0;
  }
  return data?.length ?? 0;
}

async function unpinExpiredToots(): Promise<number> {
  const expiredTootIds = await getExpiredPins();

  if (expiredTootIds.length === 0) {
    return 0;
  }

  let unpinned = 0;

  try {
    const mastoClient = await getInstance();

    for (const tootId of expiredTootIds) {
      try {
        await mastoClient.v1.statuses.$select(tootId).unpin();
        await removePinRecord(tootId);
        unpinned++;
        console.log(`Unpinned expired toot ${tootId}`);
      } catch (err) {
        // Toot might have been deleted or already unpinned
        console.error(`Failed to unpin ${tootId}: ${err}`);
        // Still remove the record to avoid retrying
        await removePinRecord(tootId);
      }
    }
  } catch (err) {
    console.error(`Unpin cleanup failed: ${err}`);
  }

  return unpinned;
}

async function pruneStoryTokens(): Promise<number> {
  // Find stories with oversized token arrays
  const { data: largeStories, error: fetchError } = await supabase
    .from("stories")
    .select("id, tokens")
    .not("tokens", "is", null);

  if (fetchError || !largeStories) {
    return 0;
  }

  let pruned = 0;
  for (const story of largeStories as { id: string; tokens: string[] }[]) {
    if (story.tokens && story.tokens.length > MAX_STORY_TOKENS) {
      // Keep most common/important tokens (first N added are usually from title)
      const prunedTokens = story.tokens.slice(0, MAX_STORY_TOKENS);

      const { error } = await supabase
        .from("stories")
        .update({ tokens: prunedTokens })
        .eq("id", story.id);

      if (!error) {
        pruned++;
      }
    }
  }

  return pruned;
}

async function runFullCleanup(): Promise<CleanupStats> {
  console.log("Starting comprehensive cleanup...");

  // Run all cleanup tasks in parallel where possible
  const [
    tootedArticles,
    staleArticles,
    tootedStories,
    untootedStories,
  ] = await Promise.all([
    cleanupTootedArticles(),
    cleanupStaleArticles(),
    cleanupTootedStories(),
    cleanupUntootedStories(),
  ]);

  // These depend on stories being cleaned first
  const [orphanedStoryRefs, aiUsageRows, tootedHashes, prunedStoryTokens, unpinnedToots, expiredBotState] = await Promise.all([
    cleanupOrphanedStoryRefs(),
    cleanupAiUsage(),
    cleanupTootedHashes(),
    pruneStoryTokens(),
    unpinExpiredToots(),
    cleanupExpiredState(),
  ]);

  return {
    tootedArticles,
    staleArticles,
    tootedStories,
    untootedStories,
    orphanedStoryRefs,
    aiUsageRows,
    tootedHashes,
    prunedStoryTokens,
    unpinnedToots,
    expiredBotState,
  };
}

(async () => {
  const stats = await runFullCleanup();

  const total = Object.values(stats).reduce((a, b) => a + b, 0);

  console.log(`Cleanup complete: ${total} items processed`);
  console.log(`  Articles: ${stats.tootedArticles} tooted, ${stats.staleArticles} stale`);
  console.log(`  Stories: ${stats.tootedStories} tooted, ${stats.untootedStories} untooted`);
  console.log(`  Maintenance: ${stats.orphanedStoryRefs} orphan refs, ${stats.aiUsageRows} AI logs, ${stats.tootedHashes} old hashes, ${stats.prunedStoryTokens} token arrays pruned`);
  console.log(`  Bot state: ${stats.unpinnedToots} unpinned, ${stats.expiredBotState} expired state`);

  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();

// Export for use in other modules (inline cleanup after tooting)
export { cleanupTootedArticles, cleanupOrphanedStoryRefs, runFullCleanup };
