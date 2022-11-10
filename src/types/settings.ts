type SingleCWMapping = {
  label: string;
  id: string;
  words: string[];
};

export type Settings = {
  cw_mapping: SingleCWMapping[];
};
