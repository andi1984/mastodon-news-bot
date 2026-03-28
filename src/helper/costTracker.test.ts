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

  it("uses default limit when no env var is configured", async () => {
    delete process.env.AI_DAILY_COST_LIMIT_USD;
    mockRpc.mockResolvedValue({ data: 0.10, error: null }); // 50% of default 0.20

    const result = await hasAiBudget();
    expect(result).toBe(true);
  });

  it("uses default limit when env var is 0 or invalid", async () => {
    process.env.AI_DAILY_COST_LIMIT_USD = "0";
    mockRpc.mockResolvedValue({ data: 0.10, error: null }); // 50% of default 0.20

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

// Import priority-related functions
const {
  AI_PRIORITY,
  getAiPriority,
  hasAiBudgetForPriority,
  DEFAULT_DAILY_LIMIT_USD,
} = await import("./costTracker.js");

describe("AI_PRIORITY", () => {
  it("defines priority levels", () => {
    expect(AI_PRIORITY.CRITICAL).toBe(0);
    expect(AI_PRIORITY.HIGH).toBe(1);
    expect(AI_PRIORITY.MEDIUM).toBe(2);
    expect(AI_PRIORITY.LOW).toBe(3);
  });
});

describe("DEFAULT_DAILY_LIMIT_USD", () => {
  it("is set to 0.20 (20 cents)", () => {
    expect(DEFAULT_DAILY_LIMIT_USD).toBe(0.20);
  });
});

describe("getAiPriority", () => {
  it("returns CRITICAL for question_answerer", () => {
    expect(getAiPriority("question_answerer")).toBe(AI_PRIORITY.CRITICAL);
  });

  it("returns HIGH for semantic_similarity", () => {
    expect(getAiPriority("semantic_similarity")).toBe(AI_PRIORITY.HIGH);
  });

  it("returns MEDIUM for regional_relevance", () => {
    expect(getAiPriority("regional_relevance")).toBe(AI_PRIORITY.MEDIUM);
  });

  it("returns LOW for hashtag_generation", () => {
    expect(getAiPriority("hashtag_generation")).toBe(AI_PRIORITY.LOW);
  });

  it("returns LOW for poll_analysis", () => {
    expect(getAiPriority("poll_analysis")).toBe(AI_PRIORITY.LOW);
  });

  it("returns LOW for unknown sources", () => {
    expect(getAiPriority("unknown_source")).toBe(AI_PRIORITY.LOW);
  });
});

describe("hasAiBudgetForPriority", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.AI_DAILY_COST_LIMIT_USD = "0.20";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("allows all priorities when budget is barely used (10%)", async () => {
    mockRpc.mockResolvedValue({ data: 0.02, error: null }); // 10% of 0.20

    expect(await hasAiBudgetForPriority(AI_PRIORITY.LOW)).toBe(true);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.MEDIUM)).toBe(true);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.HIGH)).toBe(true);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.CRITICAL)).toBe(true);
  });

  it("disables LOW priority at 50% budget used", async () => {
    mockRpc.mockResolvedValue({ data: 0.10, error: null }); // 50% of 0.20

    expect(await hasAiBudgetForPriority(AI_PRIORITY.LOW)).toBe(false);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.MEDIUM)).toBe(true);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.HIGH)).toBe(true);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.CRITICAL)).toBe(true);
  });

  it("disables MEDIUM priority at 76% budget used", async () => {
    mockRpc.mockResolvedValue({ data: 0.152, error: null }); // 76% of 0.20

    expect(await hasAiBudgetForPriority(AI_PRIORITY.LOW)).toBe(false);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.MEDIUM)).toBe(false);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.HIGH)).toBe(true);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.CRITICAL)).toBe(true);
  });

  it("disables HIGH priority at 91% budget used", async () => {
    mockRpc.mockResolvedValue({ data: 0.182, error: null }); // 91% of 0.20

    expect(await hasAiBudgetForPriority(AI_PRIORITY.LOW)).toBe(false);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.MEDIUM)).toBe(false);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.HIGH)).toBe(false);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.CRITICAL)).toBe(true);
  });

  it("disables all priorities at 100% budget used", async () => {
    mockRpc.mockResolvedValue({ data: 0.20, error: null }); // 100% of 0.20

    expect(await hasAiBudgetForPriority(AI_PRIORITY.LOW)).toBe(false);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.MEDIUM)).toBe(false);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.HIGH)).toBe(false);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.CRITICAL)).toBe(false);
  });

  it("uses default limit when env var not set", async () => {
    delete process.env.AI_DAILY_COST_LIMIT_USD;
    mockRpc.mockResolvedValue({ data: 0.10, error: null }); // 50% of default 0.20

    expect(await hasAiBudgetForPriority(AI_PRIORITY.LOW)).toBe(false);
    expect(await hasAiBudgetForPriority(AI_PRIORITY.CRITICAL)).toBe(true);
  });
});
