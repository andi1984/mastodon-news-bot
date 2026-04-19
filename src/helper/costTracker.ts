import createClient from "./db.js";

// Pricing for claude-haiku-4-5-20251001
const HAIKU_INPUT_COST_PER_M = 0.8;
const HAIKU_OUTPUT_COST_PER_M = 4.0;

// Hard daily limit (15 cents) - can be overridden by AI_DAILY_COST_LIMIT_USD env var.
// Sized so the monthly bill stays under ~€4.50 even at full daily usage.
export const DEFAULT_DAILY_LIMIT_USD = 0.15;

// Priority levels for AI features
export const AI_PRIORITY = {
  CRITICAL: 0, // Direct user interaction (question_answerer)
  HIGH: 1,     // Core functionality (semantic_similarity)
  MEDIUM: 2,   // Nice-to-have scoring (regional_relevance)
  LOW: 3,      // Optional enhancements (hashtag_generation, poll_analysis)
} as const;

export type AiPriorityLevel = typeof AI_PRIORITY[keyof typeof AI_PRIORITY];

// Map AI sources to their priority levels
const SOURCE_PRIORITIES: Record<string, AiPriorityLevel> = {
  question_answerer: AI_PRIORITY.CRITICAL,
  semantic_similarity: AI_PRIORITY.HIGH,
  regional_relevance: AI_PRIORITY.MEDIUM,
  hashtag_generation: AI_PRIORITY.LOW,
  poll_analysis: AI_PRIORITY.LOW,
};

// Budget thresholds for each priority level (percentage of daily limit).
// Stricter than before so cheap features get shed earlier, keeping budget
// for user-facing Q&A replies.
const PRIORITY_THRESHOLDS: Record<AiPriorityLevel, number> = {
  [AI_PRIORITY.LOW]: 0.30,
  [AI_PRIORITY.MEDIUM]: 0.55,
  [AI_PRIORITY.HIGH]: 0.75,
  [AI_PRIORITY.CRITICAL]: 1.00,
};

export function getAiPriority(source: string): AiPriorityLevel {
  return SOURCE_PRIORITIES[source] ?? AI_PRIORITY.LOW;
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number
): number {
  return (
    (inputTokens / 1_000_000) * HAIKU_INPUT_COST_PER_M +
    (outputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M
  );
}

export async function getTodaysCost(): Promise<number> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("get_today_ai_cost");

    if (error) {
      // Fallback: manual query
      const { data: rows, error: queryError } = await supabase
        .from("ai_usage")
        .select("cost_usd")
        .eq("date_bucket", new Date().toISOString().slice(0, 10));

      if (queryError) {
        console.error(`costTracker: failed to query today's cost: ${queryError.message}`);
        return Infinity;
      }

      return (rows ?? []).reduce(
        (sum: number, row: any) => sum + Number(row.cost_usd),
        0
      );
    }

    return Number(data) || 0;
  } catch (err) {
    console.error(`costTracker: failed to query today's cost: ${err}`);
    return Infinity;
  }
}

function getDailyLimit(): number {
  const limitStr = process.env.AI_DAILY_COST_LIMIT_USD;
  if (limitStr) {
    const parsed = parseFloat(limitStr);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_DAILY_LIMIT_USD;
}

export async function hasAiBudget(): Promise<boolean> {
  const limit = getDailyLimit();
  const todaysCost = await getTodaysCost();
  return todaysCost < limit;
}

/**
 * Check if there's budget for a specific priority level.
 * Lower priority features get disabled first as budget runs out.
 */
export async function hasAiBudgetForPriority(priority: AiPriorityLevel): Promise<boolean> {
  const limit = getDailyLimit();
  const todaysCost = await getTodaysCost();

  // Calculate what percentage of budget has been used
  const usedPercentage = todaysCost / limit;

  // Check if this priority level is still allowed
  const threshold = PRIORITY_THRESHOLDS[priority];
  return usedPercentage < threshold;
}

/**
 * Check if there's budget for a specific AI source.
 * Convenience wrapper that looks up the source's priority.
 */
export async function hasAiBudgetForSource(source: string): Promise<boolean> {
  const priority = getAiPriority(source);
  return hasAiBudgetForPriority(priority);
}

export async function logAiUsage(
  source: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  try {
    const costUsd = calculateCost(inputTokens, outputTokens);
    const supabase = createClient();
    const { error } = await supabase.from("ai_usage").insert({
      source,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
    });

    if (error) {
      console.error(`costTracker: failed to log usage: ${error.message}`);
    }
  } catch (err) {
    console.error(`costTracker: failed to log usage: ${err}`);
  }
}
