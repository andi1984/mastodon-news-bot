import { Settings } from "../types/settings";
/**
 * Given a feed text, returns content warning in case text should be behind or not
 **/
const feed2CW = (text: string, settings: Settings) => {
  const mapping = settings?.cw_mapping;
  let cw = null;
  if (mapping) {
    for (const warningObj of mapping) {
      if (!!cw) {
        // If we have found a content warning, we can break the loop!
        break;
      }

      console.log("cw", text, warningObj.words);

      const warningIsMatching = warningObj.words
        .map((word) => text.match(new RegExp(word, "gi")))
        .some(Boolean);

      if (warningIsMatching) {
        // If we have at least one match, we set the respective content warning
        cw = warningObj.label;
      }
    }
  }
  return cw;
};

export default feed2CW;
