import { sha256 } from "./hash.js";

describe("sha256", () => {
  it("returns a 64-character hex string", () => {
    const result = sha256("hello");
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces consistent output for the same input", () => {
    expect(sha256("test")).toBe(sha256("test"));
  });

  it("matches known SHA-256 hash", () => {
    // SHA-256 of "hello" is well-known
    expect(sha256("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });

  it("produces different hashes for different inputs", () => {
    expect(sha256("hello")).not.toBe(sha256("world"));
  });

  it("handles empty string", () => {
    const result = sha256("");
    expect(result).toHaveLength(64);
    expect(result).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("handles unicode characters", () => {
    const result = sha256("Saarbrücken Straße");
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles very long strings", () => {
    const longStr = "a".repeat(10000);
    const result = sha256(longStr);
    expect(result).toHaveLength(64);
  });
});
