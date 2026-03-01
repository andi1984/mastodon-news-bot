type SingleCWMapping = {
  label: string;
  id: string;
  words: string[];
};

export type Settings = {
  cw_mapping: SingleCWMapping[];
  feed_hashtags: string[];
  feed_specific_hashtags?: Record<string, string[]>;
  auto_reply_text: string;
  similarity_threshold?: number;
  breaking_news_min_sources?: number;
  breaking_news_time_window_hours?: number;
  breaking_news_priority_boost?: number;
};
