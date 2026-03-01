import { createRestAPIClient } from "masto";

const fakeClient = { v1: {} } as any;

jest.mock("masto", () => ({
  createRestAPIClient: jest.fn(() => fakeClient),
}));

const mockedCreate = createRestAPIClient as jest.Mock;

import login from "./login.js";

describe("login", () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...ORIG_ENV,
      API_INSTANCE: "https://mastodon.example",
      ACCESS_TOKEN: "test-token",
    };
    mockedCreate.mockClear();
  });

  afterEach(() => {
    process.env = ORIG_ENV;
  });

  test("passes env vars to createRestAPIClient", async () => {
    await login();

    expect(mockedCreate).toHaveBeenCalledWith({
      url: "https://mastodon.example",
      accessToken: "test-token",
    });
  });

  test("returns the client instance", async () => {
    const result = await login();

    expect(result).toBe(fakeClient);
  });
});
