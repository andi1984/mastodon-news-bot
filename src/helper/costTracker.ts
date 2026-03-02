import createClient from "./db.js";

// Pricing for claude-haiku-4-5-20251001
const HAIKU_INPUT_COST_PER_M = 0.8;
const HAIKU_OUTPUT_COST_PER_M = 4.0;

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

export async function hasAiBudget(): Promise<boolean> {
  const limitStr = process.env.AI_DAILY_COST_LIMIT_USD;
  const limit = limitStr ? parseFloat(limitStr) : 0;

  if (!limit || limit <= 0) {
    return true; // no limit configured
  }

  const todaysCost = await getTodaysCost();
  return todaysCost < limit;
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
