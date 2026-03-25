import { parseAiJson } from "./parseAiJson.js";

describe("parseAiJson", () => {
  it("parses plain JSON", () => {
    const result = parseAiJson<{ tags: string[] }>('{"tags": ["foo", "bar"]}');
    expect(result).toEqual({ tags: ["foo", "bar"] });
  });

  it("strips ```json code block", () => {
    const input = '```json\n{"tags": ["foo"]}\n```';
    const result = parseAiJson<{ tags: string[] }>(input);
    expect(result).toEqual({ tags: ["foo"] });
  });

  it("strips ``` code block without language", () => {
    const input = '```\n{"debatable": true}\n```';
    const result = parseAiJson<{ debatable: boolean }>(input);
    expect(result).toEqual({ debatable: true });
  });

  it("handles code block with no newline after opening", () => {
    const input = '```json{"tags": []}\n```';
    const result = parseAiJson<{ tags: string[] }>(input);
    expect(result).toEqual({ tags: [] });
  });

  it("handles code block with no newline before closing", () => {
    const input = '```json\n{"tags": ["a"]}```';
    const result = parseAiJson<{ tags: string[] }>(input);
    expect(result).toEqual({ tags: ["a"] });
  });

  it("handles whitespace around JSON", () => {
    const input = '  \n{"key": "value"}\n  ';
    const result = parseAiJson<{ key: string }>(input);
    expect(result).toEqual({ key: "value" });
  });

  it("parses array responses", () => {
    const input = '```json\n[{"a": 1, "b": 2, "s": 0.9}]\n```';
    const result = parseAiJson<{ a: number; b: number; s: number }[]>(input);
    expect(result).toEqual([{ a: 1, b: 2, s: 0.9 }]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseAiJson("not json")).toThrow(SyntaxError);
  });

  it("throws on malformed code block content", () => {
    const input = '```json\n{invalid}\n```';
    expect(() => parseAiJson(input)).toThrow(SyntaxError);
  });
});
