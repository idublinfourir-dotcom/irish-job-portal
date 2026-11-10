import { describe, expect, test } from "vitest";
import { asciiDigits, cpHead, cpTail, py, pyStrip } from "./pyre";

describe("py: Python's meaning of \\w, \\s, \\d and \\b", () => {
  test("\\w and \\b know letters outside ASCII", () => {
    expect(py(String.raw`^\w+$`).test("café")).toBe(true);
    expect(py(String.raw`\bcaf\b`).test("café")).toBe(false);
    expect(py(String.raw`\bcaf\b`).test("caf!")).toBe(true);
  });
  test("\\s matches the Python set: U+0085 and U+001C yes, U+FEFF no", () => {
    expect(py(String.raw`^\s$`).test("\u0085")).toBe(true);
    expect(py(String.raw`^\s$`).test("\x1c")).toBe(true);
    expect(py(String.raw`^\s$`).test("﻿")).toBe(false);
    expect(py(String.raw`^[\s]$`).test(" ")).toBe(true);
  });
  test("\\d matches any Unicode decimal digit", () => {
    expect(py(String.raw`^\d$`).test("٣")).toBe(true);
  });
  test("ignore-case matches the Kelvin sign, the long s and the dotted and dotless i like Python", () => {
    expect(py("k", "i").test("K")).toBe(true);
    expect(py("s", "i").test("ſ")).toBe(true);
    expect(py("i", "i").test("İ")).toBe(true);
    expect(py("[ai]", "i").test("ı")).toBe(true);
    expect(py("i").test("İ")).toBe(false);
  });
});

describe("code point helpers", () => {
  test("cpHead and cpTail count code points", () => {
    expect(cpHead("a\u{1F600}b", 2)).toBe("a\u{1F600}");
    expect(cpHead("abc", 2)).toBe("ab");
    expect(cpHead("ab", 5)).toBe("ab");
    expect(cpTail("a\u{1F600}b", 2)).toBe("\u{1F600}b");
    expect(cpTail("abc", 2)).toBe("bc");
  });
  test("asciiDigits turns every Unicode digit into 0 to 9", () => {
    expect(asciiDigits("٥۷０\u{1d7d8}\u{1d7e3}")).toBe("57001");
    expect(asciiDigits("12a")).toBe("12a");
  });
  test("pyStrip removes Python whitespace but not U+FEFF", () => {
    expect(pyStrip("\u0085 x  ")).toBe("x");
    expect(pyStrip("﻿x")).toBe("﻿x");
  });
});
