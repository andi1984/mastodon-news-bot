import "dotenv/config";
import { postDone, startWatchdog } from "../helper/workerLifecycle.js";
import getInstance from "../helper/login.js";
import {
  extractTitleFromStatus,
  formatDigestToot,
  DigestEntry,
} from "../helper/digestFormatter.js";
import { calculateEngagement } from "../helper/engagementCounter.js";
import type { mastodon } from "masto";

function getTodayBerlin(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
}

function getDateBerlin(date: string): string {
  return new Date(date).toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
}

// Bounds for one run: pagination and per-status context fetches are Mastodon
// round trips (up to 30s each); unbounded they can push the worker past
// Bree's 300s force-kill. Only the raw-engagement top candidates get the
// expensive context fetch — the digest needs 5 winners, not exact scores.
// The count caps alone can't bound time (21 requests × 30s worst case), so
// gathering also stops at GATHER_BUDGET_MS and the digest posts with
// whatever was collected — a partial digest beats a killed worker.
const MAX_STATUS_PAGES = 5;
const MAX_CONTEXT_FETCHES = 15;
const CONTEXT_FETCH_DELAY_MS = 1000;
const GATHER_BUDGET_MS = 150_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pre-rank signal from the status object itself. Deliberately excludes
 * repliesCount: the thread-fixer posts the bot's own replies under primaries,
 * so reply counts are self-inflated — favs and boosts can only come from
 * other accounts. The context fetch below still counts external replies for
 * the final score.
 */
const rawEngagement = (s: mastodon.v1.Status): number =>
  (s.reblogsCount ?? 0) + (s.favouritesCount ?? 0);

(async () => {
  startWatchdog("daily-digest");
  const startedAt = Date.now();
  const gatherBudgetLeft = () => Date.now() - startedAt < GATHER_BUDGET_MS;

  const mastoClient = await getInstance();
  const me = await mastoClient.v1.accounts.verifyCredentials();
  console.log(`[daily-digest] Logged in as @${me.acct} (id: ${me.id})`);

  const today = getTodayBerlin();
  const todayStatuses: mastodon.v1.Status[] = [];

  // Paginate through own statuses, collecting today's original posts
  let pages = 0;
  for await (const statuses of mastoClient.v1.accounts
    .$select(me.id)
    .statuses.list({ limit: 40, excludeReplies: true, excludeReblogs: true })) {
    let hitYesterday = false;
    for (const status of statuses) {
      const statusDate = getDateBerlin(status.createdAt);
      if (statusDate === today) {
        todayStatuses.push(status);
      } else if (statusDate < today) {
        hitYesterday = true;
        break;
      }
    }
    if (hitYesterday) break;
    if (++pages >= MAX_STATUS_PAGES || !gatherBudgetLeft()) {
      console.warn(
        `[daily-digest] Gather bound hit (${pages} pages, ${Math.round((Date.now() - startedAt) / 1000)}s) with ${todayStatuses.length} statuses — proceeding with what we have`
      );
      break;
    }
  }

  console.log(`[daily-digest] Found ${todayStatuses.length} statuses from today (${today})`);

  if (todayStatuses.length === 0) {
    console.log("[daily-digest] No statuses today, skipping digest.");
    await postDone();
    return;
  }

  // Score by engagement, excluding bot's own replies (Update toots).
  // Pre-rank by the counters already on the status and only context-fetch
  // the top candidates; the context call exists solely to subtract the
  // bot's own thread replies from the reply count.
  const candidates = [...todayStatuses]
    .sort((a, b) => rawEngagement(b) - rawEngagement(a))
    .slice(0, MAX_CONTEXT_FETCHES);
  if (todayStatuses.length > candidates.length) {
    console.log(
      `[daily-digest] Context-fetching top ${candidates.length} of ${todayStatuses.length} statuses (raw-engagement pre-rank)`
    );
  }

  const scored: { status: mastodon.v1.Status; activity: number }[] = [];

  for (const [i, status] of candidates.entries()) {
    if (!gatherBudgetLeft()) {
      console.warn(
        `[daily-digest] Gather budget exhausted after ${scored.length}/${candidates.length} context fetches — scoring what we have`
      );
      break;
    }
    if (i > 0) await sleep(CONTEXT_FETCH_DELAY_MS);

    // Fetch context to get replies and filter out bot's own
    const context = await mastoClient.v1.statuses.$select(status.id).context.fetch();
    const engagement = calculateEngagement(status, context.descendants, me.id);

    scored.push({ status, activity: engagement.totalInteractions });

    if (engagement.ownReplies > 0) {
      console.log(
        `[daily-digest] Status ${status.id}: excluded ${engagement.ownReplies} own replies`
      );
    }
  }

  // Sort by activity and take top 5
  scored.sort((a, b) => b.activity - a.activity);
  const topScored = scored.slice(0, 5);

  if (topScored.length === 0) {
    console.log("[daily-digest] No statuses to include in digest, skipping.");
    await postDone();
    return;
  }

  const entries: DigestEntry[] = topScored.map((s) => ({
    title: extractTitleFromStatus(s.status),
    link: s.status.url ?? null,
    score: s.activity,
  }));

  const tootText = formatDigestToot(entries);
  console.log(`[daily-digest] Posting digest (${tootText.length} chars):\n${tootText}`);

  await mastoClient.v1.statuses.create({
    status: tootText,
    visibility: "public",
    language: "de",
  });

  console.log("[daily-digest] Digest posted successfully.");

  await postDone();
})().catch(async (err) => {
  // Bree worker contract: "done" must be posted on every exit path.
  console.error("[daily-digest] Fatal error:", err);
  await postDone(1);
});
