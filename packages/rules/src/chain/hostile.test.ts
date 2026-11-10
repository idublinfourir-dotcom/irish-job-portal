// Input limits, performance and security of the decision chain. Adverts are untrusted text and some ported patterns slow
// down with the square of the input length, so the chain refuses over-long input before any rule runs.
// Made-up text only. The matcher is a fake (the real one has its own hostile tests in packages/matcher).
import { describe, expect, it, vi } from "vitest";
import { assess, INPUT_LIMITS, type AdvertInput, type ChainData, type ChainMatcher } from "./assess";

const GOOD: ChainMatcher = async () => ({ occupationCode: "2134", onCriticalSkillsList: "yes", confidence: "high" });
const data = (matcher: ChainMatcher = GOOD): ChainData => ({ deteNames: new Set(), publicPayCandidates: new Map(), matcher });
const advert = (o: Partial<AdvertInput> = {}): AdvertInput => ({
  source: "greenhouse",
  employer: "Acme Widgets",
  title: "Platform Engineer",
  location: "Dublin, Ireland",
  description: "Join our team. The salary is €60,000 a year.",
  employmentType: "",
  salaryBox: "",
  ...o,
});
// Budgets are about three times what was measured on 10 November 2026 (machine shared with other work).
const BUDGET_1000 = 4500; // 1,000 adverts of about 10,000 characters: measured 1.0 to 1.7 s
const BUDGET_LIMIT = 3000; // one advert at its limits: the slowest (30,000 digits in the salary reader) measured 0.82 to 0.97 s
const BUDGET_REFUSED = 50; // one refused advert, even of 1 MB: measured under 1 ms
const TOO_LONG = "0 advert too long (admin queue)";
const timed = async (f: () => Promise<unknown>) => {
  const t = performance.now();
  await f();
  return performance.now() - t;
};

describe("input limits", () => {
  const fields = [
    ["title", "title"],
    ["employer", "employer"],
    ["location", "location"],
    ["employmentType", "employmentType"],
    ["salaryBox", "salaryBox"],
    ["description", "description"],
  ] as const;

  it.each(fields)("%s: at the limit it goes to the rules, one code point over it is refused", async (field) => {
    const limit = INPUT_LIMITS[field];
    // a letter-only filler that no rule cares about; "x" keeps the location and employment type harmless
    const atLimit = await assess(advert({ [field]: "x".repeat(limit) }), data());
    expect(atLimit.stage).not.toBe(TOO_LONG);
    const over = await assess(advert({ [field]: "x".repeat(limit + 1) }), data());
    expect(over.stage).toBe(TOO_LONG);
  });

  it("refuses with the admin queue bucket and every other field as for an advert no rule ran on", async () => {
    expect(await assess(advert({ title: "x".repeat(301), employer: "Acme Recruitment", description: "registration fee, visa sponsorship available" }), data())).toEqual({
      stage: TOO_LONG,
      bucket: "queue",
      reason: null,
      agency: false,
      scamFlag: false,
      sponsorYes: false,
      occupationCode: null,
      occupationConfidence: null,
      contract: null,
      contractReason: null,
      salaryLow: null,
      salaryHigh: null,
      salaryCheck: null,
      bigCompany: null,
      irishVerdict: null,
      irishReason: null,
      publicPayTier: 0,
      sector: "other",
      readsAdvert: false,
    });
  });

  it("does not ask the matcher for a refused advert", async () => {
    const matcher = vi.fn(GOOD);
    await assess(advert({ description: "x".repeat(30001) }), data(matcher));
    expect(matcher).not.toHaveBeenCalled();
  });

  it("counts code points, not UTF-16 units", async () => {
    const emoji = "\u{1F600}"; // 2 units, 1 code point
    expect((await assess(advert({ title: emoji.repeat(300) }), data())).stage).not.toBe(TOO_LONG);
    expect((await assess(advert({ title: emoji.repeat(301) }), data())).stage).toBe(TOO_LONG);
    expect((await assess(advert({ title: emoji.repeat(299) + "a" }), data())).stage).not.toBe(TOO_LONG);
    expect((await assess(advert({ title: emoji.repeat(299) + "ab" }), data())).stage).toBe(TOO_LONG);
    // a lone surrogate is one code point, as in Python
    expect((await assess(advert({ title: "\ud800".repeat(300) }), data())).stage).not.toBe(TOO_LONG);
    expect((await assess(advert({ title: "\ud800".repeat(301) }), data())).stage).toBe(TOO_LONG);
  });

  it("known quirk: the limits are inclusive, the advert is refused only above them", async () => {
    expect(INPUT_LIMITS).toEqual({ title: 300, employer: 200, location: 500, employmentType: 100, salaryBox: 1000, description: 30000 });
  });
});

