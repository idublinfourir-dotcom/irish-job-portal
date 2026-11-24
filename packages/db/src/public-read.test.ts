import { describe, expect, it } from "vitest";
import { Refuse } from "./candidate-route";
import { BadEligibilityInput } from "@portal/rules";
import { CANDIDATE_READ_RATES, checkerInput, closedJobRead, jobsRead, readLimits, readPaging, retryAfter, tooMany, VISITOR_JOBS, VISITOR_READ_RATES } from "./public-read";
import { BadSearchInput, listJobs, listQuery, PAGE_SIZE } from "./search";
import { scopedQuery } from "./public-pages";

const q = (s = "") => new URLSearchParams(s);
const fakeDb = () => {
  const texts: string[] = [];
  return { texts, query: (async (t: string) => (texts.push(t), { rows: [] })) as never };
};

describe("the cap decision", () => {
  it("is 6 for a visitor, with no cursor; the full page and both cursors for a candidate", () => {
    expect(VISITOR_JOBS).toBe(6);
    expect(readPaging(q("after=x&sort=newest"), false)).toEqual({ limit: PAGE_SIZE, after: "x", before: undefined });
    expect(readPaging(q("before=y"), false)).toEqual({ limit: PAGE_SIZE, after: undefined, before: "y" });
    expect(readPaging(q("sort=newest&page=2&limit=500"), true)).toEqual({ limit: VISITOR_JOBS });
  });
  it("refuses a visitor's cursor, even an empty one", () => {
    for (const s of ["after=x", "before=x", "after=", "before="]) expect(() => readPaging(q(s), true)).toThrow(Refuse);
    try { readPaging(q("after=x"), true); } catch (e) { expect([(e as Refuse).status, (e as Refuse).code]).toEqual([401, "SIGN_IN_FOR_MORE"]); }
  });
  it("a visitor's list asks the database for 7 rows (6 and one to know there are more), a candidate's for 21", async () => {
    const v = fakeDb(), c = fakeDb();
    expect(await jobsRead(v as never, q(), true)).toEqual({ jobs: [], next: null, previous: null, count: { n: 0, more: false }, signInForMore: false });
    await jobsRead(c as never, q(), false);
    expect(v.texts[0]).toContain(`limit ${VISITOR_JOBS + 1}) page`);
    expect(c.texts[0]).toContain(`limit ${PAGE_SIZE + 1}) page`);
  });
  it("a page size outside 1 to PAGE_SIZE is refused before any statement", async () => {
    for (const n of [0, -1, PAGE_SIZE + 1, 1.5, Number.NaN, 1e9]) {
      expect(() => listQuery("sponsor", undefined, "after", {}, n)).toThrow(BadSearchInput);
      expect(() => scopedQuery("company", "1", undefined, n)).toThrow(BadSearchInput);
      await expect(listJobs({ query: () => { throw new Error("ran"); } } as never, { limit: n })).rejects.toThrow(BadSearchInput);
    }
  });
});

