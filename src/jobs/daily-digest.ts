import "dotenv/config";
import { parentPort } from "node:worker_threads";
import getInstance from "../helper/login.js";
import {
  extractTitleFromStatus,
  formatDigestToot,
  DigestEntry,
} from "../helper/digestFormatter.js";
import type { mastodon } from "masto";

function getTodayBerlin(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
}

function getDateBerlin(date: string): string {
  return new Date(date).toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
}

(async () => {
  const mastoClient = await getInstance();
  const me = await mastoClient.v1.accounts.verifyCredentials();
  console.log(`[daily-digest] Logged in as @${me.acct} (id: ${me.id})`);

  const today = getTodayBerlin();
  const todayStatuses: mastodon.v1.Status[] = [];

  // Paginate through own statuses, collecting today's original posts
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
  }

  console.log(`[daily-digest] Found ${todayStatuses.length} statuses from today (${today})`);

  if (todayStatuses.length === 0) {
    console.log("[daily-digest] No statuses today, skipping digest.");
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
    return;
  }

  // Score by engagement, only keep articles with at least 1 interaction
  const scored = todayStatuses
    .map((status) => ({
      status,
      activity:
        (status.reblogsCount ?? 0) +
        (status.favouritesCount ?? 0) +
        (status.repliesCount ?? 0),
    }))
    .filter((s) => s.activity > 0)
    .sort((a, b) => b.activity - a.activity)
    .slice(0, 5);

  if (scored.length === 0) {
    console.log("[daily-digest] No statuses with interactions, skipping digest.");
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
    return;
  }

  const entries: DigestEntry[] = scored.map((s) => ({
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

  if (parentPort) parentPort.postMessage("done");
  else process.exit(0);
})();
