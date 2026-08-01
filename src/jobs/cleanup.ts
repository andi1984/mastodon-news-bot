import "dotenv/config";
import { postDone, startWatchdog } from "../helper/workerLifecycle.js";
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
import {
  cleanupTootedArticles as cleanupTootedArticlesHelper,
  cleanupStaleArticles as cleanupStaleArticlesHelper,
} from "../helper/cleanupHelpers.js";

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
  return cleanupStaleArticlesHelper(supabase, STALE_UNTOOTED_RETENTION_HOURS);
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
  // Find articles with story_id that no longer exist in stories table.
  // Capped: this table is unbounded and the whole result set is pulled into
  // worker memory; leftovers are picked up by the next run (every 6h).
  const { data: articlesWithStories, error: fetchError } = await supabase
    .from(settings.db_table)
    .select("id, story_id")
    .not("story_id", "is", null)
    .limit(5000);

  if (fetchError || !articlesWithStories || articlesWithStories.length === 0) {
    return 0;
  }

  // Get all existing story IDs (chunked: thousands of ids in one .in()
  // overflows the PostgREST GET URL)
  const storyIds = [...new Set(articlesWithStories.map((a: any) => a.story_id))];
  const existingStoryIdSet = new Set<string>();
  const CHUNK = 500;
  for (let i = 0; i < storyIds.length; i += CHUNK) {
    const { data: existingStories, error: storyError } = await supabase
      .from("stories")
      .select("id")
      .in("id", storyIds.slice(i, i + CHUNK));

    if (storyError) {
      console.error(`Cleanup orphan refs: ${storyError.message}`);
      return 0;
    }
    for (const s of existingStories ?? []) existingStoryIdSet.add((s as any).id);
  }

  const orphanedArticleIds = articlesWithStories
    .filter((a: any) => !existingStoryIdSet.has(a.story_id))
    .map((a: any) => a.id);

  if (orphanedArticleIds.length === 0) {
    return 0;
  }

  // Clear orphaned story_id references — chunked like the reads above:
  // PostgREST puts .in() filters in the URL for PATCH too, and a mass-orphan
  // event (up to the 5000-row scan cap) would otherwise fail every run and
  // make zero progress.
  let cleared = 0;
  for (let i = 0; i < orphanedArticleIds.length; i += CHUNK) {
    const chunk = orphanedArticleIds.slice(i, i + CHUNK);
    const { error: updateError } = await supabase
      .from(settings.db_table)
      .update({ story_id: null })
      .in("id", chunk);

    if (updateError) {
      console.error(`Cleanup orphan refs update: ${updateError.message}`);
      return cleared;
    }
    cleared += chunk.length;
  }

  return cleared;
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

// Each unpin is up to two Mastodon/DB round trips; pins are rare, so a low
// cap bounds the loop without ever biting in practice (next run: 6h).
const UNPIN_CAP = 10;

async function unpinExpiredToots(): Promise<number> {
  const expiredTootIds = await getExpiredPins();

  if (expiredTootIds.length === 0) {
    return 0;
  }

  if (expiredTootIds.length > UNPIN_CAP) {
    console.warn(
      `Unpin: capping at ${UNPIN_CAP} of ${expiredTootIds.length} expired pins this run`
    );
  }

  let unpinned = 0;

  try {
    const mastoClient = await getInstance();

    for (const tootId of expiredTootIds.slice(0, UNPIN_CAP)) {
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

// pruneStoryTokens bounds: the select pulls full token arrays into worker
// memory and every oversized story costs one sequential UPDATE round trip.
// Leftovers are picked up by the next run (every 6h).
const PRUNE_SELECT_LIMIT = 1000;
const PRUNE_UPDATE_CAP = 200;

async function pruneStoryTokens(): Promise<number> {
  // Find stories with oversized token arrays
  const { data: largeStories, error: fetchError } = await supabase
    .from("stories")
    .select("id, tokens")
    .not("tokens", "is", null)
    .limit(PRUNE_SELECT_LIMIT);

  if (fetchError || !largeStories) {
    return 0;
  }

  let pruned = 0;
  for (const story of largeStories as { id: string; tokens: string[] }[]) {
    if (story.tokens && story.tokens.length > MAX_STORY_TOKENS) {
      if (pruned >= PRUNE_UPDATE_CAP) {
        console.warn(
          `Prune story tokens: update cap (${PRUNE_UPDATE_CAP}) reached — remaining oversized stories will be pruned next run`
        );
        break;
      }
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
  startWatchdog("cleanup");
  const stats = await runFullCleanup();

  const total = Object.values(stats).reduce((a, b) => a + b, 0);

  console.log(`Cleanup complete: ${total} items processed`);
  console.log(`  Articles: ${stats.tootedArticles} tooted, ${stats.staleArticles} stale`);
  console.log(`  Stories: ${stats.tootedStories} tooted, ${stats.untootedStories} untooted`);
  console.log(`  Maintenance: ${stats.orphanedStoryRefs} orphan refs, ${stats.aiUsageRows} AI logs, ${stats.tootedHashes} old hashes, ${stats.prunedStoryTokens} token arrays pruned`);
  console.log(`  Bot state: ${stats.unpinnedToots} unpinned, ${stats.expiredBotState} expired state`);

  await postDone();
})().catch(async (err) => {
  // Bree worker contract: "done" must be posted on every exit path.
  console.error("[cleanup] Fatal error:", err);
  await postDone(1);
});

// Export for use in other modules (inline cleanup after tooting)
export { cleanupTootedArticles, cleanupOrphanedStoryRefs, runFullCleanup };
