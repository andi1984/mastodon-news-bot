import type { FeedItem } from "./rssFeedItem2Toot.js";
import {
  batchSemanticSimilarity,
  SemanticPair,
} from "./semanticSimilarity.js";

export type ClusterArticle = {
  id: string;
  article: FeedItem;
  feedKey: string | undefined;
  pubDate: string | undefined;
  score: number;
};

// Thresholds for hybrid matching
const JACCARD_DEFINITE_MATCH = 0.4; // Above this: definitely same story (no AI needed)
const JACCARD_UNCERTAIN_LOW = 0.12; // Below this: definitely different (no AI needed)
const SEMANTIC_MATCH_THRESHOLD = 0.7; // Semantic score needed to cluster

// Common German stopwords
const STOPWORDS = new Set([
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "einem",
  "einen", "eines", "und", "oder", "aber", "doch", "wenn", "weil", "dass",
  "als", "wie", "auch", "noch", "schon", "nur", "sehr", "mehr", "nicht",
  "kein", "keine", "keiner", "keinem", "keinen", "keines",
  "ich", "du", "er", "sie", "es", "wir", "ihr", "man",
  "mich", "mir", "dich", "dir", "sich", "uns", "euch", "ihm", "ihn",
  "ist", "sind", "war", "hat", "haben", "wird", "werden", "wurde", "worden",
  "kann", "muss", "soll", "will", "darf", "mag",
  "von", "mit", "aus", "auf", "für", "bei", "nach", "vor", "über", "unter",
  "durch", "gegen", "ohne", "bis", "seit", "während",
  "zum", "zur", "vom", "beim", "ins", "ans", "aufs",
  "hier", "dort", "dann", "nun", "jetzt", "heute", "gestern", "morgen",
  "was", "wer", "wen", "wem", "wessen", "welch",
  "diese", "dieser", "diesem", "diesen", "dieses",
  "jede", "jeder", "jedem", "jeden", "jedes",
  "alle", "allem", "allen", "aller", "alles",
  "so", "da", "zu", "an", "in", "im", "am",
]);

export function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  // Remove punctuation but preserve umlauts (äöü), ß, and accented chars
  const cleaned = lower.replace(/[^\p{L}\p{N}\s]/gu, " ");
  const words = cleaned.split(/\s+/).filter((w) => w.length >= 3);
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function timeProximityScore(dateA: Date, dateB: Date): number {
  const diffMs = Math.abs(dateA.getTime() - dateB.getTime());
  const diffHours = diffMs / (1000 * 60 * 60);

  if (diffHours <= 2) return 1.0;
  if (diffHours >= 12) return 0.0;

  // Linear decay from 1.0 at 2h to 0.0 at 12h
  return 1.0 - (diffHours - 2) / 10;
}

export function storySimilarity(
  titleA: string,
  titleB: string,
  dateA: Date,
  dateB: Date,
  contentA?: string,
  contentB?: string
): number {
  const textA = contentA ? `${titleA} ${contentA}` : titleA;
  const textB = contentB ? `${titleB} ${contentB}` : titleB;
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);
  const jaccard = jaccardSimilarity(tokensA, tokensB);
  const timeSim = timeProximityScore(dateA, dateB);
  return 0.7 * jaccard + 0.3 * timeSim;
}

