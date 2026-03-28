import type { mastodon } from "masto";

export interface EngagementStats {
  reblogs: number;
  favourites: number;
  replies: number;
  ownReplies: number;
  totalInteractions: number;
}

/**
 * Count replies to a status, excluding replies from a specific account (the bot itself).
 */
export function countExternalReplies(
  descendants: mastodon.v1.Status[],
  statusId: string,
  excludeAccountId: string
): { total: number; ownReplies: number } {
  // Only count direct replies to this status (not replies to replies)
  const directReplies = descendants.filter(
    (reply) => reply.inReplyToId === statusId
  );

  const ownReplies = directReplies.filter(
    (reply) => reply.account.id === excludeAccountId
  ).length;

  return {
    total: directReplies.length - ownReplies,
    ownReplies,
  };
}

/**
 * Calculate engagement stats for a status, excluding the bot's own replies.
 */
export function calculateEngagement(
  status: mastodon.v1.Status,
  descendants: mastodon.v1.Status[],
  botAccountId: string
): EngagementStats {
  const reblogs = status.reblogsCount ?? 0;
  const favourites = status.favouritesCount ?? 0;

  const { total: replies, ownReplies } = countExternalReplies(
    descendants,
    status.id,
    botAccountId
  );

  return {
    reblogs,
    favourites,
    replies,
    ownReplies,
    totalInteractions: reblogs + favourites + replies,
  };
}
