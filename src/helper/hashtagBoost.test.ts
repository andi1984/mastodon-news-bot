import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import type { mastodon } from "masto";

const mockBoost = jest.fn();
const mockNext = jest.fn();
const mockValues = jest.fn(() => ({ next: mockNext }));
const mockList = jest.fn(() => ({ values: mockValues }));
const mockTagSelect = jest.fn(() => ({ list: mockList }));
const mockClient = {
  v1: { timelines: { tag: { $select: mockTagSelect } } },
} as any;

jest.unstable_mockModule("./boost", () => ({
  default: mockBoost,
}));

jest.unstable_mockModule("./login", () => ({
  default: jest.fn(() => Promise.resolve(mockClient)),
}));

const { default: hashtagBoost } = await import("./hashtagBoost.js");

describe("hashtagBoost", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("fetches the correct hashtag timeline", async () => {
    mockNext.mockResolvedValue({ value: undefined, done: true });

    await hashtagBoost("saarland");

    expect(mockTagSelect).toHaveBeenCalledWith("saarland");
  });

  test("returns early when no results", async () => {
    mockNext.mockResolvedValue({ value: undefined, done: true });

    await hashtagBoost("empty");

    expect(mockBoost).not.toHaveBeenCalled();
  });

  test("boosts each post from results", async () => {
    const post1 = { id: "1" } as mastodon.v1.Status;
    const post2 = { id: "2" } as mastodon.v1.Status;
    mockNext.mockResolvedValue({ value: [post1, post2], done: false });

    await hashtagBoost("saarland");

    expect(mockBoost).toHaveBeenCalledTimes(2);
    expect(mockBoost).toHaveBeenCalledWith(post1);
    expect(mockBoost).toHaveBeenCalledWith(post2);
  });
});
