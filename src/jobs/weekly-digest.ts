import "dotenv/config";
import { parentPort } from "node:worker_threads";
import getInstance from "../helper/login.js";
import {
  extractTitleFromStatus,
  formatDigestToot,
  DigestEntry,
} from "../helper/digestFormatter.js";
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

  // Score by engagement, only keep articles with at least 1 interaction
  const scored = weekStatuses
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
    console.log("[weekly-digest] No statuses with interactions, skipping digest.");
    if (parentPort) parentPort.postMessage("done");
    else process.exit(0);
    return;
  }

  const entries: DigestEntry[] = scored.map((s) => ({
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
