import { jest, describe, test, expect, beforeEach } from "@jest/globals";

const mockCreate = jest.fn();
const mockDismiss = jest.fn();
const mockList = jest.fn();
const mockNotifSelect = jest.fn(() => ({ dismiss: mockDismiss }));
const mockContextFetch = jest.fn();
const mockStatusFetch = jest.fn();
const mockStatusSelect = jest.fn(() => ({
  context: { fetch: mockContextFetch },
  fetch: mockStatusFetch,
}));

const mockClient = {
  v1: {
    notifications: {
      list: mockList,
      $select: mockNotifSelect,
    },
    statuses: {
      create: mockCreate,
      $select: mockStatusSelect,
    },
  },
} as any;

const mockAnswerQuestion = jest.fn();

jest.unstable_mockModule("./questionAnswerer", () => ({
  answerQuestion: mockAnswerQuestion,
}));

const { handleMentions, isNewsTootThread } = await import("./mentionHandler.js");

const defaultConfig = {
  username: "saarlandnews",
  qa_enabled: true as boolean | undefined,
  db_table: "news",
};

describe("handleMentions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAnswerQuestion.mockResolvedValue("@other mock reply");
  });

  test("answers standalone mention (no inReplyToId)", async () => {
    mockList.mockResolvedValue([
      {
        id: "1",
        status: {
          id: "100",
          inReplyToId: null,
          content: "<p>@saarlandnews Gibt es Neuigkeiten?</p>",
          account: { acct: "other" },
        },
      },
    ]);

    await handleMentions(mockClient, defaultConfig);

    expect(mockAnswerQuestion).toHaveBeenCalledWith(
      "other",
      "<p>@saarlandnews Gibt es Neuigkeiten?</p>",
      defaultConfig
    );
    expect(mockCreate).toHaveBeenCalledWith({
      status: "@other mock reply",
      inReplyToId: "100",
      visibility: "unlisted",
      language: "de",
    });
    expect(mockDismiss).toHaveBeenCalled();
  });

  test("dismisses silently when reply is in a news-toot thread (root is bot)", async () => {
    mockList.mockResolvedValue([
      {
        id: "2",
        status: {
          id: "200",
          inReplyToId: "150",
          content: "<p>@saarlandnews Was meinst du?</p>",
          account: { acct: "other" },
        },
      },
    ]);

    mockContextFetch.mockResolvedValue({
      ancestors: [
        { id: "100", account: { acct: "saarlandnews" }, inReplyToId: null },
        { id: "150", account: { acct: "userA" }, inReplyToId: "100" },
      ],
    });

    await handleMentions(mockClient, defaultConfig);

    expect(mockAnswerQuestion).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockNotifSelect).toHaveBeenCalledWith("2");
    expect(mockDismiss).toHaveBeenCalled();
  });

  test("answers reply in a non-news thread (root is another user)", async () => {
    mockList.mockResolvedValue([
      {
        id: "3",
        status: {
          id: "300",
          inReplyToId: "250",
          content: "<p>@saarlandnews Kennst du gute Artikel?</p>",
          account: { acct: "other" },
        },
      },
    ]);

    mockContextFetch.mockResolvedValue({
      ancestors: [
        { id: "200", account: { acct: "userA" }, inReplyToId: null },
        { id: "250", account: { acct: "userB" }, inReplyToId: "200" },
      ],
    });

    await handleMentions(mockClient, defaultConfig);

    expect(mockAnswerQuestion).toHaveBeenCalledWith(
      "other",
      "<p>@saarlandnews Kennst du gute Artikel?</p>",
      defaultConfig
    );
    expect(mockCreate).toHaveBeenCalled();
  });

  test("dismisses silently when direct reply to bot's own toot (no ancestors)", async () => {
    mockList.mockResolvedValue([
      {
        id: "4",
        status: {
          id: "400",
          inReplyToId: "350",
          content: "<p>@saarlandnews Tolles Posting!</p>",
          account: { acct: "other" },
        },
      },
    ]);

    mockContextFetch.mockResolvedValue({ ancestors: [] });
    mockStatusFetch.mockResolvedValue({
      id: "350",
      account: { acct: "saarlandnews" },
    });

    await handleMentions(mockClient, defaultConfig);

    expect(mockAnswerQuestion).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDismiss).toHaveBeenCalled();
  });

  test("dismisses silently on context API error (safe default)", async () => {
    mockList.mockResolvedValue([
      {
        id: "5",
        status: {
          id: "500",
          inReplyToId: "450",
          content: "<p>@saarlandnews test</p>",
          account: { acct: "other" },
        },
      },
    ]);

    mockContextFetch.mockRejectedValue(new Error("API error"));

    await handleMentions(mockClient, defaultConfig);

    expect(mockAnswerQuestion).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDismiss).toHaveBeenCalled();
  });

  test("skips own mentions", async () => {
    mockList.mockResolvedValue([
      {
        id: "6",
        status: {
          id: "600",
          inReplyToId: null,
          content: "<p>test</p>",
          account: { acct: "saarlandnews" },
        },
      },
    ]);

    await handleMentions(mockClient, defaultConfig);

    expect(mockAnswerQuestion).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockNotifSelect).toHaveBeenCalledWith("6");
    expect(mockDismiss).toHaveBeenCalled();
  });

  test("handles empty notification list", async () => {
    mockList.mockResolvedValue([]);

    await handleMentions(mockClient, defaultConfig);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  test("dismisses notification without status", async () => {
    mockList.mockResolvedValue([
      {
        id: "7",
        status: null,
      },
    ]);

    await handleMentions(mockClient, defaultConfig);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockNotifSelect).toHaveBeenCalledWith("7");
    expect(mockDismiss).toHaveBeenCalled();
  });
});

describe("isNewsTootThread", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns true when root ancestor is bot", async () => {
    mockContextFetch.mockResolvedValue({
      ancestors: [
        { id: "1", account: { acct: "saarlandnews" }, inReplyToId: null },
      ],
    });

    const result = await isNewsTootThread(mockClient, "50", "saarlandnews");

    expect(result).toBe(true);
  });

  test("returns false when root ancestor is another user", async () => {
    mockContextFetch.mockResolvedValue({
      ancestors: [
        { id: "1", account: { acct: "userA" }, inReplyToId: null },
      ],
    });

    const result = await isNewsTootThread(mockClient, "50", "saarlandnews");

    expect(result).toBe(false);
  });

  test("fetches parent when no ancestors and parent is bot", async () => {
    mockContextFetch.mockResolvedValue({ ancestors: [] });
    mockStatusFetch.mockResolvedValue({
      id: "50",
      account: { acct: "saarlandnews" },
    });

    const result = await isNewsTootThread(mockClient, "50", "saarlandnews");

    expect(result).toBe(true);
  });

  test("fetches parent when no ancestors and parent is another user", async () => {
    mockContextFetch.mockResolvedValue({ ancestors: [] });
    mockStatusFetch.mockResolvedValue({
      id: "50",
      account: { acct: "userA" },
    });

    const result = await isNewsTootThread(mockClient, "50", "saarlandnews");

    expect(result).toBe(false);
  });

  test("returns true on API error (safe default)", async () => {
    mockContextFetch.mockRejectedValue(new Error("API error"));

    const result = await isNewsTootThread(mockClient, "50", "saarlandnews");

    expect(result).toBe(true);
  });
});
