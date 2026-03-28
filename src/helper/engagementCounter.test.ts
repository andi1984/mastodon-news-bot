import {
  countExternalReplies,
  calculateEngagement,
} from "./engagementCounter";
import type { mastodon } from "masto";

// Helper to create mock status
function createMockStatus(
  id: string,
  accountId: string,
  inReplyToId: string | null = null
): mastodon.v1.Status {
  return {
    id,
    account: { id: accountId } as mastodon.v1.Account,
    inReplyToId,
    reblogsCount: 0,
    favouritesCount: 0,
    repliesCount: 0,
  } as mastodon.v1.Status;
}

describe("countExternalReplies", () => {
  const botAccountId = "bot-123";
  const userAccountId = "user-456";
  const statusId = "status-001";

  it("returns zero for no replies", () => {
    const result = countExternalReplies([], statusId, botAccountId);

    expect(result.total).toBe(0);
    expect(result.ownReplies).toBe(0);
  });

  it("counts replies from other users", () => {
    const descendants = [
      createMockStatus("reply-1", userAccountId, statusId),
      createMockStatus("reply-2", "user-789", statusId),
    ];

    const result = countExternalReplies(descendants, statusId, botAccountId);

    expect(result.total).toBe(2);
    expect(result.ownReplies).toBe(0);
  });

  it("excludes bot's own replies", () => {
    const descendants = [
      createMockStatus("reply-1", userAccountId, statusId),
      createMockStatus("reply-2", botAccountId, statusId), // Bot's "Update" reply
    ];

    const result = countExternalReplies(descendants, statusId, botAccountId);

    expect(result.total).toBe(1);
    expect(result.ownReplies).toBe(1);
  });

  it("counts multiple bot replies correctly", () => {
    const descendants = [
      createMockStatus("reply-1", botAccountId, statusId), // Bot reply
      createMockStatus("reply-2", botAccountId, statusId), // Another bot reply
      createMockStatus("reply-3", userAccountId, statusId), // User reply
    ];

    const result = countExternalReplies(descendants, statusId, botAccountId);

    expect(result.total).toBe(1);
    expect(result.ownReplies).toBe(2);
  });

  it("ignores replies to other statuses (nested replies)", () => {
    const descendants = [
      createMockStatus("reply-1", userAccountId, statusId), // Direct reply
      createMockStatus("reply-2", userAccountId, "reply-1"), // Reply to a reply
      createMockStatus("reply-3", "user-789", "reply-1"), // Another nested reply
    ];

    const result = countExternalReplies(descendants, statusId, botAccountId);

    // Only count direct replies to the original status
    expect(result.total).toBe(1);
    expect(result.ownReplies).toBe(0);
  });

  it("handles mixed scenario: bot updates + user replies + nested", () => {
    const descendants = [
      createMockStatus("reply-1", botAccountId, statusId), // Bot "Update" reply
      createMockStatus("reply-2", userAccountId, statusId), // User direct reply
      createMockStatus("reply-3", "user-789", statusId), // Another user reply
      createMockStatus("reply-4", userAccountId, "reply-1"), // Reply to bot's update
      createMockStatus("reply-5", botAccountId, "reply-2"), // Bot reply to user (nested)
    ];

    const result = countExternalReplies(descendants, statusId, botAccountId);

    // Direct external replies: reply-2, reply-3
    expect(result.total).toBe(2);
    // Bot's direct reply: reply-1
    expect(result.ownReplies).toBe(1);
  });
});

describe("calculateEngagement", () => {
  const botAccountId = "bot-123";
  const userAccountId = "user-456";

  it("calculates total engagement excluding bot replies", () => {
    const status = {
      id: "status-001",
      reblogsCount: 5,
      favouritesCount: 10,
      repliesCount: 3, // This includes bot's own replies
    } as mastodon.v1.Status;

    const descendants = [
      createMockStatus("reply-1", userAccountId, "status-001"),
      createMockStatus("reply-2", botAccountId, "status-001"), // Bot's update
      createMockStatus("reply-3", "user-789", "status-001"),
    ];

    const result = calculateEngagement(status, descendants, botAccountId);

    expect(result.reblogs).toBe(5);
    expect(result.favourites).toBe(10);
    expect(result.replies).toBe(2); // Excludes bot's reply
    expect(result.ownReplies).toBe(1);
    expect(result.totalInteractions).toBe(17); // 5 + 10 + 2
  });

  it("returns zero interactions when only bot replied", () => {
    const status = {
      id: "status-001",
      reblogsCount: 0,
      favouritesCount: 0,
      repliesCount: 2,
    } as mastodon.v1.Status;

    const descendants = [
      createMockStatus("reply-1", botAccountId, "status-001"),
      createMockStatus("reply-2", botAccountId, "status-001"),
    ];

    const result = calculateEngagement(status, descendants, botAccountId);

    expect(result.replies).toBe(0);
    expect(result.ownReplies).toBe(2);
    expect(result.totalInteractions).toBe(0);
  });

  it("handles status with no replies", () => {
    const status = {
      id: "status-001",
      reblogsCount: 3,
      favouritesCount: 7,
      repliesCount: 0,
    } as mastodon.v1.Status;

    const result = calculateEngagement(status, [], botAccountId);

    expect(result.reblogs).toBe(3);
    expect(result.favourites).toBe(7);
    expect(result.replies).toBe(0);
    expect(result.ownReplies).toBe(0);
    expect(result.totalInteractions).toBe(10);
  });

  it("handles undefined counts gracefully", () => {
    const status = {
      id: "status-001",
      reblogsCount: undefined,
      favouritesCount: undefined,
      repliesCount: undefined,
    } as unknown as mastodon.v1.Status;

    const result = calculateEngagement(status, [], botAccountId);

    expect(result.reblogs).toBe(0);
    expect(result.favourites).toBe(0);
    expect(result.replies).toBe(0);
    expect(result.totalInteractions).toBe(0);
  });
});
