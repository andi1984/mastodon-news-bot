import { asyncForEach, asyncFilter } from "./async.js";

describe("asyncForEach", () => {
  it("resolves all promises for each element", async () => {
    const results: number[] = [];
    await asyncForEach([1, 2, 3], async (val) => {
      results.push(val * 2);
      return true;
    });
    expect(results).toEqual(expect.arrayContaining([2, 4, 6]));
    expect(results).toHaveLength(3);
  });

  it("returns an array of boolean results", async () => {
    const result = await asyncForEach([1, 2, 3], async (val) => val > 1);
    expect(result).toEqual([false, true, true]);
  });

  it("handles empty arrays", async () => {
    const result = await asyncForEach([], async () => true);
    expect(result).toEqual([]);
  });

  it("passes index and array to predicate", async () => {
    const indices: number[] = [];
    await asyncForEach(["a", "b"], async (_val, index, arr) => {
      indices.push(index);
      expect(arr).toEqual(["a", "b"]);
      return true;
    });
    expect(indices).toEqual([0, 1]);
  });
});

describe("asyncFilter", () => {
  it("filters elements based on async predicate", async () => {
    const result = await asyncFilter([1, 2, 3, 4, 5], async (val) => val % 2 === 0);
    expect(result).toEqual([2, 4]);
  });

  it("returns empty array when no elements match", async () => {
    const result = await asyncFilter([1, 3, 5], async (val) => val % 2 === 0);
    expect(result).toEqual([]);
  });

  it("returns all elements when all match", async () => {
    const result = await asyncFilter([2, 4, 6], async (val) => val % 2 === 0);
    expect(result).toEqual([2, 4, 6]);
  });

  it("handles empty arrays", async () => {
    const result = await asyncFilter([], async () => true);
    expect(result).toEqual([]);
  });

  it("preserves original element references", async () => {
    const obj1 = { id: 1, keep: true };
    const obj2 = { id: 2, keep: false };
    const obj3 = { id: 3, keep: true };

    const result = await asyncFilter([obj1, obj2, obj3], async (val) => val.keep);
    expect(result).toEqual([obj1, obj3]);
    expect(result[0]).toBe(obj1);
    expect(result[1]).toBe(obj3);
  });

  it("runs predicates concurrently", async () => {
    const startTime = Date.now();
    await asyncFilter([1, 2, 3], async (val) => {
      await new Promise((r) => setTimeout(r, 50));
      return val > 1;
    });
    const elapsed = Date.now() - startTime;
    // All 3 should run in parallel (~50ms), not sequentially (~150ms)
    expect(elapsed).toBeLessThan(120);
  });
});
