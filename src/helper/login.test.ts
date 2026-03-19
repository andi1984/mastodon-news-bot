import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const fakeClient = { v1: {} } as any;
const mockCreateRestAPIClient = jest.fn(() => fakeClient);

jest.unstable_mockModule("masto", () => ({
  createRestAPIClient: mockCreateRestAPIClient,
}));

const { default: login } = await import("./login.js");

describe("login", () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...ORIG_ENV,
      API_INSTANCE: "https://mastodon.example",
      ACCESS_TOKEN: "test-token",
    };
    mockCreateRestAPIClient.mockClear();
  });

  afterEach(() => {
    process.env = ORIG_ENV;
  });

  test("passes env vars to createRestAPIClient", async () => {
    await login();

    expect(mockCreateRestAPIClient).toHaveBeenCalledWith({
      url: "https://mastodon.example",
      accessToken: "test-token",
    });
  });

  test("returns the client instance", async () => {
    const result = await login();

    expect(result).toBe(fakeClient);
  });
});
