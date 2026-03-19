/**
 * CLI tool to manage RSS feeds in settings.json.
 *
 * Usage:
 *   npm run manage-feeds -- list
 *   npm run manage-feeds -- add --key my-feed --url "https://example.com/feed.xml" --hashtags tag1,tag2
 *   npm run manage-feeds -- remove --key my-feed
 */
import { parseArgs } from "node:util";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Parser from "rss-parser";
import https from "node:https";

const settingsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/data/settings.json"
);

function loadSettings() {
  const content = readFileSync(settingsPath, "utf-8");
  return JSON.parse(content);
}

function saveSettings(settings: Record<string, unknown>) {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function calculatePriority(items: Parser.Item[]): {
  priority: number;
  postsPerDay: number;
} {
  const dates = items
    .map((item) => (item.pubDate ? new Date(item.pubDate).getTime() : NaN))
    .filter((d) => !isNaN(d))
    .sort((a, b) => a - b);

  if (dates.length < 2) {
    return { priority: 0.5, postsPerDay: 0 };
  }

  const oldest = dates[0];
  const newest = dates[dates.length - 1];
  const spanDays = (newest - oldest) / (1000 * 60 * 60 * 24);

  if (spanDays < 0.01) {
    // All items published at roughly the same time — treat as moderate volume
    return { priority: 0.5, postsPerDay: dates.length };
  }

  const postsPerDay = dates.length / spanDays;
  const priority = Math.min(
    1.0,
    Math.max(0.1, 1.0 - Math.log10(postsPerDay) / Math.log10(20))
  );

  return {
    priority: Math.round(priority * 10) / 10,
    postsPerDay: Math.round(postsPerDay * 10) / 10,
  };
}

async function addFeed(key: string, url: string, hashtags: string[]) {
  const settings = loadSettings();

  // Validate key format
  if (!/^[a-z0-9-]+$/.test(key)) {
    console.error(
      `Error: Feed key "${key}" is invalid. Use only lowercase letters, digits, and hyphens.`
    );
    process.exit(1);
  }

  // Check for duplicate key
  if (settings.feeds[key]) {
    console.error(
      `Error: Feed key "${key}" already exists with URL: ${settings.feeds[key]}`
    );
    process.exit(1);
  }

  // Check for duplicate URL
  const existingKey = Object.entries(settings.feeds).find(
    ([, v]) => v === url
  );
  if (existingKey) {
    console.error(
      `Error: URL already registered under key "${existingKey[0]}".`
    );
    process.exit(1);
  }

  // Fetch and parse the feed to verify it works
  console.log(`Fetching feed: ${url} ...`);

  // Create parser with custom request options to handle SSL certificate issues
  const parser = new Parser({
    requestOptions: {
      // Use a custom agent that allows self-signed or problematic certificates
      agent: url.startsWith("https://")
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined,
    },
  });

  let feed: Parser.Output<Record<string, unknown>>;
  try {
    feed = await parser.parseURL(url);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("certificate") || msg.includes("SSL") || msg.includes("CERT")) {
      console.error(`Error: SSL certificate issue — ${msg}`);
      console.error("Hint: The feed server has a certificate problem. If you trust this source, the feed may still work at runtime.");
    } else if (msg.includes("ENOTFOUND") || msg.includes("getaddrinfo")) {
      console.error(`Error: Could not resolve hostname — check the URL is correct.`);
    } else if (msg.includes("ETIMEDOUT") || msg.includes("timeout")) {
      console.error(`Error: Connection timed out — the server may be slow or unreachable.`);
    } else {
      console.error(`Error: Could not fetch/parse feed — ${msg}`);
    }
    process.exit(1);
  }

  console.log(`Feed title: ${feed.title ?? "(none)"}`);
  console.log(`Items in feed: ${feed.items.length}`);

  // Auto-calculate priority
  const { priority, postsPerDay } = calculatePriority(feed.items);
  console.log(`Estimated posting frequency: ~${postsPerDay} posts/day`);
  console.log(`Auto-calculated priority: ${priority}`);

  // Write all sections atomically
  settings.feeds[key] = url;
  settings.feed_priorities[key] = priority;
  if (hashtags.length > 0) {
    settings.feed_specific_hashtags = settings.feed_specific_hashtags ?? {};
    settings.feed_specific_hashtags[key] = hashtags;
  }

  saveSettings(settings);
  console.log(`\nFeed "${key}" added successfully.`);
}

async function removeFeed(key: string) {
  const settings = loadSettings();

  if (!settings.feeds[key]) {
    console.error(`Error: Feed key "${key}" not found.`);
    process.exit(1);
  }

  delete settings.feeds[key];
  delete settings.feed_priorities[key];
  if (settings.feed_specific_hashtags) {
    delete settings.feed_specific_hashtags[key];
  }

  saveSettings(settings);
  console.log(`Feed "${key}" removed.`);
  console.log(
    "Note: Existing database entries for this feed will age out naturally."
  );
}

function listFeeds() {
  const settings = loadSettings();
  const keys = Object.keys(settings.feeds);

  if (keys.length === 0) {
    console.log("No feeds configured.");
    return;
  }

  console.log(`\n${"Key".padEnd(30)} ${"Priority".padEnd(10)} ${"Hashtags".padEnd(30)} URL`);
  console.log("-".repeat(100));

  for (const key of keys) {
    const url = settings.feeds[key];
    const priority = settings.feed_priorities?.[key] ?? "—";
    const hashtags =
      settings.feed_specific_hashtags?.[key]?.join(", ") ?? "";
    console.log(
      `${key.padEnd(30)} ${String(priority).padEnd(10)} ${hashtags.padEnd(30)} ${url}`
    );
  }

  console.log(`\nTotal: ${keys.length} feeds`);
}

(async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      key: { type: "string" },
      url: { type: "string" },
      hashtags: { type: "string" },
    },
  });

  const command = positionals[0];

  switch (command) {
    case "list":
      listFeeds();
      break;

    case "add": {
      if (!values.key || !values.url) {
        console.error("Usage: manage-feeds add --key <key> --url <url> [--hashtags tag1,tag2]");
        process.exit(1);
      }
      const hashtags = values.hashtags
        ? values.hashtags.split(",").map((t) => t.trim()).filter(Boolean)
        : [];
      await addFeed(values.key, values.url, hashtags);
      break;
    }

    case "remove": {
      if (!values.key) {
        console.error("Usage: manage-feeds remove --key <key>");
        process.exit(1);
      }
      await removeFeed(values.key);
      break;
    }

    default:
      console.error("Usage: manage-feeds <list|add|remove> [options]");
      console.error("  list                           List all configured feeds");
      console.error("  add --key <k> --url <u>        Add a new feed");
      console.error("  remove --key <k>               Remove a feed");
      process.exit(1);
  }
})();
