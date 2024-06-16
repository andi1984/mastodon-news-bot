import type { mastodon } from "masto";

import login from "./login";
import settings from "../data/settings.json";

/**
 * Boost a status after several checks.
 */
const boost = async (status: mastodon.v1.Status) => {
  const mastoInstance = await login();

  // Check if status is not a reply
  const isReply = !!status.inReplyToId;
  // Check that status is not from ourselves
  const isFromUs = status.account.acct == settings.username;

  // If it is not a reply and does not come from us, we boost it!
  if (!isReply && !isFromUs) {
    await mastoInstance.v1.statuses
      .$select(status.id)
      .reblog({ visibility: "public" });
  }
};

export default boost;
