import type { mastodon } from "masto";

const mockReblog = jest.fn();
const mockSelect = jest.fn(() => ({ reblog: mockReblog }));
const mockClient = {
  v1: { statuses: { $select: mockSelect } },
} as any;

jest.mock("./login", () => ({
  __esModule: true,
  default: jest.fn(() => Promise.resolve(mockClient)),
}));

jest.mock("../data/settings.json", () => ({
  username: "saarlandnews",
}));

import boost from "./boost.js";

function createMockStatus(
  overrides: Partial<{ id: string; inReplyToId: string | null; acct: string }>
) {
  return {
    id: overrides.id ?? "1",
    inReplyToId: overrides.inReplyToId ?? null,
    account: { acct: overrides.acct ?? "other" },
  } as mastodon.v1.Status;
}

describe("boost", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("boosts a normal post from another user", async () => {
    const status = createMockStatus({ id: "42", inReplyToId: null, acct: "other" });
    await boost(status);

    expect(mockSelect).toHaveBeenCalledWith("42");
    expect(mockReblog).toHaveBeenCalledWith({ visibility: "public" });
  });

  test("does not boost a reply", async () => {
    const status = createMockStatus({ inReplyToId: "99" });
    await boost(status);

    expect(mockReblog).not.toHaveBeenCalled();
  });

  test("does not boost own status", async () => {
    const status = createMockStatus({ acct: "saarlandnews" });
    await boost(status);

    expect(mockReblog).not.toHaveBeenCalled();
  });

  test("does not boost a reply from own account", async () => {
    const status = createMockStatus({ inReplyToId: "99", acct: "saarlandnews" });
    await boost(status);

    expect(mockReblog).not.toHaveBeenCalled();
  });
});