// Made-up sentences repeated to about 10,000 characters.
const SENTENCES = [
  "We are looking for a Senior Platform Engineer to join our growing team in Dublin.",
  "You will work with cloud, python and sql, 3 to 5 years of experience, 40,000 users.",
  "Benefits include a bonus of 5,000, 25 days holiday, and pension. Pay: 1,2 or 3 months.",
  "Fixed-term and permanent roles. Apply now; send your CV to the team, not a fee. Ireland.",
];
const longText = (seed: number) => {
  let s = "";
  for (let i = 0; s.length < 10_000; i++) s += SENTENCES[(i + seed) % SENTENCES.length] + " ";
  return s;
};

describe("performance", () => {
  it("budget: 1,000 made-up adverts of about 10,000 characters", async () => {
    const adverts = Array.from({ length: 1000 }, (_, i) => advert({ description: "The salary is €" + (50 + (i % 10)) + ",000. " + longText(i) }));
    const ms = await timed(async () => {
      for (const a of adverts) await assess(a, data());
    });
    expect(ms).toBeLessThan(BUDGET_1000);
  });
});

describe("security: hostile input", () => {
  // Each case: an advert shaped to hurt the ported patterns, at exactly the limit (it runs) and far over it (it is refused).
  const at = (n: number, unit: string) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const L = INPUT_LIMITS;
  const cases: [string, Partial<AdvertInput>][] = [
    ["description of digits", { description: at(L.description, "1") }],
    ["description of digits and commas", { description: at(L.description, "1,") }],
    ["description of digit and space pairs", { description: at(L.description, "1 ") }],
    ["description of thousands groups", { description: at(L.description, "123 456 ") }],
    ["description of amounts with k", { description: at(L.description, "1k ") }],
    ["description of euro amounts", { description: at(L.description, "€45,000 ") }],
    ["description of spaces", { description: at(L.description, " ") }],
    ["description of euro signs", { description: at(L.description, "€") }],
    ["description of 'no ' runs", { description: at(L.description, "no ") }],
    ["description of 'pay ' runs", { description: at(L.description, "pay ") }],
    ["description of '6 month ' runs", { description: at(L.description, "6 month ") }],
    ["description of one long line with no spaces", { description: at(L.description, "abcdefghij") }],
    ["description of new lines", { description: at(L.description, "\n") }],
    ["description of HTML and script tags", { description: at(L.description, "<script>alert(1)</script><b>") }],
    ["description of mixed scripts and odd Unicode", { description: at(L.description, "а中ا ​﻿İı́") }],
    ["description with null bytes", { description: at(L.description, "\0") }],
    ["description with astral characters", { description: at(L.description, "\u{1F600}") }],
    ["title of repeated keywords plus a late bim", { title: at(L.title - 3, "operator ") + "bim" }],
    ["title of digits", { title: at(L.title, "9") }],
    ["employer of open brackets", { employer: at(L.employer, "(") }],
    ["employer of spaces", { employer: at(L.employer, " ") }],
    ["location of eircode-like text", { location: at(L.location, "D02 X285 ") }],
    ["location of 'ireland ' runs", { location: at(L.location, "northern ireland ") }],
    ["salary box of digits", { salaryBox: at(L.salaryBox, "1") }],
    ["salary box of money", { salaryBox: at(L.salaryBox, "€1,000 ") }],
    ["employment type of 'contract '", { employmentType: at(L.employmentType, "contract ") }],
    ["every field at its limit at once", { title: at(L.title, "operator "), employer: at(L.employer, "("), location: at(L.location, "dublin "), employmentType: at(L.employmentType, "x"), salaryBox: at(L.salaryBox, "1"), description: at(L.description, "1") }],
  ];

  it.each(cases)("at the limit: %s", async (_name, o) => {
    const t = await timed(async () => {
      const a = await assess(advert(o), data());
      expect(a.stage).not.toBe(TOO_LONG);
    });
    expect(t).toBeLessThan(BUDGET_LIMIT);
  });

  it.each(cases)("a megabyte over the limit is refused at once: %s", async (_name, o) => {
    const big = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, (v as string).repeat(Math.ceil(1_000_000 / (v as string).length))]));
    const t = await timed(async () => expect((await assess(advert(big), data())).stage).toBe(TOO_LONG));
    expect(t).toBeLessThan(BUDGET_REFUSED);
  });

  it("empty and missing fields do not throw", async () => {
    for (const o of [{ title: "", employer: "", location: "", description: "" }, { title: null, employer: undefined, location: null, description: undefined, employmentType: null, salaryBox: null }]) {
      await expect(assess(advert(o), data())).resolves.toMatchObject({ stage: "3 not in Ireland" });
    }
  });

  it("a matcher that throws makes assess throw, not hang or return a wrong answer", async () => {
    await expect(assess(advert(), data(async () => Promise.reject(new Error("matcher down"))))).rejects.toThrow("matcher down");
  });

  it("an object-property name as employer or source is just a name", async () => {
    for (const employer of ["constructor", "__proto__", "toString"]) {
      expect((await assess(advert({ employer, source: "__proto__" }), data())).stage).not.toBe(TOO_LONG);
    }
  });
});
