import createClient from "./db.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");

const adaptiveSettings = (settings as any).adaptive_tooting ?? {};
const COOLDOWN_HOURS = adaptiveSettings.cooldown_hours ?? 1;
const PIN_DURATION_HOURS = adaptiveSettings.pin_duration_hours ?? 48;

type CooldownValue = {
  timestamp: string;
  reason: string;
  toot_id?: string;
};

type PinnedTootValue = {
  toot_id: string;
  pinned_at: string;
};

type LastTootValue = {
  timestamp: string;
};

/**
 * Check if the bot is currently in cooldown (after posting breaking news).
 */
export async function isInCooldown(): Promise<{ inCooldown: boolean; reason?: string }> {
  const db = createClient();

  const { data, error } = await db
    .from("bot_state")
    .select("value")
    .eq("key", "cooldown_until")
    .single();

  if (error || !data) {
    return { inCooldown: false };
  }

  const cooldown = data.value as CooldownValue;
  const cooldownUntil = new Date(cooldown.timestamp);

  if (cooldownUntil > new Date()) {
    return { inCooldown: true, reason: cooldown.reason };
  }

  return { inCooldown: false };
}

/**
 * Set a cooldown period after posting breaking news.
 */
export async function setCooldown(reason: string, tootId?: string): Promise<void> {
  const db = createClient();

  const cooldownUntil = new Date();
  cooldownUntil.setHours(cooldownUntil.getHours() + COOLDOWN_HOURS);

  const value: CooldownValue = {
    timestamp: cooldownUntil.toISOString(),
    reason,
    toot_id: tootId,
  };

  await db.from("bot_state").upsert(
    {
      key: "cooldown_until",
      value,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );

  console.log(`Cooldown set until ${cooldownUntil.toISOString()} (reason: ${reason})`);
}

/**
 * Clear any active cooldown.
 */
export async function clearCooldown(): Promise<void> {
  const db = createClient();
  await db.from("bot_state").delete().eq("key", "cooldown_until");
}

/**
 * Record the timestamp of the last toot (for rate limiting normal posts).
 */
export async function recordLastToot(): Promise<void> {
  const db = createClient();

  const value: LastTootValue = {
    timestamp: new Date().toISOString(),
  };

  await db.from("bot_state").upsert(
    {
      key: "last_toot_at",
      value,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );
}

/**
 * Get minutes since the last toot.
 */
export async function getMinutesSinceLastToot(): Promise<number> {
  const db = createClient();

  const { data, error } = await db
    .from("bot_state")
    .select("value")
    .eq("key", "last_toot_at")
    .single();

  if (error || !data) {
    // No record = never tooted = a long time ago
    return Infinity;
  }

  const lastToot = data.value as LastTootValue;
  const lastTootTime = new Date(lastToot.timestamp);
  const minutesAgo = (Date.now() - lastTootTime.getTime()) / (1000 * 60);

  return minutesAgo;
}

/**
 * Record a pinned toot for auto-unpinning later.
 */
export async function recordPinnedToot(tootId: string): Promise<void> {
  const db = createClient();

  const value: PinnedTootValue = {
    toot_id: tootId,
    pinned_at: new Date().toISOString(),
  };

  await db.from("bot_state").upsert(
    {
      key: `pinned_toot_${tootId}`,
      value,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );

  console.log(`Recorded pinned toot ${tootId} for auto-unpin in ${PIN_DURATION_HOURS}h`);
}

/**
 * Get all pinned toots that have exceeded the pin duration.
 */
export async function getExpiredPins(): Promise<string[]> {
  const db = createClient();

  const { data, error } = await db
    .from("bot_state")
    .select("key, value")
    .like("key", "pinned_toot_%");

  if (error || !data) {
    return [];
  }

  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - PIN_DURATION_HOURS);

  const expiredTootIds: string[] = [];

  for (const row of data) {
    const pinned = row.value as PinnedTootValue;
    const pinnedAt = new Date(pinned.pinned_at);

    if (pinnedAt < cutoff) {
      expiredTootIds.push(pinned.toot_id);
    }
  }

  return expiredTootIds;
}

/**
 * Remove a pinned toot record after unpinning.
 */
export async function removePinRecord(tootId: string): Promise<void> {
  const db = createClient();
  await db.from("bot_state").delete().eq("key", `pinned_toot_${tootId}`);
}

/**
 * Clean up expired state entries (cooldowns, etc.).
 */
export async function cleanupExpiredState(): Promise<number> {
  const db = createClient();

  // Delete cooldowns that have passed
  const { data: cooldownData } = await db
    .from("bot_state")
    .select("key, value")
    .eq("key", "cooldown_until");

  let cleaned = 0;

  if (cooldownData && cooldownData.length > 0) {
    const cooldown = cooldownData[0].value as CooldownValue;
    if (new Date(cooldown.timestamp) < new Date()) {
      await db.from("bot_state").delete().eq("key", "cooldown_until");
      cleaned++;
    }
  }

  return cleaned;
}
