type SingleCWMapping = {
  label: string;
  id: string;
  words: string[];
};

export type Settings = {
  username: string;
  hashtags: string[];
  db_table: string;
  feeds: Record<string, string>;
  feed_hashtags: string[];
  feed_specific_hashtags?: Record<string, string[]>;
  feed_priorities: Record<string, number>;
  toot_batch_size: number;
  min_freshness_hours: number;
  cw_mapping: SingleCWMapping[];
  auto_reply_text: string;
  similarity_threshold?: number;
  breaking_news_min_sources?: number;
  breaking_news_time_window_hours?: number;
  breaking_news_priority_boost?: number;
};
