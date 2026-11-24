import { describe, expect, it } from "vitest";
import {
  BadEligibilityInput, checkEligibility, MINIMUMS_V1, minimumForHours, monthsSince, RULES_CHECKED_ON, standingLine, writtenDate, type EligibilityInput, type EligibilityReason,
} from "./index";

const lists = [
  { code: "2136", list: "critical-skills" }, { code: "1225", list: "ineligible" },
  { code: "2229", list: "critical-skills" }, { code: "2229", list: "ineligible" },
];
const NOW = new Date("2026-11-12T10:00:00Z");
const base: EligibilityInput = { occupationCode: "2136", annualPay: 50_000, relevantDegree: true, contractMonths: 24 };
const run = (o: Partial<EligibilityInput>, opts: { nonListRoute?: boolean } = {}) => checkEligibility({ ...base, ...o }, { minimums: MINIMUMS_V1, occupationLists: lists }, { now: NOW, ...opts });

describe("minimumForHours", () => {
  it("is the annual minimum up to 39 hours", () => {
    for (const h of [1, 20, 38.5, 39]) expect(minimumForHours(40_904, h)).toBe(40_904);
  });
  it("40 hours at 40,904 is exactly 41,953.60 (DETE's own figure)", () => expect(minimumForHours(40_904, 40)).toBe(41_953.6));
  it("never goes down as hours go up", () => {
    let last = 0;
    for (let h = 39; h <= 60; h += 0.5) { const m = minimumForHours(68_911, h); expect(m).toBeGreaterThanOrEqual(last); last = m; }
  });
});

describe("checkEligibility outcomes", () => {
  const cases: [string, Partial<EligibilityInput>, boolean, EligibilityReason, number | null][] = [
    ["listed, degree, exactly at 40,904", { annualPay: 40_904 }, true, "listed_degree", 40_904],
    ["listed, degree, one euro below", { annualPay: 40_903 }, false, "below_minimum", 40_904],
    ["listed, degree, 39 hours at 40,904", { annualPay: 40_904, weeklyHours: 39 }, true, "listed_degree", 40_904],
    ["listed, degree, 40 hours at 41,953.59", { annualPay: 41_953.59, weeklyHours: 40 }, false, "below_minimum", 41_953.6],
    ["listed, degree, 40 hours at 41,953.60", { annualPay: 41_953.6, weeklyHours: 40 }, true, "listed_degree", 41_953.6],
    ["graduate, awarded this month, exactly at 36,848", { annualPay: 36_848, degreeAwardMonth: "2026-11" }, true, "recent_graduate", 36_848],
    ["graduate, one euro below", { annualPay: 36_847, degreeAwardMonth: "2026-11" }, false, "below_minimum", 36_848],
    ["graduate, 12 months ago (the boundary)", { annualPay: 36_848, degreeAwardMonth: "2025-11" }, true, "recent_graduate", 36_848],
    ["graduate, 13 months ago: the full minimum applies", { annualPay: 36_848, degreeAwardMonth: "2025-10" }, false, "below_minimum", 40_904],
    ["graduate, 13 months ago, at 40,904", { annualPay: 40_904, degreeAwardMonth: "2025-10" }, true, "listed_degree", 40_904],
    ["award month still ahead: not a graduate", { annualPay: 36_848, degreeAwardMonth: "2026-12" }, false, "below_minimum", 40_904],
    ["graduate month given but no degree", { annualPay: 36_848, relevantDegree: false, degreeAwardMonth: "2026-11" }, false, "degree_needed", 68_911],
    ["listed, no degree, below 68,911", { annualPay: 60_000, relevantDegree: false }, false, "degree_needed", 68_911],
    ["listed, no degree, exactly 68,911", { annualPay: 68_911, relevantDegree: false }, true, "non_list_route", 68_911],
    ["listed, degree, high pay still names its own route", { annualPay: 90_000 }, true, "listed_degree", 40_904],
    ["not on a list, exactly 68,911", { occupationCode: "3111", annualPay: 68_911, relevantDegree: false }, true, "non_list_route", 68_911],
    ["not on a list, one euro below", { occupationCode: "3111", annualPay: 68_910, relevantDegree: false }, false, "below_minimum", 68_911],
    ["not on a list, a degree does not lower the minimum", { occupationCode: "3111", annualPay: 50_000 }, false, "below_minimum", 68_911],
    ["not on a list, 40 hours needs more", { occupationCode: "3111", annualPay: 68_911, weeklyHours: 40 }, false, "below_minimum", 70_678.4],
    ["ineligible, any pay", { occupationCode: "1225", annualPay: 500_000 }, false, "ineligible", null],
    ["both lists: the Critical Skills entry wins", { occupationCode: "2229", annualPay: 40_904 }, true, "listed_degree", 40_904],
    ["contract 23 months", { contractMonths: 23 }, false, "contract_too_short", null],
    ["contract 24 months", { contractMonths: 24 }, true, "listed_degree", 40_904],
    ["permanent (no end date)", { contractMonths: null }, true, "listed_degree", 40_904],
    ["short contract beats high pay", { contractMonths: 6, annualPay: 200_000 }, false, "contract_too_short", null],
    ["ineligible beats a short contract", { occupationCode: "1225", contractMonths: 6 }, false, "ineligible", null],
    ["code not four digits", { occupationCode: "21" }, false, "unknown_code", null],
    ["four digits but not SOC 2010", { occupationCode: "9999" }, false, "unknown_code", null],
    ["0000", { occupationCode: "0000" }, false, "unknown_code", null],
    ["1110, just outside a real range", { occupationCode: "1110" }, false, "unknown_code", null],
    ["code with letters", { occupationCode: "21a6" }, false, "unknown_code", null],
    ["code with SQL", { occupationCode: "1; drop table job" }, false, "unknown_code", null],
  ];
  it.each(cases)("%s", (_name, o, qualifies, reason, minimum) => {
    const r = run(o);
    expect(r.reason).toBe(reason);
    expect(r.qualifies).toBe(qualifies);
    expect(r.minimum).toBe(minimum);
    expect(r.why.length).toBeGreaterThan(10);
    expect(r.standingLine).toBe(standingLine(RULES_CHECKED_ON));
    expect(r.standingLine).toBe(`Our check is guidance, not a permit decision. Only DETE decides. Rules last checked on ${writtenDate(RULES_CHECKED_ON)}.`);
    expect(r.rulesCheckedOn).toBe(RULES_CHECKED_ON);
  });
  it("the 68,911 route says DETE asks for experience when there is no degree", () => {
    expect(run({ relevantDegree: false, annualPay: 70_000 }).why).toMatch(/necessary level of experience/);
  });
  it("with the 68,911 route closed (#225), a non-list role and a degree-less listed role cannot qualify", () => {
    expect(run({ occupationCode: "3111", annualPay: 200_000 }, { nonListRoute: false })).toMatchObject({ qualifies: false, reason: "non_list_route_blocked" });
    expect(run({ relevantDegree: false, annualPay: 200_000 }, { nonListRoute: false })).toMatchObject({ qualifies: false, reason: "degree_needed" });
    expect(run({ annualPay: 40_904 }, { nonListRoute: false }).qualifies).toBe(true);
  });
  it("the route is open as shipped", () => expect(run({ occupationCode: "3111", annualPay: 70_000 }).qualifies).toBe(true));
  it("the date is 12 November 2026", () => expect(RULES_CHECKED_ON).toBe("2026-11-12"));
});

