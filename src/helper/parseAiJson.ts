/**
 * Parse JSON from AI responses that may be wrapped in markdown code blocks.
 *
 * Claude sometimes returns JSON wrapped like:
 * ```json
 * {"key": "value"}
 * ```
 *
 * This function strips the markdown formatting before parsing.
 */
export function parseAiJson<T>(text: string): T {
  // Strip markdown code blocks if present
  const cleaned = text
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // Salvage arrays truncated by max_tokens: drop the incomplete trailing
    // element and close the array, so the complete entries are not lost
    // (losing them means cache misses and a re-billed API call next run).
    if (cleaned.startsWith("[")) {
      const lastComplete = cleaned.lastIndexOf("}");
      if (lastComplete !== -1) {
        return JSON.parse(cleaned.slice(0, lastComplete + 1) + "]");
      }
    }
    throw err;
  }
}
