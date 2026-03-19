import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const mockRpc = jest.fn();
const mockInsert = jest.fn();
const mockFrom = jest.fn();
const mockSelect = jest.fn();
const mockEq = jest.fn();

const mockDbClient = {
  rpc: mockRpc,
  from: mockFrom,
};

jest.unstable_mockModule("./db", () => ({
  default: jest.fn(() => mockDbClient),
}));

const {
  calculateCost,
  getTodaysCost,
  hasAiBudget,
  logAiUsage,
} = await import("./costTracker.js");

describe("calculateCost", () => {
  it("returns 0 for zero tokens", () => {
    expect(calculateCost(0, 0)).toBe(0);
  });

  it("calculates cost for input tokens only", () => {
    expect(calculateCost(1_000_000, 0)).toBeCloseTo(0.8);
  });

  it("calculates cost for output tokens only", () => {
    expect(calculateCost(0, 1_000_000)).toBeCloseTo(4.0);
  });

  it("calculates combined cost", () => {
    expect(calculateCost(500, 100)).toBeCloseTo(0.0008);
  });
});

describe("getTodaysCost", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFrom.mockReturnValue({ select: mockSelect });
    mockSelect.mockReturnValue({ eq: mockEq });
  });

  it("returns sum from rpc call", async () => {
    mockRpc.mockResolvedValue({ data: 0.05, error: null });

    const cost = await getTodaysCost();
    expect(cost).toBe(0.05);
  });

  it("falls back to manual query when rpc fails", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "no rpc" } });
    mockEq.mockResolvedValue({
      data: [{ cost_usd: 0.01 }, { cost_usd: 0.02 }],
      error: null,
    });

    const cost = await getTodaysCost();
    expect(cost).toBeCloseTo(0.03);
    expect(mockFrom).toHaveBeenCalledWith("ai_usage");
  });

  it("returns Infinity when both rpc and fallback fail", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "no rpc" } });
    mockEq.mockResolvedValue({
      data: null,
      error: { message: "query failed" },
    });

    const cost = await getTodaysCost();
    expect(cost).toBe(Infinity);
  });
});

describe("hasAiBudget", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns true when no limit is configured", async () => {
    delete process.env.AI_DAILY_COST_LIMIT_USD;

    const result = await hasAiBudget();
    expect(result).toBe(true);
  });

  it("returns true when limit is 0", async () => {
    process.env.AI_DAILY_COST_LIMIT_USD = "0";

    const result = await hasAiBudget();
    expect(result).toBe(true);
  });

  it("returns true when spend is below limit", async () => {
    process.env.AI_DAILY_COST_LIMIT_USD = "1.00";
    mockRpc.mockResolvedValue({ data: 0.5, error: null });

    const result = await hasAiBudget();
    expect(result).toBe(true);
  });

  it("returns false when spend exceeds limit", async () => {
    process.env.AI_DAILY_COST_LIMIT_USD = "0.50";
    mockRpc.mockResolvedValue({ data: 0.75, error: null });

    const result = await hasAiBudget();
    expect(result).toBe(false);
  });

  it("returns false when spend equals limit", async () => {
    process.env.AI_DAILY_COST_LIMIT_USD = "0.50";
    mockRpc.mockResolvedValue({ data: 0.5, error: null });

    const result = await hasAiBudget();
    expect(result).toBe(false);
  });
});

describe("logAiUsage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFrom.mockReturnValue({ insert: mockInsert });
    mockInsert.mockResolvedValue({ data: null, error: null });
  });

  it("inserts usage record into ai_usage table", async () => {
    await logAiUsage("question_answerer", 500, 100);

    expect(mockFrom).toHaveBeenCalledWith("ai_usage");
    expect(mockInsert).toHaveBeenCalledWith({
      source: "question_answerer",
      input_tokens: 500,
      output_tokens: 100,
      cost_usd: expect.any(Number),
    });
  });

  it("does not throw on insert error", async () => {
    mockInsert.mockResolvedValue({ data: null, error: { message: "insert failed" } });

    await expect(
      logAiUsage("question_answerer", 500, 100)
    ).resolves.toBeUndefined();
  });
});
