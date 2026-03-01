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
};
