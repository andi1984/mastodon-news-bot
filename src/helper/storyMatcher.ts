import createClient from "./db.js";
import { tokenize, jaccardSimilarity } from "./similarity.js";
import {
  batchSemanticSimilarity,
  SemanticPair,
} from "./semanticSimilarity.js";
import { normalizeUrl } from "./normalizeUrl.js";
import { findStoryByUrl } from "./findStoryByUrl.js";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("../data/settings.json");

export interface StoryRecord {
  id: string;
  created_at: string;
  updated_at: string;
  article_count: number;
  tooted: boolean;
  toot_id: string | null;
  original_links: string[];
  primary_title: string;
  tokens: string[];
}

export interface ArticleForMatching {
  id: string;
  title: string;
  contentSnippet?: string;
  pubDate: string;
  feedKey?: string;
  link?: string;
}

// Configurable thresholds from settings
const STORY_SIMILARITY_THRESHOLD =
  (settings as any).story_similarity_threshold ?? 0.35;
const STORY_MAX_AGE_HOURS = (settings as any).story_max_age_hours ?? 72;
const MAX_STORY_TOKENS = 150; // Prevent unbounded token array growth

// AI matching thresholds - only use AI when token score is uncertain
// Raised thresholds to prevent false positives from regional token overlap
const AI_UNCERTAIN_LOW = 0.20; // Below this: definitely different stories
const AI_UNCERTAIN_HIGH = STORY_SIMILARITY_THRESHOLD; // Above this: definitely same story (untooted)
const SEMANTIC_MATCH_THRESHOLD = 0.8; // Semantic score needed to consider a match (stricter)

// Tooted stories need a higher token bar before accepting a follow-up assignment.
// A borderline Jaccard match (e.g. two police reports from the same district sharing
// boilerplate vocabulary) is acceptable for grouping unposted articles together, but
// not for threading a new article under an already-published toot - that creates a
// visibly wrong "Update" quote on an unrelated post.
// Borderline cases (STORY_SIMILARITY_THRESHOLD..STORY_FOLLOW_UP_THRESHOLD) are still
// forwarded to the AI semantic check so genuine follow-ups aren't silently dropped.
const STORY_FOLLOW_UP_THRESHOLD =
  (settings as any).story_follow_up_threshold ??
  STORY_SIMILARITY_THRESHOLD + 0.15;

/**
 * Find an existing story that matches the given article, or return null.
 * Uses AI for uncertain cases when budget allows.
 */
