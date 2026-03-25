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

  return JSON.parse(cleaned);
}
