// No database: the alert body checks, the unsubscribe link check and the filters in words.
import { describe, expect, it } from "vitest";
import { checkAlert, checkAlertEdit, checkAlertId, describeAlert, newToken, TOKEN, unsubscribeParams } from "./alerts";

const occ = new Set(["2111", "2231"]);
const create = checkAlert(occ), edit = checkAlertEdit(occ);

describe("checkAlert", () => {
  it("needs a frequency, and absent or null filters mean any", () => {
    expect(create({ frequency: "weekly" })).toEqual({ occupation_code: null, sector: null, county: null, salary_min: null, badge: null, frequency: "weekly" });
    expect(create({ frequency: "daily", county: null, salaryMin: null })).toMatchObject({ county: null, salary_min: null });
    expect(create({})).toBeNull();
    expect(create({ frequency: "monthly" })).toBeNull();
  });
  it("maps every filter to its column", () => {
    expect(create({ occupationCode: "2111", sector: "IT", county: "Cork", salaryMin: 0, badge: "sponsor_confirmed", frequency: "daily" }))
      .toEqual({ occupation_code: "2111", sector: "IT", county: "Cork", salary_min: 0, badge: "sponsor_confirmed", frequency: "daily" });
  });
  it("refuses a value outside its list or range, free text, unknown fields and non-objects", () => {
    for (const b of [{ occupationCode: "9999" }, { sector: "it" }, { county: "Narnia" }, { salaryMin: -1 }, { salaryMin: 1_000_001 }, { salaryMin: 2.5 }, { salaryMin: "5" }, { badge: "other" },
      { searchText: "x" }, { search_text: "x" }, { id: "1" }]) expect(create({ frequency: "daily", ...b }), JSON.stringify(b)).toBeNull();
    for (const b of [null, [], "x", 5, undefined]) expect(create(b)).toBeNull();
  });
});
describe("checkAlertEdit and checkAlertId", () => {
  it("need a numeric id, and refuse anything else", () => {
    expect(edit({ id: "12", frequency: "daily" })).toMatchObject({ id: "12", frequency: "daily" });
    for (const id of ["", "x", "1e3", "-1", 12, "99999999999999999999"]) expect(edit({ id, frequency: "daily" }), String(id)).toBeNull();
    expect(checkAlertId({ id: "7" })).toEqual({ id: "7" });
    expect(checkAlertId({ id: "7", extra: 1 })).toBeNull();
  });
});
describe("tokens and unsubscribe links", () => {
  it("makes unique tokens of 32 characters that pass the link check", () => {
    const t = newToken();
    expect(t).toHaveLength(32);
    expect(TOKEN.test(t)).toBe(true);
    expect(newToken()).not.toBe(t);
  });
  it("accepts a good token with scope one or all, and refuses the rest", () => {
    const t = "a".repeat(32);
    expect(unsubscribeParams(new URL(`https://x.test/u?token=${t}&scope=all`))).toEqual({ token: t, scope: "all" });
    for (const q of ["", `?token=${t}`, `?token=${t}&scope=none`, `?token=${t.slice(1)}&scope=one`, `?token=${t}!&scope=one`, `?token=${t}${t}${t}&scope=one`])
      expect(unsubscribeParams(new URL(`https://x.test/u${q}`)), q).toBeNull();
  });
});
describe("describeAlert", () => {
  it("says each filter in words and nothing for an unfiltered alert", () => {
    expect(describeAlert({ occupationCode: null, sector: null, county: null, salaryMin: null, badge: null })).toEqual([]);
    const words = describeAlert({ occupationCode: "2111", sector: "IT", county: "Cork", salaryMin: 0, badge: "sponsor_confirmed" });
    expect(words).toHaveLength(5);
    expect(words[0]).toMatch(/^Occupation: .+ \(2111\)$/);
    expect(words.slice(1)).toEqual(["Sector: IT", "County: Cork", "Pay from EUR 0 a year", "Sponsor confirmed jobs only"]);
    expect(describeAlert({ occupationCode: null, sector: null, county: null, salaryMin: null, badge: "critical_skills_eligible" })).toEqual(["Critical Skills eligible jobs only"]);
  });
});
