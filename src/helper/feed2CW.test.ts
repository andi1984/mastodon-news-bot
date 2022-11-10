import { Settings } from "../types/settings";
import feed2CW from "./feed2CW";

const settings: Settings = {
  cw_mapping: [
    {
      id: "foo",
      label: "Foo",
      words: ["foo", "bar"],
    },
    {
      id: "names",
      label: "Names",
      words: ["Bertram", "Susi"],
    },
  ],
};

describe("feed2CW", () => {
  test("not matching", () => {
    //@ts-ignore
    expect(feed2CW("fo")).toBe(null);
    expect(feed2CW("fo", settings)).toBe(null);
  });

  test("match case-insensitive", () => {
    expect(feed2CW("My name is Foo", settings)).toBe("Foo");
    expect(feed2CW("My bar is open", settings)).toBe("Foo");
    expect(feed2CW("Susi", settings)).toBe("Names");
  });

  test("match subword", () => {
    expect(feed2CW("My bartender is nice", settings)).toBe("Foo");
    expect(feed2CW("My bartender is foolish", settings)).toBe("Foo");
  });

  /**
   * This tests that the order in which the CW are
   * ordered in the settings matters. The
   * appearance/ordering of words in the text do not
   * matter though. Always the first matching CW in
   * settings wins!*/
  test("order matters", () => {
    expect(feed2CW("My bartender's name is Susi", settings)).toBe("Foo");
    expect(feed2CW("Susi is a bartender", settings)).toBe("Foo");
  });
});
