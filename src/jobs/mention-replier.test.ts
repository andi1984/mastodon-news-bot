const mockCreate = jest.fn();
const mockDismiss = jest.fn();
const mockList = jest.fn();
const mockSelect = jest.fn(() => ({ dismiss: mockDismiss }));

const mockClient = {
  v1: {
    notifications: {
      list: mockList,
      $select: mockSelect,
    },
    statuses: {
      create: mockCreate,
    },
  },
} as any;

jest.mock("../helper/login", () => ({
  __esModule: true,
  default: jest.fn(() => Promise.resolve(mockClient)),
}));

jest.mock("../data/settings.json", () => ({
  username: "saarlandnews",
  auto_reply_text: "Ich bin ein Bot.",
}));

// Prevent process.exit from killing the test runner
jest.spyOn(process, "exit").mockImplementation((() => {}) as any);

async function runJob() {
  // Clear module cache so the IIFE re-executes each time
  jest.resetModules();

  // Re-apply mocks after resetModules
  jest.doMock("../helper/login", () => ({
    __esModule: true,
    default: jest.fn(() => Promise.resolve(mockClient)),
  }));
  jest.doMock("../data/settings.json", () => ({
    username: "saarlandnews",
    auto_reply_text: "Ich bin ein Bot.",
  }));

  // The IIFE runs on import — wait for it to finish
  await require("./mention-replier");
  // Allow microtasks to settle
  await new Promise((r) => setTimeout(r, 50));
}

describe("mention-replier", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("replies to a mention that is a reply to own toot", async () => {
    mockList.mockResolvedValue([
      {
        id: "1",
        status: {
          id: "100",
          inReplyToId: "50",
          account: { acct: "other" },
        },
      },
    ]);

    await runJob();

    expect(mockCreate).toHaveBeenCalledWith({
      status: "@other Ich bin ein Bot.",
      inReplyToId: "100",
      visibility: "unlisted",
      language: "de",
    });
    expect(mockSelect).toHaveBeenCalledWith("1");
    expect(mockDismiss).toHaveBeenCalled();
  });

  test("skips own mentions", async () => {
    mockList.mockResolvedValue([
      {
        id: "2",
        status: {
          id: "101",
          inReplyToId: "50",
          account: { acct: "saarlandnews" },
        },
      },
    ]);

    await runJob();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSelect).toHaveBeenCalledWith("2");
    expect(mockDismiss).toHaveBeenCalled();
  });

  test("skips standalone mentions (not replies)", async () => {
    mockList.mockResolvedValue([
      {
        id: "3",
        status: {
          id: "102",
          inReplyToId: null,
          account: { acct: "other" },
        },
      },
    ]);

    await runJob();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSelect).toHaveBeenCalledWith("3");
    expect(mockDismiss).toHaveBeenCalled();
  });

  test("handles empty notification list", async () => {
    mockList.mockResolvedValue([]);

    await runJob();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });
});
