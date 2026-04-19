-- Cache tables for Claude classification results.
-- Run this once against the Supabase project to enable the result caches
-- used by src/helper/aiCache.ts. Without them, cache lookups silently
-- return empty maps and the bot keeps calling Claude on every article.

create table if not exists regional_cache (
    title_hash text primary key,
    category   text not null,
    cached_at  timestamptz not null default now()
);

create index if not exists regional_cache_cached_at_idx
    on regional_cache (cached_at);

create table if not exists semantic_pair_cache (
    pair_hash text primary key,
    score     numeric not null,
    cached_at timestamptz not null default now()
);

create index if not exists semantic_pair_cache_cached_at_idx
    on semantic_pair_cache (cached_at);