describe("checkEligibility hostile input", () => {
  const bad: Partial<EligibilityInput>[] = [
    { annualPay: NaN }, { annualPay: Infinity }, { annualPay: -1 }, { annualPay: "5" as unknown as number },
    { weeklyHours: 0 }, { weeklyHours: 0.5 }, { weeklyHours: 61 }, { weeklyHours: NaN }, { weeklyHours: "40" as unknown as number },
    { contractMonths: -1 }, { contractMonths: NaN }, { contractMonths: "24" as unknown as number },
    { relevantDegree: "yes" as unknown as boolean }, { occupationCode: 2136 as unknown as string },
    { degreeAwardMonth: "2026-13" }, { degreeAwardMonth: "2026-1" }, { degreeAwardMonth: "2026-11-01" }, { degreeAwardMonth: "last year" }, { degreeAwardMonth: "2026-00" },
  ];
  it.each(bad)("refuses %j", (o) => expect(() => run(o)).toThrow(BadEligibilityInput));
  it("accepts 1 and 60 hours", () => { expect(() => run({ weeklyHours: 1 })).not.toThrow(); expect(() => run({ weeklyHours: 60 })).not.toThrow(); });
  it("ignores the award month when there is no degree", () => expect(() => run({ relevantDegree: false, degreeAwardMonth: "junk" })).not.toThrow());
});

describe("monthsSince", () => {
  it("counts calendar months", () => {
    expect(monthsSince("2026-11", NOW)).toBe(0);
    expect(monthsSince("2025-11", NOW)).toBe(12);
    expect(monthsSince("2026-12", NOW)).toBe(-1);
    expect(monthsSince("2019-01", NOW)).toBe(94);
  });
});