export async function clusterArticles(
  articles: ClusterArticle[],
  threshold = 0.4,
  useSemanticMatching = true
): Promise<Map<string, ClusterArticle[]>> {
  const n = articles.length;
  // Union-Find
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Collect pairs for semantic matching (uncertain zone)
  const uncertainPairs: SemanticPair[] = [];

  // First pass: Jaccard similarity (fast, free)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Skip same-feed pairs — never cluster articles from the same feed
      if (
        articles[i].feedKey &&
        articles[j].feedKey &&
        articles[i].feedKey === articles[j].feedKey
      ) {
        continue;
      }

      const titleA = articles[i].article.title || "";
      const titleB = articles[j].article.title || "";
      const dateA = articles[i].pubDate
        ? new Date(articles[i].pubDate!)
        : new Date();
      const dateB = articles[j].pubDate
        ? new Date(articles[j].pubDate!)
        : new Date();
      // Include up to 500 chars of the article description to catch same-story
      // articles whose headlines are phrased very differently across sources.
      const descA = (articles[i].article.contentSnippet ?? "").slice(0, 500);
      const descB = (articles[j].article.contentSnippet ?? "").slice(0, 500);

      const sim = storySimilarity(titleA, titleB, dateA, dateB, descA, descB);

      if (sim >= JACCARD_DEFINITE_MATCH) {
        // Definite match - cluster immediately
        union(i, j);
      } else if (useSemanticMatching && sim >= JACCARD_UNCERTAIN_LOW) {
        // Uncertain zone - queue for semantic matching
        uncertainPairs.push({
          indexA: i,
          indexB: j,
          titleA,
          titleB,
        });
      }
      // Below JACCARD_UNCERTAIN_LOW: definitely different, skip
    }
  }

  // Second pass: Semantic matching for uncertain pairs (uses AI budget)
  if (uncertainPairs.length > 0 && useSemanticMatching) {
    console.log(
      `Clustering: ${uncertainPairs.length} uncertain pairs queued for semantic matching`
    );

    // Batch in groups of 20 to keep API calls manageable
    const BATCH_SIZE = 20;
    for (let start = 0; start < uncertainPairs.length; start += BATCH_SIZE) {
      const batch = uncertainPairs.slice(start, start + BATCH_SIZE);
      const results = await batchSemanticSimilarity(batch);

      for (const result of results) {
        if (result.score >= SEMANTIC_MATCH_THRESHOLD) {
          union(result.indexA, result.indexB);
          console.log(
            `Semantic match: "${articles[result.indexA].article.title?.slice(0, 40)}..." ↔ "${articles[result.indexB].article.title?.slice(0, 40)}..." (score=${result.score.toFixed(2)})`
          );
        }
      }

      // If batch returned empty (budget exceeded), stop trying
      if (results.length === 0 && batch.length > 0) {
        console.log(
          "Clustering: semantic matching unavailable, using Jaccard-only for remaining pairs"
        );
        break;
      }
    }
  }

  // Group by root
  const clusters = new Map<string, ClusterArticle[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const key = articles[root].id;
    if (!clusters.has(key)) {
      clusters.set(key, []);
    }
    clusters.get(key)!.push(articles[i]);
  }

  return clusters;
}

export function pickPrimaryArticle(
  cluster: ClusterArticle[],
  feedPriorities: Record<string, number>
): ClusterArticle {
  return cluster.slice().sort((a, b) => {
    const prioA = a.feedKey ? (feedPriorities[a.feedKey] ?? 0.5) : 0.5;
    const prioB = b.feedKey ? (feedPriorities[b.feedKey] ?? 0.5) : 0.5;
    // Higher priority first
    if (prioB !== prioA) return prioB - prioA;
    // Tie-break: fresher first
    const dateA = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const dateB = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return dateB - dateA;
  })[0];
}

export function isBreakingNews(
  cluster: ClusterArticle[],
  timeWindowHours = 2,
  minSources = 3
): boolean {
  // Collect unique feeds
  const uniqueFeeds = new Set(
    cluster.filter((a) => a.feedKey).map((a) => a.feedKey!)
  );
  if (uniqueFeeds.size < minSources) return false;

  // Get all publication dates (sorted)
  const dates = cluster
    .filter((a) => a.pubDate)
    .map((a) => new Date(a.pubDate!).getTime())
    .sort((a, b) => a - b);

  if (dates.length < minSources) return false;

  // Sliding window: check if any window of minSources articles fits within timeWindowHours
  const windowMs = timeWindowHours * 60 * 60 * 1000;
  for (let i = 0; i <= dates.length - minSources; i++) {
    if (dates[i + minSources - 1] - dates[i] <= windowMs) {
      return true;
    }
  }

  return false;
}
