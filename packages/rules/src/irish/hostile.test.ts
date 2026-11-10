import { describe, expect, it } from "vitest";
import { checkIrishEmployer, locationLooksIrish } from ".";

// Performance and security tests (made-up text only).
// Measured on 10 Nov 2026 (shared machine): 1,000 adverts, known and not known: 260 to 414 ms; worst hostile case: 210 to 385 ms.
// Budgets are about three times the worst measured.
const BUDGET_1000 = 1200;
const BUDGET_ONE = 1200;
const timed = (budgetMs: number, fn: () => void) => {
  const t = performance.now();
  fn();
  expect(performance.now() - t).toBeLessThan(budgetMs);
};
const job = (description: string, o: Partial<{ employer: string; title: string; location: string }> = {}) => ({
  employer: "Acme Care Ltd",
  title: "Staff Nurse",
  location: "Dublin",
  description,
  ...o,
});

const SENT = [
  "We are looking for a nurse to join our team in Dublin. ",
  "You will work with patients and the team for the good of all, £45,000 a year. ",
  "Apply now at our site and send your CV to the team. NHS style band 6 posts are not offered here. ",
];
const advert = (n: number) => {
  let s = "";
  for (let k = 0; s.length < 10_000; k++) s += SENT[(k + n) % SENT.length]!;
  return s;
};

describe("irish check: speed", () => {
  it("1,000 adverts of about 10,000 characters, both known and not known, stay inside the budget", () => {
    const adverts = Array.from({ length: 1000 }, (_, n) => advert(n));
    timed(BUDGET_1000, () => {
      for (const d of adverts) {
        checkIrishEmployer(job(d), true);
        checkIrishEmployer(job(d), false);
        locationLooksIrish("Dublin");
      }
    });
  });
});

describe("irish check: hostile input neither throws nor hangs", () => {
  const long = (unit: string, n: number) => unit.repeat(n);
  const cases: [string, string][] = [
    ["a 1 MB advert of words", long("nurse role ", 95_000)],
    ["one 1 MB line with no spaces", long("a", 1_000_000)],
    ["1 MB of digits", long("1", 1_000_000)],
    ["1 MB of commas", long(",", 1_000_000)],
    ["1 MB of currency signs and digits", long("£1$", 330_000)],
    ["1 MB of currency signs then space and digits", long("£ ", 500_000) + "9"],
    ["1 MB of spaces", long(" ", 1_000_000)],
    ["1 MB of Python-only whitespace", long("\x85", 1_000_000)],
    ["long run of eircode-like text", long("D02 X28 ", 120_000)],
    ["long run of ireland", long("ireland", 140_000)],
    ["long run of northern ireland", long("northern ireland ", 60_000)],
    ["long run of dublin and digits", long("dublin 1", 120_000)],
    ["html and script tags", long("<script>alert(1)</script><p>x</p>", 30_000)],
    ["mixed scripts and odd Unicode", long("日本語Привет ​﻿İıſKé́𝟘", 60_000)],
    ["null bytes", long("\0nhs\0", 150_000)],
    ["lone surrogates", long("\ud800a\udc00", 200_000)],
    ["empty", ""],
  ];
  it.each(cases)("%s", (_name, text) => {
    timed(BUDGET_ONE, () => {
      for (const known of [true, false]) {
        const r = checkIrishEmployer(job(text), known);
        expect(["irish", "not irish", "unsure"]).toContain(r.verdict);
        expect(typeof r.reason).toBe("string");
      }
    });
  });
  it("a 1 MB location and a 1 MB employer do not hang", () => {
    const big = "x".repeat(1_000_000);
    timed(BUDGET_ONE, () => {
      locationLooksIrish(big);
      checkIrishEmployer(job("text", { location: big }), true);
      checkIrishEmployer(job("text", { employer: big }), true);
    });
  });
  it("empty fields do not throw", () => {
    expect(checkIrishEmployer({ employer: "", title: "", description: "", location: "" }, false).verdict).toBe("unsure");
    expect(locationLooksIrish("")).toBe(false);
  });
});
