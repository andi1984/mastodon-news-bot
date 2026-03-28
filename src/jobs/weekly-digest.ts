import "dotenv/config";
import { parentPort } from "node:worker_threads";
import getInstance from "../helper/login.js";
import {
  extractTitleFromStatus,
  formatDigestToot,
  DigestEntry,
} from "../helper/digestFormatter.js";
import { calculateEngagement } from "../helper/engagementCounter.js";
import type { mastodon } from "masto";

function getDateBerlin(date: string | Date): string {
  return new Date(date).toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
}

function getSevenDaysAgoBerlin(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return getDateBerlin(d);
}

(async () => {
  const mastoClient = await getInstance();
  const me = await mastoClient.v1.accounts.verifyCredentials();
  console.log(`[weekly-digest] Logged in as @${me.acct} (id: ${me.id})`);

  const today = getDateBerlin(new Date());
  const weekAgo = getSevenDaysAgoBerlin();
  const weekStatuses: mastodon.v1.Status[] = [];

  // Paginate through own statuses, collecting last 7 days' original posts
  for await (const statuses of mastoClient.v1.accounts
    .$select(me.id)
    .statuses.list({ limit: 40, excludeReplies: true, excludeReblogs: true })) {
    let hitOlder = false;
    for (const status of statuses) {
      const statusDate = getDateBerlin(status.createdAt);
      if (statusDate >= weekAgo && statusDate <= today) {
        weekStatuses.push(status);
      } else if (statusDate < weekAgo) {
        hitOlder = true;
        break;
      }
    }
    if (hitOlder) break;
  }

  console.log(`[weekly-digest] Found ${weekStatuses.length} statuses from last 7 days (${weekAgo} to ${today})`);

  if (weekStatuses.length === 0) {
    console.log("[weekly-digest] No statuses this week, skipping digest.");
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
    return;
  }

  // Score by engagement, excluding bot's own replies (Update toots)
  const scored: { status: mastodon.v1.Status; activity: number }[] = [];

  for (const status of weekStatuses) {
    // Fetch context to get replies and filter out bot's own
    const context = await mastoClient.v1.statuses.$select(status.id).context.fetch();
    const engagement = calculateEngagement(status, context.descendants, me.id);

    if (engagement.totalInteractions > 0) {
      scored.push({ status, activity: engagement.totalInteractions });

      if (engagement.ownReplies > 0) {
        console.log(
          `[weekly-digest] Status ${status.id}: excluded ${engagement.ownReplies} own replies`
        );
      }
    }
  }

  // Sort by activity and take top 5
  scored.sort((a, b) => b.activity - a.activity);
  const topScored = scored.slice(0, 5);

  if (topScored.length === 0) {
    console.log("[weekly-digest] No statuses with external interactions, skipping digest.");
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
    return;
  }

  const entries: DigestEntry[] = topScored.map((s) => ({
    title: extractTitleFromStatus(s.status),
    link: s.status.url ?? null,
    score: s.activity,
  }));

  const tootText = formatDigestToot(
    entries,
    "Wichtigste Nachrichten der Woche\n\n",
    "\n\n#saarlandnews #news #wochenzusammenfassung",
  );
  console.log(`[weekly-digest] Posting digest (${tootText.length} chars):\n${tootText}`);

  await mastoClient.v1.statuses.create({
    status: tootText,
    visibility: "public",
    language: "de",
  });

  console.log("[weekly-digest] Digest posted successfully.");

  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();
