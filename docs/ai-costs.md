# AI Costs

How the bot spends money on Claude, how the budget is enforced, and what we
learned from the May/June 2026 cost blowout (~30–40 ct/day instead of the
intended hard cap).

## Where AI is used

All AI calls go to Claude Haiku (`claude-haiku-4-5-20251001`, $1/MTok input,
$5/MTok output). Each call is logged to the `ai_usage` table by
`src/helper/costTracker.ts`.

| Source (`ai_usage.source`) | Helper | Priority | Purpose |
| --- | --- | --- | --- |
| `question_answerer` | `questionAnswerer.ts` | CRITICAL | Keyword extraction for mention replies |
| `semantic_similarity` | `semanticSimilarity.ts` | HIGH | Story matching when Jaccard is uncertain |
| `regional_relevance` | `regionalRelevance.ts` | MEDIUM | local/regional/national/international scoring |
| `hashtag_generation` | `hashtagGenerator.ts` | LOW | Hashtags when rule-based matching finds none |
| `poll_analysis` | `engagementEnhancer.ts` | LOW | Poll suggestions for debatable topics |

## Budget enforcement

- Daily limit: `DEFAULT_DAILY_LIMIT_USD` ($0.05) in `costTracker.ts`,
  overridable via the `AI_DAILY_COST_LIMIT_USD` env var. **The env var wins**
  — a forgotten higher value on the server silently raises the cap.
- Features shed in priority order as the budget fills: LOW features stop at
  30% of the limit, MEDIUM at 55%, HIGH at 75%, CRITICAL at 100%.
- The bot keeps working without AI. Every feature has a programmatic
  fallback: regional scoring uses the Saarland keyword gazetteer or neutral
  multipliers, story matching falls back to Jaccard-only, hashtags to the
  rule-based lists, polls are skipped, and mention replies fall back to
  programmatic keyword extraction (`extractKeywordsFallback`).

## Cheap-before-expensive layering

Every AI feature sits behind programmatic filters so Claude only sees what
code cannot decide:

1. **Regional relevance**: `always_local_feeds` short-circuit → Saarland
   keyword gazetteer (`regional_relevance.local_keywords`, wired from
   `keyword_filter.keywords` in feed-tooter) → `regional_cache` lookup →
   only then AI, in chunks of 25 titles with `max_tokens` sized per chunk.
2. **Semantic similarity**: Jaccard definite-match/definite-miss thresholds →
   `semantic_pair_cache` lookup → AI for the uncertain middle band only.
3. **Hashtags / polls**: keyword lists first; AI only when rules find
   nothing (hashtags) or the title passes a non-debatable keyword filter
   (polls).

## Post-mortem: the v1.3.0 cost blowout

Between 2026-05-19 (v1.3.0) and 2026-06-10 the bot spent 30–40 ct/day.
Root cause chain — every link mattered:

1. v1.3.0 removed `saarbruecker-zeitung` and `radio-salue` from
   `always_local_feeds`, so ~100 titles per tooter run went to AI regional
   classification.
2. The classifier had a fixed `max_tokens: 160`, but ~100 classifications
   need ~1,600 output tokens. **Every response truncated at exactly the
   cap** (visible in `ai_usage`: `output_tokens` identical on every call).
3. The truncated JSON failed to parse, so all results were discarded and
   **nothing was written to `regional_cache`** from 2026-05-19 on.
4. With an empty cache, the next run (every 20 min) re-sent the same titles
   — paying ~$0.15/day for classifications that were thrown away.
5. The budget gate under-counted real spend: pricing constants were
   $0.8/$4 per MTok (real Haiku 4.5: $1/$5), and `logAiUsage` was called
   without `await`, so inserts were dropped whenever the Bree worker exited
   before the DB roundtrip finished.

### Lessons / invariants

- **Size `max_tokens` from the batch size.** A fixed cap plus a growing
  batch is a silent truncation bug. Chunk large batches
  (`AI_CHUNK_SIZE` in `regionalRelevance.ts`).
- **A broken cache write is a billing bug, not just a perf bug.** If parsed
  results never reach the cache, the same input is re-billed forever.
  `parseAiJson` now salvages complete entries from truncated arrays so a
  cutoff cannot zero out the cache again.
- **Always `await logAiUsage`.** Fire-and-forget inserts race the Bree
  worker contract (`parentPort.postMessage("done")` terminates the worker);
  dropped inserts mean the budget gate fires late.
- **Keep pricing constants in sync with the official price list.**
  Under-counting input/output prices proportionally raises the real cap.
- **Prefer code over Claude.** If a deterministic rule (feed origin, keyword
  match, cache hit) can answer, never spend tokens to confirm it.

## Monitoring spend

Per-source daily breakdown:

```sql
SELECT date_bucket, source, count(*) AS calls,
       sum(input_tokens) AS in_tok, sum(output_tokens) AS out_tok,
       round(sum(cost_usd)::numeric, 4) AS cost
FROM ai_usage
WHERE date_bucket >= current_date - 13
GROUP BY 1, 2
ORDER BY 1 DESC, cost DESC;
```

Red flags:

- `out_tok / calls` exactly equal to a `max_tokens` value on every call →
  responses are truncated; results are probably being discarded.
- A cache table (`regional_cache`, `semantic_pair_cache`) with no recent
  writes (`max(cached_at)`) while its source keeps billing → the
  parse-or-persist path is broken and you are re-billing the same inputs.
- Tracked daily cost near or above the limit → check whether
  `AI_DAILY_COST_LIMIT_USD` is set on the server and whether priorities
  are shedding (look for "budget threshold reached" in the logs).
