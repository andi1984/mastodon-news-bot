import createClient from "./db.js";
import { tokenize, jaccardSimilarity } from "./similarity.js";
import { hasAiBudget, logAiUsage } from "./costTracker.js";
import Anthropic from "@anthropic-ai/sdk";

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
  primary_title: string;
  tokens: string[];
}

export interface ArticleForMatching {
  id: string;
  title: string;
  contentSnippet?: string;
  pubDate: string;
  feedKey?: string;
}

// Configurable thresholds from settings
const STORY_SIMILARITY_THRESHOLD =
  (settings as any).story_similarity_threshold ?? 0.35;
const STORY_MAX_AGE_HOURS = (settings as any).story_max_age_hours ?? 72;

// AI matching thresholds - only use AI when token score is uncertain
const AI_UNCERTAIN_LOW = 0.15; // Below this: definitely different stories
const AI_UNCERTAIN_HIGH = STORY_SIMILARITY_THRESHOLD; // Above this: definitely same story

const AI_SIMILARITY_PROMPT = `Du vergleichst zwei Nachrichtenartikel und entscheidest, ob sie über dasselbe Ereignis berichten.

Gleiche Geschichte = selbes Ereignis, selber Ort, selbe Personen (auch wenn unterschiedlich formuliert)
Verschiedene Geschichte = anderes Ereignis, anderer Ort, oder anderes Thema

Antworte NUR mit "same" oder "different". Keine Erklärung.`;

/**
 * Use AI to determine if two articles are about the same story.
 * Only called when token-based matching is uncertain.
 */
async function aiCheckSimilarity(
  articleTitle: string,
  storyTitle: string
): Promise<boolean | null> {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return null;

  try {
    if (!(await hasAiBudget())) {
      console.log("Story AI: budget exceeded, skipping AI check");
      return null;
    }

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system: AI_SIMILARITY_PROMPT,
      messages: [
        {
          role: "user",
          content: `Artikel 1: "${articleTitle}"\nArtikel 2: "${storyTitle}"`,
        },
      ],
    });

    logAiUsage(
      "story_similarity",
      response.usage.input_tokens,
      response.usage.output_tokens
    );

    const text =
      response.content[0].type === "text"
        ? response.content[0].text.toLowerCase().trim()
        : "";

    const isSame = text.includes("same");
    console.log(
      `Story AI: "${articleTitle.slice(0, 40)}..." vs "${storyTitle.slice(0, 40)}..." → ${isSame ? "SAME" : "DIFFERENT"}`
    );

    return isSame;
  } catch (err) {
    console.error(`Story AI check failed: ${err}`);
    return null;
  }
}

/**
 * Find an existing story that matches the given article, or return null.
 * Uses AI for uncertain cases when budget allows.
 */
export async function findMatchingStory(
  article: ArticleForMatching,
  dbTable: string
): Promise<StoryRecord | null> {
  const db = createClient();

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

    if (similarity >= STORY_SIMILARITY_THRESHOLD) {
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

  // Check uncertain candidates with AI (limit to top 3 by score to save budget)
  if (uncertainCandidates.length > 0) {
    uncertainCandidates.sort((a, b) => b.score - a.score);
    const toCheck = uncertainCandidates.slice(0, 3);

    for (const candidate of toCheck) {
      const aiResult = await aiCheckSimilarity(
        article.title,
        candidate.story.primary_title
      );

      if (aiResult === true) {
        console.log(
          `Article "${article.title.slice(0, 50)}..." matches story "${candidate.story.primary_title.slice(0, 50)}..." (AI confirmed, token score=${candidate.score.toFixed(3)})`
        );
        return candidate.story;
      }
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
  const tokens = Array.from(tokenize(articleText));

  const { data, error } = await db
    .from("stories")
    .insert({
      primary_title: article.title,
      tokens,
      article_count: 1,
      tooted: false,
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
 * Add an article to an existing story - updates token set and metadata.
 */
export async function addArticleToStory(
  storyId: string,
  article: ArticleForMatching
): Promise<void> {
  const db = createClient();

  // First get current story data
  const { data: story, error: fetchError } = await db
    .from("stories")
    .select("tokens, article_count")
    .eq("id", storyId)
    .single();

  if (fetchError || !story) {
    console.error(`Failed to fetch story ${storyId}: ${fetchError?.message}`);
    return;
  }

  // Merge tokens
  const articleText = article.contentSnippet
    ? `${article.title} ${article.contentSnippet.slice(0, 500)}`
    : article.title;
  const newTokens = tokenize(articleText);
  const existingTokens = new Set(story.tokens || []);

  for (const token of newTokens) {
    existingTokens.add(token);
  }

  // Update story
  const { error: updateError } = await db
    .from("stories")
    .update({
      tokens: Array.from(existingTokens),
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

  // Track stories we've already matched in this batch to avoid duplicate matching
  const batchStoryMap = new Map<string, string>(); // article id -> story_id

  for (const article of articles) {
    const existingStory = await findMatchingStory(article, dbTable);

    if (existingStory) {
      // Add to existing story
      await addArticleToStory(existingStory.id, article);
      await assignStoryToArticle(article.id, existingStory.id, dbTable);
    } else {
      // Check if we already created a story for a similar article in this batch
      let matchedBatchStory: string | null = null;

      for (const [, storyId] of batchStoryMap) {
        const db = createClient();
        const { data } = await db
          .from("stories")
          .select("*")
          .eq("id", storyId)
          .single();

        if (data) {
          const storyTokens = new Set((data as StoryRecord).tokens || []);
          const articleText = article.contentSnippet
            ? `${article.title} ${article.contentSnippet.slice(0, 500)}`
            : article.title;
          const articleTokens = tokenize(articleText);
          const similarity = jaccardSimilarity(articleTokens, storyTokens);

          if (similarity >= STORY_SIMILARITY_THRESHOLD) {
            matchedBatchStory = storyId;
            break;
          }
        }
      }

      if (matchedBatchStory) {
        await addArticleToStory(matchedBatchStory, article);
        await assignStoryToArticle(article.id, matchedBatchStory, dbTable);
      } else {
        // Create new story
        const newStoryId = await createStory(article);
        if (newStoryId) {
          await assignStoryToArticle(article.id, newStoryId, dbTable);
          batchStoryMap.set(article.id, newStoryId);
        }
      }
    }
  }

  console.log(
    `Story assignment complete: ${batchStoryMap.size} new stories created`
  );
}

/**
 * Mark a story as tooted and store the toot ID.
 */
export async function markStoryTooted(
  storyId: string,
  tootId: string
): Promise<void> {
  const db = createClient();

  const { error } = await db
    .from("stories")
    .update({
      tooted: true,
      toot_id: tootId,
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
