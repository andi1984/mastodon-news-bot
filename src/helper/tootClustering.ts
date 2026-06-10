import { jaccardSimilarity, tokenize } from "./similarity.js";

/**
 * Clustering helpers for the story-thread-fixer job.
 *
 * The fixer previously used transitive union-find clustering: if A~B and B~C
 * passed the threshold, A, B and C all landed in one cluster even when A and C
 * were about completely different events. Over 100 toots sharing regional
 * vocabulary ("Saarbrücken", "Polizei", ...) the chains connected unrelated
 * topics, and the fixer then deleted those toots and re-posted them as
 * "Update:" replies under one primary — producing threads with dozens of
 * unrelated updates.
 *
 * This module replaces that with primary-anchored clustering: a toot only
 * joins a cluster if it is similar to the cluster's PRIMARY (oldest) toot.
 * It also excludes update posts (the bot's own follow-up quote posts) from
 * clustering entirely, so the fixer can never re-thread an existing update.
 */

export interface ClusterableToot {
  id: string;
  plainText: string;
  tokens: Set<string>;
  createdAt: Date;
  hasInteractions: boolean;
}

export interface TootCluster<T extends ClusterableToot> {
  primary: T;
  duplicates: T[];
  avgSimilarity: number;
}

export interface ClusterOptions {
  /** Minimum jaccard similarity to the cluster primary. */
  threshold: number;
  /** Maximum age difference (hours) between a toot and the cluster primary. */
  timeWindowHours: number;
  /** Maximum total toots per cluster (primary + duplicates). */
  maxClusterSize: number;
}

// The bot's own follow-up posts: feed-tooter quote posts ("🔗 Update: ..." /
// "🔗 Update (📍2 Quellen): ...") and legacy fixer replies ("Update:\n...").
// These are quote posts, not replies, so excludeReplies does NOT filter them
// out of the fixer's timeline fetch — they must never be clustered, deleted
// or re-threaded.
const UPDATE_POST_PATTERN = /^(?:🔗\s*)?Update\s*(?::|\()/u;

export function isUpdatePost(plainText: string): boolean {
  return UPDATE_POST_PATTERN.test(plainText.trim());
}

// Repeats until a fixpoint: a single-pass tag strip leaves nested markup
// like "<scr<script>ipt>" partially intact (CodeQL js/incomplete-multi-
// character-sanitization).
function removeTags(text: string): string {
  let previous: string;
  let out = text;
  do {
    previous = out;
    out = out
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/p>/gi, " ")
      .replace(/<[^>]*>/g, " ");
  } while (out !== previous);
  return out;
}

// Tags are stripped again AFTER entity unescaping: escaped markup like
// "&lt;script&gt;" turns into a real tag only once "&lt;"/"&gt;" are
// resolved, and headline text ends up in posted toots. "&amp;" is unescaped
// last so it cannot feed a second entity round (CodeQL js/double-escaping).
export function stripHtml(html: string): string {
  const unescaped = removeTags(html)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
  return removeTags(unescaped).replace(/\s+/g, " ").trim();
}

export function extractHeadline(text: string): string {
  const lines = text.split(/[\n\r]+/);
  const headline = lines[0] || text;
  return headline
    .replace(/#\w+/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\bQuellen:.*$/, "")
    .trim();
}

export function extractLinks(text: string): string[] {
  const matches = text.match(/https?:\/\/\S+/g) || [];
  // Filter out mastodon URLs (status links, not news links)
  return matches.filter(
    (url) =>
      !url.includes("mastodon") &&
      !url.includes("social.") &&
      !url.includes("/@")
  );
}

export function parseTootContent(content: string): {
  plainText: string;
  headline: string;
  tokens: Set<string>;
  links: string[];
} {
  const plainText = stripHtml(content);
  const headline = extractHeadline(plainText);
  return {
    plainText,
    headline,
    tokens: tokenize(headline),
    links: extractLinks(plainText),
  };
}

/**
 * Primary-anchored clustering. Toots are processed oldest-first; each toot
 * joins the best existing cluster whose primary it is similar to (within the
 * time window and size cap), otherwise it starts its own cluster. Only
 * clusters with at least one duplicate and no interactions are returned,
 * sorted by average similarity (most confident first).
 */
export function clusterToots<T extends ClusterableToot>(
  toots: T[],
  options: ClusterOptions
): TootCluster<T>[] {
  const windowMs = options.timeWindowHours * 60 * 60 * 1000;

  const sorted = toots
    .filter((t) => !isUpdatePost(t.plainText))
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  type WorkingCluster = { primary: T; duplicates: T[]; similarities: number[] };
  const clusters: WorkingCluster[] = [];

  for (const toot of sorted) {
    let best: { cluster: WorkingCluster; score: number } | null = null;

    for (const cluster of clusters) {
      if (1 + cluster.duplicates.length >= options.maxClusterSize) continue;

      const timeDiff = Math.abs(
        toot.createdAt.getTime() - cluster.primary.createdAt.getTime()
      );
      if (timeDiff > windowMs) continue;

      const score = jaccardSimilarity(toot.tokens, cluster.primary.tokens);
      if (score < options.threshold) continue;

      if (!best || score > best.score) {
        best = { cluster, score };
      }
    }

    if (best) {
      best.cluster.duplicates.push(toot);
      best.cluster.similarities.push(best.score);
    } else {
      clusters.push({ primary: toot, duplicates: [], similarities: [] });
    }
  }

  return clusters
    .filter((c) => c.duplicates.length > 0)
    .filter(
      (c) =>
        !c.primary.hasInteractions &&
        !c.duplicates.some((d) => d.hasInteractions)
    )
    .map((c) => ({
      primary: c.primary,
      duplicates: c.duplicates,
      avgSimilarity:
        c.similarities.reduce((sum, s) => sum + s, 0) / c.similarities.length,
    }))
    .sort((a, b) => b.avgSimilarity - a.avgSimilarity);
}
