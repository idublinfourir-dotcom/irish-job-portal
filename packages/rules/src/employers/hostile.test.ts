import { describe, expect, it } from "vitest";
import { buildNameMatcher, cleanEmployerName, isAgencyName, isBigCompany, nameTitlePlaceKey, publicPayTier, urlOrNameKey } from ".";

// Performance and security tests (made-up text only).
// Measured on 10 Nov 2026 (shared machine): see BUDGET notes below. Budgets are about three times the worst measured.
const timed = (budgetMs: number, fn: () => void) => {
  const t = performance.now();
  fn();
  expect(performance.now() - t).toBeLessThan(budgetMs);
};
const candidates = new Map<string, 1 | 2>([["beaumont hospital", 2]]);
const everything = (employer: string, title = "Nurse", location = "Dublin") => {
  expect(typeof cleanEmployerName(employer)).toBe("string");
  isBigCompany(employer);
  isAgencyName(employer);
  publicPayTier(employer, candidates);
  urlOrNameKey({ url: "", employer, title, location });
  nameTitlePlaceKey(employer, title, location);
};

// 6,000 made-up candidate names, like the size of the DETE list.
const NAMES = Array.from({ length: 6000 }, (_, i) => `Company${i % 900} Word${i % 77} Thing${i} Ltd`);

describe("employers: speed", () => {
  // Measured: 1,000 made-up adverts of 10,000 characters (employer, title and place from the advert) 108 to 112 ms.
  it("1,000 adverts with long titles and locations stay inside the budget", () => {
    const text = "Senior Nurse, Dublin or Cork ".repeat(350);
    timed(300, () => {
      for (let n = 0; n < 1000; n++) everything(`Acme ${n} Care Group Ltd (Ireland)`, text, text);
    });
  });
  // Measured: building the matcher and 1,000 suggestions against 6,000 names, 168 ms.
  it("1,000 name suggestions against 6,000 names stay inside the budget", () => {
    timed(500, () => {
      const m = buildNameMatcher(NAMES);
      for (let i = 0; i < 1000; i++) m.suggest(`Company${i % 900} Word${i % 77}`);
    });
  });
});

describe("employers: hostile input neither throws nor hangs", () => {
  const rep = (unit: string, n: number) => unit.repeat(n);
  // Measured: each of these 0 to 446 ms (the slowest is mixed scripts).
  const cases: [string, string][] = [
    ["a 1 MB name of words", rep("nurse care ", 95_000)],
    ["one 1 MB word", rep("a", 1_000_000)],
    ["1 MB of digits", rep("1", 1_000_000)],
    ["1 MB of suffix words", rep("ltd ", 250_000)],
    ["1 MB of closed brackets", rep("(a)", 330_000)],
    ["1 MB of ampersands", rep("&", 1_000_000)],
    ["1 MB of spaces", rep(" ", 1_000_000)],
    ["1 MB of line breaks and Python-only whitespace", rep("\n\x85", 500_000)],
    ["html and script tags", rep("<script>alert(1)</script>", 40_000)],
    ["mixed scripts and odd Unicode", rep("日本語Привет ​﻿İıſKé́𝟘", 60_000)],
    ["null bytes", rep("\0hse\0", 150_000)],
    ["lone surrogates", rep("\ud800a\udc00", 200_000)],
    ["empty", ""],
  ];
  it.each(cases)("%s", (_name, text) => {
    timed(1500, () => {
      everything(text, text, text);
      buildNameMatcher(NAMES.slice(0, 50)).suggest(text.slice(0, 100_000));
    });
  });
  it("a long name suggestion against the full list stays fast", () => {
    const m = buildNameMatcher(NAMES);
    // Measured: both calls together 504 to 512 ms.
    timed(1500, () => {
      m.suggest("word1 ".repeat(100_000));
      m.suggest(Array.from({ length: 20_000 }, (_, i) => "Word" + (i % 77)).join(" "));
    });
  });
  it("known quirk: removing brackets grows with the square of a run of unclosed brackets (as in the Python)", () => {
    // Measured: 10,000 brackets 30 ms, 100,000 brackets 2.8 s, 300,000 brackets 28 s. Only the small size is tested.
    timed(100, () => {
      cleanEmployerName(rep("(", 10_000));
    });
  });
  it("employer names that are object property names are plain text", () => {
    for (const e of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(publicPayTier(e, candidates)).toBe(0);
      expect(buildNameMatcher(NAMES).suggest(e).kind).toBe("no candidate");
    }
  });
  it("missing values do not throw", () => {
    expect(publicPayTier(null, candidates)).toBe(0);
    expect(isAgencyName(undefined)).toBe(false);
    expect(nameTitlePlaceKey(null, undefined as unknown as string, null)).toBe("||");
  });
});