describe("the read limits", () => {
  it("are 60 a minute and 600 an hour per address for a visitor, 300 a minute per login for a candidate", () => {
    expect(VISITOR_READ_RATES).toEqual([{ windowMs: 60_000, max: 60 }, { windowMs: 3_600_000, max: 600 }]);
    expect(CANDIDATE_READ_RATES).toEqual([{ windowMs: 60_000, max: 300 }]);
    expect(readLimits({ refused: "no_session" }, "203.0.113.9").map((l) => l.key)).toEqual(["read:ip:203.0.113.9:60000", "read:ip:203.0.113.9:3600000"]);
    expect(readLimits({ refused: "refused" }, "x").map((l) => l.key)).toEqual(["read:ip:x:60000", "read:ip:x:3600000"]); // suspended or deleted: a visitor
    expect(readLimits({ userId: "u1" }, "203.0.113.9").map((l) => l.key)).toEqual(["read:candidate:u1:60000"]); // the address plays no part
  });
  it("retryAfter: null under the limit, else the seconds to the latest window end that is over, at least 1", () => {
    const m = { windowMs: 60_000, max: 60 }, h = { windowMs: 3_600_000, max: 600 };
    expect(retryAfter([{ count: 60, end: 61_000, rate: m }, { count: 600, end: 3_600_000, rate: h }], 1000)).toBeNull();
    expect(retryAfter([{ count: 61, end: 31_000, rate: m }, { count: 5, end: 3_600_000, rate: h }], 1000)).toBe(30);
    expect(retryAfter([{ count: 61, end: 31_000, rate: m }, { count: 601, end: 1_801_500, rate: h }], 1000)).toBe(1801);
    expect(retryAfter([{ count: 61, end: 900, rate: m }], 1000)).toBe(1);
  });
  it("the 429 answer is a code and Retry-After, nothing else", async () => {
    const r = tooMany(42);
    expect([r.status, r.headers.get("retry-after"), await r.json()]).toEqual([429, "42", { code: "TOO_MANY_REQUESTS" }]);
  });
});

describe("the checker input (GET /api/checker)", () => {
  const ok = "occupationCode=2231&annualPay=40000&relevantDegree=true";
  it("takes the checker's inputs, typed, and the optional title", () => {
    expect(checkerInput(q(ok))).toEqual({ input: { occupationCode: "2231", annualPay: 40000, relevantDegree: true, degreeAwardMonth: null, contractMonths: null }, title: null });
    expect(checkerInput(q(`${ok}&degreeAwardMonth=2026-05&contractMonths=24&weeklyHours=37.5&title=Staff%20Nurse`))).toEqual({
      input: { occupationCode: "2231", annualPay: 40000, relevantDegree: true, degreeAwardMonth: "2026-05", contractMonths: 24, weeklyHours: 37.5 }, title: "Staff Nurse",
    });
  });
  it.each([
    "", "occupationCode=2231&annualPay=40000", `${ok}&occupationCode=2232`, `${ok}&limit=5`, `${ok}&__proto__=1`, "occupationCode=223&annualPay=1&relevantDegree=true",
    "occupationCode=2231&annualPay=1e5&relevantDegree=true", "occupationCode=2231&annualPay=-1&relevantDegree=true", "occupationCode=2231&annualPay=NaN&relevantDegree=true",
    "occupationCode=2231&annualPay=12345678&relevantDegree=true", "occupationCode=2231&annualPay=1&relevantDegree=yes", `${ok}&degreeAwardMonth=2026-13`,
    `${ok}&contractMonths=-3`, `${ok}&contractMonths=1.5`, `${ok}&weeklyHours=100`, `${ok}&title=`, `${ok}&title=${"a".repeat(201)}`, `${ok}&title=a%00b`,
    `${ok}&title=a%E2%80%AEb`, "occupationCode=2231%27%3B--&annualPay=1&relevantDegree=true",
  ])("refuses %j", (s) => expect(() => checkerInput(q(s))).toThrow(BadEligibilityInput));
});

describe("B27: the closed-job read", () => {
  it("runs no statement for a missing, empty or bad id, and says not found", async () => {
    const d = fakeDb();
    for (const s of ["", "id=", "id=0", "id=-1", "id=1;drop", "id=1e3", `id=${"9".repeat(40)}`, "id=%00"]) expect(await closedJobRead(d as never, q(s), true), s).toBeNull();
    expect(d.texts).toEqual([]);
  });
  it("a well-formed id asks one statement, and an empty answer is null (not found)", async () => {
    const d = fakeDb();
    expect(await closedJobRead(d as never, q("id=42"), true)).toBeNull();
    expect(d.texts).toHaveLength(1);
    expect(d.texts[0]).toContain("from private.candidate_closed_job($1::bigint)"); // the function answers only closed and expired (0075)
    expect(d.texts[0]).not.toMatch(/close_reason|from job\b/); // never the column or the table itself
  });
});
