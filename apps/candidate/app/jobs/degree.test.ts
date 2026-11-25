// Unit: what the degree box says, for every choice and every pay state.
import { describe, expect, it } from "vitest";
import { criticalSkillsResult, degreeChoices, generalResult, standing } from "./degree";
import { MINIMUMS } from "./test-fixtures";

const pay = (salaryLow: number | null, salaryHigh = salaryLow, passRoute: string | null = "stated_pay") => ({ passRoute, salaryLow, salaryHigh });

describe("degree box", () => {
  it("gives the minimum for each answer, read from the rules", () => {
    expect(criticalSkillsResult("relevant", MINIMUMS, pay(78000))).toEqual({ kind: "minimum", minimum: 40904, standing: "clears", basis: null });
    expect(criticalSkillsResult("last_12_months", MINIMUMS, pay(38000))).toEqual({ kind: "minimum", minimum: 36848, standing: "clears", basis: null });
    expect(criticalSkillsResult("none", MINIMUMS, pay(50000))).toEqual({ kind: "minimum", minimum: 68911, standing: "below", basis: null });
  });
  it("takes the length of recent from the rules, never from the page", () => {
    expect(degreeChoices(12)[1]![1]).toContain("last 12 months");
    expect(degreeChoices(18)[1]![1]).toContain("last 18 months");
  });
  it("says the route is closed when there is no minimum for it", () => {
    expect(criticalSkillsResult("none", { ...MINIMUMS, nonList: null }, pay(90000))).toEqual({ kind: "route_closed" });
  });
  it("treats a range that starts below and ends at or above as depending on the start", () => {
    expect(standing(pay(38166, 56592), 40904)).toBe("depends");
    expect(standing(pay(30000, 40000), 40904)).toBe("below");
    expect(standing(pay(40904, 50000), 40904)).toBe("clears");
    expect(standing(pay(null, 50000), 40904)).toBe("clears"); // "up to"
    expect(standing(pay(null, null), 40904)).toBe("unstated");
  });
  it("answers no minimum on a public pay scale with the relevant degree, at any employer", () => {
    for (const hse of [true, false]) for (const c of ["relevant", "last_12_months"] as const) expect(criticalSkillsResult(c, MINIMUMS, { ...pay(null, null, "public_pay"), hse })).toEqual({ kind: "public_pay" });
  });
  it("without one (#67, #300): the HSE keeps its pay scale and says the degree is needed, any other public body gets the higher minimum", () => {
    for (const p of [pay(null, null, "public_pay"), pay(32540, 32540, "public_pay")]) expect(criticalSkillsResult("none", MINIMUMS, { ...p, hse: true })).toEqual({ kind: "public_pay", needsDegree: true });
    expect(criticalSkillsResult("none", MINIMUMS, pay(null, null, "public_pay"))).toEqual({ kind: "minimum", minimum: 68911, standing: "unstated", basis: null });
    expect(criticalSkillsResult("none", MINIMUMS, pay(32540, 32540, "public_pay"))).toMatchObject({ minimum: 68911, standing: "below" });
    expect(criticalSkillsResult("none", { ...MINIMUMS, nonList: null }, pay(null, null, "public_pay"))).toEqual({ kind: "route_closed" });
    expect(criticalSkillsResult("none", MINIMUMS, { ...pay(50000), hse: true })).toMatchObject({ minimum: 68911, standing: "below" }); // an HSE job on stated pay is like any other
  });
  it("explains an unstated salary through the big-company list or a pay floor", () => {
    expect(criticalSkillsResult("relevant", MINIMUMS, pay(null, null, "big_company"))).toMatchObject({ standing: "unstated", basis: "big_company" });
    expect(criticalSkillsResult("relevant", MINIMUMS, pay(null, null, "pay_floor"))).toMatchObject({ standing: "unstated", basis: "pay_floor" });
    expect(criticalSkillsResult("relevant", MINIMUMS, pay(null, null, null))).toMatchObject({ standing: "unstated", basis: null });
  });
  it("uses the General minimum, the lower one for its codes, and nothing until the rules carry it", () => {
    expect(generalResult(MINIMUMS, "2231", pay(40000))).toMatchObject({ minimum: 36605, standing: "clears" });
    expect(generalResult(MINIMUMS, "6145", pay(35000))).toMatchObject({ minimum: 34000, standing: "clears" });
    expect(generalResult({ ...MINIMUMS, general: null }, "2231", pay(40000))).toBeNull();
    expect(generalResult(MINIMUMS, "2231", pay(null, null, "public_pay"))).toEqual({ kind: "public_pay" });
  });
});
