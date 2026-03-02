jest.mock("./db", () => ({
  __esModule: true,
  default: jest.fn(),
}));

import createClient from "./db.js";
import {
  calculateCost,
  getTodaysCost,
  hasAiBudget,
  logAiUsage,
} from "./costTracker.js";

const mockedCreateClient = createClient as jest.MockedFunction<
  typeof createClient
>;

describe("calculateCost", () => {
  it("returns 0 for zero tokens", () => {
    expect(calculateCost(0, 0)).toBe(0);
  });

  it("calculates cost for input tokens only", () => {
    // 1M input tokens at $0.80/M = $0.80
    expect(calculateCost(1_000_000, 0)).toBeCloseTo(0.8);
  });

  it("calculates cost for output tokens only", () => {
    // 1M output tokens at $4.00/M = $4.00
    expect(calculateCost(0, 1_000_000)).toBeCloseTo(4.0);
  });

  it("calculates combined cost", () => {
    // 500 input = 0.0004, 100 output = 0.0004
    expect(calculateCost(500, 100)).toBeCloseTo(0.0008);
  });
});

describe("getTodaysCost", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns sum from rpc call", async () => {
    mockedCreateClient.mockReturnValue({
      rpc: jest.fn().mockResolvedValue({ data: 0.05, error: null }),
    } as any);

    const cost = await getTodaysCost();
    expect(cost).toBe(0.05);
  });

  it("falls back to manual query when rpc fails", async () => {
    const mockEq = jest.fn().mockResolvedValue({
      data: [{ cost_usd: 0.01 }, { cost_usd: 0.02 }],
      error: null,
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    const mockFrom = jest.fn().mockReturnValue({ select: mockSelect });

    mockedCreateClient.mockReturnValue({
      rpc: jest
        .fn()
        .mockResolvedValue({ data: null, error: { message: "no rpc" } }),
      from: mockFrom,
    } as any);

    const cost = await getTodaysCost();
    expect(cost).toBeCloseTo(0.03);
    expect(mockFrom).toHaveBeenCalledWith("ai_usage");
  });

  it("returns Infinity when both rpc and fallback fail", async () => {
    const mockEq = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "query failed" },
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    const mockFrom = jest.fn().mockReturnValue({ select: mockSelect });

    mockedCreateClient.mockReturnValue({
      rpc: jest
        .fn()
        .mockResolvedValue({ data: null, error: { message: "no rpc" } }),
      from: mockFrom,
    } as any);

    const cost = await getTodaysCost();
    expect(cost).toBe(Infinity);
  });

  it("returns Infinity on exception", async () => {
    mockedCreateClient.mockImplementation(() => {
      throw new Error("connection failed");
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
    mockedCreateClient.mockReturnValue({
      rpc: jest.fn().mockResolvedValue({ data: 0.5, error: null }),
    } as any);

    const result = await hasAiBudget();
    expect(result).toBe(true);
  });

  it("returns false when spend exceeds limit", async () => {
    process.env.AI_DAILY_COST_LIMIT_USD = "0.50";
    mockedCreateClient.mockReturnValue({
      rpc: jest.fn().mockResolvedValue({ data: 0.75, error: null }),
    } as any);

    const result = await hasAiBudget();
    expect(result).toBe(false);
  });

  it("returns false when spend equals limit", async () => {
    process.env.AI_DAILY_COST_LIMIT_USD = "0.50";
    mockedCreateClient.mockReturnValue({
      rpc: jest.fn().mockResolvedValue({ data: 0.5, error: null }),
    } as any);

    const result = await hasAiBudget();
    expect(result).toBe(false);
  });

  it("returns false when getTodaysCost returns Infinity (DB error)", async () => {
    process.env.AI_DAILY_COST_LIMIT_USD = "1.00";
    mockedCreateClient.mockImplementation(() => {
      throw new Error("connection failed");
    });

    const result = await hasAiBudget();
    expect(result).toBe(false);
  });
});

describe("logAiUsage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("inserts usage record into ai_usage table", async () => {
    const mockInsert = jest
      .fn()
      .mockResolvedValue({ data: null, error: null });
    const mockFrom = jest.fn().mockReturnValue({ insert: mockInsert });
    mockedCreateClient.mockReturnValue({ from: mockFrom } as any);

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
    const mockInsert = jest
      .fn()
      .mockResolvedValue({ data: null, error: { message: "insert failed" } });
    const mockFrom = jest.fn().mockReturnValue({ insert: mockInsert });
    mockedCreateClient.mockReturnValue({ from: mockFrom } as any);

    await expect(
      logAiUsage("question_answerer", 500, 100)
    ).resolves.toBeUndefined();
  });

  it("does not throw on exception", async () => {
    mockedCreateClient.mockImplementation(() => {
      throw new Error("connection failed");
    });

    await expect(
      logAiUsage("question_answerer", 500, 100)
    ).resolves.toBeUndefined();
  });
});