export async function findMatchingStory(
  article: ArticleForMatching,
  dbTable: string
): Promise<StoryRecord | null> {
  const db = createClient();

  // URL-based short-circuit: if this article's link is already in some
  // story's original_links, that's the matching story - regardless of
  // the story's age or the article's tokens. Catches re-ingested feed
  // items whose hash drifted cosmetically and whose story is >72h old
  // (outside the token-match window below).
  if (article.link) {
    const byUrl = await findStoryByUrl(db, article.link);
    if (byUrl) {
      console.log(
        `Article "${article.title.slice(0, 50)}..." matches story "${byUrl.primary_title.slice(0, 50)}..." (url match)`
      );
      return byUrl;
    }
  }

  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - STORY_MAX_AGE_HOURS);

  const { data: stories, error } = await db
    .from("stories")
    .select("*")
    .gt("updated_at", cutoff.toISOString())
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error(`Failed to fetch stories: ${error.message}`);
    return null;
  }

  if (!stories || stories.length === 0) {
    return null;
  }

  const articleText = article.contentSnippet
    ? `${article.title} ${article.contentSnippet.slice(0, 500)}`
    : article.title;
  const articleTokens = tokenize(articleText);

  let bestMatch: StoryRecord | null = null;
  let bestScore = 0;

  // Candidates for AI check (uncertain zone)
  const uncertainCandidates: { story: StoryRecord; score: number }[] = [];

  for (const story of stories as StoryRecord[]) {
    const storyTokens = new Set(story.tokens || []);
    const similarity = jaccardSimilarity(articleTokens, storyTokens);

    // Already-tooted stories require a higher token score for a direct match.
    // The gap between STORY_SIMILARITY_THRESHOLD and STORY_FOLLOW_UP_THRESHOLD
    // is sent to the AI uncertain zone so genuine follow-ups still get through.
    const definiteThreshold = story.tooted
      ? STORY_FOLLOW_UP_THRESHOLD
      : STORY_SIMILARITY_THRESHOLD;

    if (similarity >= definiteThreshold) {
      // Definite match based on tokens
      if (similarity > bestScore) {
        bestScore = similarity;
        bestMatch = story;
      }
    } else if (similarity >= AI_UNCERTAIN_LOW) {
      // Uncertain zone - candidate for AI check
      uncertainCandidates.push({ story, score: similarity });
    }
  }

  // If we have a definite match, return it
  if (bestMatch) {
    console.log(
      `Article "${article.title.slice(0, 50)}..." matches story "${bestMatch.primary_title.slice(0, 50)}..." (token score=${bestScore.toFixed(3)})`
    );
    return bestMatch;
  }

  // Check uncertain candidates with batch semantic similarity (top 3 by score).
  // Cap kept low to limit AI spend; the Jaccard pre-filter already catches
  // most true matches, and low-ranking uncertain candidates are rarely right.
  if (uncertainCandidates.length > 0) {
    uncertainCandidates.sort((a, b) => b.score - a.score);
    const toCheck = uncertainCandidates.slice(0, 3);

    // Build batch request
    const pairs: SemanticPair[] = toCheck.map((candidate, idx) => ({
      indexA: idx,
      indexB: idx, // We use indexA to track which candidate
      titleA: article.title,
      titleB: candidate.story.primary_title,
    }));

    const semanticResults = await batchSemanticSimilarity(pairs);

    // Find best semantic match above threshold
    let bestSemanticMatch: StoryRecord | null = null;
    let bestSemanticScore = 0;

    for (const result of semanticResults) {
      if (result.score >= SEMANTIC_MATCH_THRESHOLD && result.score > bestSemanticScore) {
        bestSemanticScore = result.score;
        bestSemanticMatch = toCheck[result.indexA].story;
      }
    }

    if (bestSemanticMatch) {
      const tokenScore = toCheck.find(c => c.story.id === bestSemanticMatch!.id)?.score ?? 0;
      console.log(
        `Article "${article.title.slice(0, 50)}..." matches story "${bestSemanticMatch.primary_title.slice(0, 50)}..." (semantic=${bestSemanticScore.toFixed(2)}, token=${tokenScore.toFixed(3)})`
      );
      return bestSemanticMatch;
    }
  }

  return null;
}

/**
 * Create a new story from an article.
 */
