import type { mastodon } from "masto";
import login from "./login.js";
import { asyncForEach } from "./async.js";
import boost from "./boost.js";

const hashtagBoost = async (hashtag: string) => {
  const mastoInstance = await login();
  const timelines = mastoInstance.v1.timelines;
  const results = timelines.tag.$select(hashtag).list();
  //Async iterable
  const result = await results.values().next();
  if (!result.value) {
    return;
  }

  // We got our first X entries in result.value
  // Reblog/Boost all natur posts
  await asyncForEach(result.value, async (post: mastodon.v1.Status) => {
    await boost(post);
    return true;
  });
};

export default hashtagBoost;
