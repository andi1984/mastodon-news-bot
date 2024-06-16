import login from "./login";
import { asyncForEach } from "./async";
import boost from "./boost";

const hashtagBoost = async (hashtag: string) => {
  const mastoInstance = await login();
  const timelines = mastoInstance.v1.timelines;
  const results = timelines.tag.$select(hashtag).list();
  //Async iterable
  const result = await results.next();
  if (!result.value) {
    return;
  }

  // We got our first X entries in result.value
  // Reblog/Boost all natur posts
  await asyncForEach(result.value, async (post) => {
    await boost(post);
    return true;
  });
};

export default hashtagBoost;