export async function createStory(
  article: ArticleForMatching
): Promise<string | null> {
  const db = createClient();

  const articleText = article.contentSnippet
    ? `${article.title} ${article.contentSnippet.slice(0, 500)}`
    : article.title;
  let tokens = Array.from(tokenize(articleText));
  if (tokens.length > MAX_STORY_TOKENS) {
    tokens = tokens.slice(0, MAX_STORY_TOKENS);
  }

  const now = new Date().toISOString();

  const { data, error } = await db
    .from("stories")
    .insert({
      primary_title: article.title,
      tokens,
      article_count: 1,
      tooted: false,
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .single();

  if (error) {
    console.error(`Failed to create story: ${error.message}`);
    return null;
  }

  return data.id;
}

/**
 * Add an article to an existing story - updates metadata only.
 * NOTE: We intentionally do NOT merge tokens to prevent "topic drift" where
 * a story accumulates tokens from multiple articles and starts matching
 * unrelated content. The story keeps only its original (primary) tokens.
 */
export async function addArticleToStory(
  storyId: string,
  article: ArticleForMatching
): Promise<void> {
  const db = createClient();

  // First get current story data
  const { data: story, error: fetchError } = await db
    .from("stories")
    .select("article_count")
    .eq("id", storyId)
    .single();

  if (fetchError || !story) {
    console.error(`Failed to fetch story ${storyId}: ${fetchError?.message}`);
    return;
  }

  // Update story - only increment count and timestamp, DO NOT merge tokens
  const { error: updateError } = await db
    .from("stories")
    .update({
      article_count: story.article_count + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", storyId);

  if (updateError) {
    console.error(`Failed to update story ${storyId}: ${updateError.message}`);
  }
}

/**
 * Assign a story_id to an article in the news table.
 */
export async function assignStoryToArticle(
  articleId: string,
  storyId: string,
  dbTable: string
): Promise<void> {
  const db = createClient();

  const { error } = await db
    .from(dbTable)
    .update({ story_id: storyId })
    .eq("id", articleId);

  if (error) {
    console.error(
      `Failed to assign story ${storyId} to article ${articleId}: ${error.message}`
    );
  }
}

/**
 * Process a batch of newly inserted articles - match to existing stories or create new ones.
 */
export async function processNewArticles(
  articles: ArticleForMatching[],
  dbTable: string
): Promise<void> {
  if (articles.length === 0) return;

  console.log(`Processing ${articles.length} articles for story assignment...`);

  // Cache of batch-created stories to avoid repeated DB queries
  // Maps story_id -> tokens (as Set)
  const batchStoryCache = new Map<string, Set<string>>();
  let newStoriesCreated = 0;

  for (const article of articles) {
    const existingStory = await findMatchingStory(article, dbTable);

    if (existingStory) {
      // Add to existing story
      await addArticleToStory(existingStory.id, article);
      await assignStoryToArticle(article.id, existingStory.id, dbTable);
      console.log(
        `  → Added to existing story: "${article.title.slice(0, 50)}..."`
      );
    } else {
      // Check if we already created a story for a similar article in this batch
      const articleText = article.contentSnippet
        ? `${article.title} ${article.contentSnippet.slice(0, 500)}`
        : article.title;
      const articleTokens = tokenize(articleText);

      let matchedBatchStory: string | null = null;
      let bestBatchScore = 0;

      // Check against cached batch stories (no DB queries needed)
      for (const [storyId, storyTokens] of batchStoryCache) {
        const similarity = jaccardSimilarity(articleTokens, storyTokens);

        if (similarity >= STORY_SIMILARITY_THRESHOLD && similarity > bestBatchScore) {
          bestBatchScore = similarity;
          matchedBatchStory = storyId;
        }
      }

      if (matchedBatchStory) {
        await addArticleToStory(matchedBatchStory, article);
        await assignStoryToArticle(article.id, matchedBatchStory, dbTable);

        // NOTE: Do NOT merge tokens - this prevents "topic drift" where
        // stories accumulate tokens and match unrelated articles

        console.log(
          `  → Added to batch story (score=${bestBatchScore.toFixed(3)}): "${article.title.slice(0, 50)}..."`
        );
      } else {
        // Create new story
        const newStoryId = await createStory(article);
        if (newStoryId) {
          await assignStoryToArticle(article.id, newStoryId, dbTable);
          // Cache the new story's tokens for future batch matching
          batchStoryCache.set(newStoryId, articleTokens);
          newStoriesCreated++;
          console.log(
            `  → Created new story: "${article.title.slice(0, 50)}..."`
          );
        }
      }
    }
  }

  console.log(
    `Story assignment complete: ${newStoriesCreated} new stories created, ${articles.length - newStoriesCreated} matched to existing`
  );
}

/**
 * Mark a story as tooted and store the toot ID and original links.
 * Original links are stored in normalized form so cosmetic URL variants
 * (trailing slash, utm params, fragment) don't defeat the follow-up
 * dedup on the next tooter tick.
 */
export async function markStoryTooted(
  storyId: string,
  tootId: string,
  originalLinks: string[] = []
): Promise<void> {
  const db = createClient();

  const normalized = Array.from(
    new Set(
      originalLinks
        .map((l) => normalizeUrl(l))
        .filter((l): l is string => !!l)
    )
  );

  const { error } = await db
    .from("stories")
    .update({
      tooted: true,
      toot_id: tootId,
      original_links: normalized,
    })
    .eq("id", storyId);

  if (error) {
    console.error(`Failed to mark story ${storyId} as tooted: ${error.message}`);
  }
}

/**
 * Get the toot ID for a story (for threading replies).
 */
export async function getStoryTootId(storyId: string): Promise<string | null> {
  const db = createClient();

  const { data, error } = await db
    .from("stories")
    .select("toot_id")
    .eq("id", storyId)
    .single();

  if (error || !data) {
    return null;
  }

  return data.toot_id;
}

/**
 * Get untooted stories with their articles.
 */
export async function getUntootedStories(
  dbTable: string,
  limit = 50
): Promise<Map<string, { story: StoryRecord; articleIds: string[] }>> {
  const db = createClient();

  // Get untooted stories from the last 24 hours
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 24);

  const { data: stories, error: storyError } = await db
    .from("stories")
    .select("*")
    .eq("tooted", false)
    .gt("created_at", cutoff.toISOString())
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (storyError || !stories) {
    console.error(`Failed to fetch untooted stories: ${storyError?.message}`);
    return new Map();
  }

  const result = new Map<string, { story: StoryRecord; articleIds: string[] }>();

  for (const story of stories as StoryRecord[]) {
    // Get article IDs for this story
    const { data: articles, error: articleError } = await db
      .from(dbTable)
      .select("id")
      .eq("story_id", story.id);

    if (!articleError && articles) {
      result.set(story.id, {
        story,
        articleIds: articles.map((a: { id: string }) => a.id),
      });
    }
  }

  return result;
}
