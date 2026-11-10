import { describe, expect, it } from "vitest";
import { pyLen, pyRegex, pyRound2, pySortedUnique, pyStrip, pySum, pyWords } from "./py-text";

describe("py-text", () => {
  it("splits on Python whitespace, not JavaScript whitespace", () => {
    expect(pyWords("a\x85b\x1cc d")).toEqual(["a", "b", "c", "d"]); // Python splits at \x85 and \x1c, JS \s does not
    expect(pyWords("a﻿b c")).toEqual(["a﻿b", "c"]); // JS \s splits at the BOM, Python does not
    expect(pyWords("a b c d", 2)).toEqual(["a", "b"]);
    expect(pyWords("")).toEqual([]);
  });
  it("strips Python whitespace", () => {
    expect(pyStrip("　 x y \x85")).toBe("x y");
  });
  it("counts code points", () => {
    expect(pyLen("a𝟘b")).toBe(3);
  });
  it("sorts by code point, not UTF-16 unit", () => {
    expect(pySortedUnique(["０", "𝟘", "a", "a"])).toEqual(["a", "０", "𝟘"]);
  });
  it("rounds like Python (ties to even on exact halves, otherwise by the stored value)", () => {
    expect([0.125, 0.375, 0.625, 0.875].map(pyRound2)).toEqual([0.12, 0.38, 0.62, 0.88]);
    expect(pyRound2(0.285)).toBe(0.28); // stored as 0.28499999999999998
    expect(pyRound2(1)).toBe(1);
  });
  it("sums floats with compensation like Python 3.12+", () => {
    expect(pySum([0.1, 0.2, 0.3])).toBe(0.6); // plain + gives 0.6000000000000001
    expect(pySum([])).toBe(0);
  });
  it("builds Unicode word boundaries and digits", () => {
    expect(pyRegex(String.raw`\bnhs\b`, "i").test("NHSé")).toBe(false);
    expect(pyRegex(String.raw`\bnhs\b`, "i").test("(NHS)")).toBe(true);
    expect(pyRegex(String.raw`\d`).test("٣")).toBe(true);
    expect(() => pyRegex(String.raw`\w`)).toThrow();
  });
});
