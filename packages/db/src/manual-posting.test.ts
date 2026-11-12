// Manual posting: the body check and the rules check, with no database and no network (the rules chain is local code; the matcher is a fake inside manualVerdict).
import { describe, expect, it } from "vitest";
import { QueueRefused } from "./admin-queue";
import { checkManualPost, manualVerdict, type ManualPost } from "./manual-posting";
import { companyRefusal } from "./merges";

const desc = "We are hiring a software engineer to build our payments platform in Dublin. Full sponsorship offered.";
const good = {
  organisationId: "7", title: "Software Engineer", description: desc, county: "Dublin", occupationCode: "2136", contractMonths: null, salaryLow: 50000, salaryHigh: 60000,
  weeklyHours: 39, closesOn: "2030-01-31", applyUrl: "https://careers.example.ie/jobs/1",
};
const why = (b: unknown) => { try { checkManualPost(b); } catch (e) { return e instanceof QueueRefused ? e.why : "other"; } return "ok"; };

describe("checkManualPost", () => {
  it("accepts a good post and fills the optional fields with null", () => {
    expect(checkManualPost(good)).toMatchObject({ organisationId: "7", title: "Software Engineer", payGrade: null, healthInsuranceEur: null, contractMonths: null });
    expect(why({ ...good, salaryHigh: undefined })).toBe("ok");
    expect(why({ ...good, salaryLow: null, salaryHigh: null, payGrade: "Grade VI" })).toBe("ok");
    expect(why({ ...good, contractMonths: 24, healthInsuranceEur: 0 })).toBe("ok");
  });
  it("trims the text fields", () => {
    expect(checkManualPost({ ...good, title: "  Engineer  ", description: `  ${desc}  ` })).toMatchObject({ title: "Engineer", description: desc });
  });
  it("refuses unknown fields, a badge, non-objects and every bad field with its own code", () => {
    for (const b of [null, [], "x", 5, { ...good, badge: "sponsor_confirmed" }, { ...good, posted_by_staff_id: "s" }, { ...good, __proto__x: 1 }]) expect(why(b)).toBe("bad_body");
    const cases: [object, string][] = [
      [{ organisationId: 7 }, "bad_organisation_id"], [{ organisationId: "0" }, "bad_organisation_id"], [{ title: "a\nb" }, "bad_title"], [{ title: "​ab" }, "bad_title"],
      [{ title: "x".repeat(201) }, "bad_title"], [{ description: "short" }, "bad_description"], [{ description: "x".repeat(10_001) }, "bad_description"],
      [{ description: desc + "\u0007" }, "bad_description"], [{ county: "dublin" }, "bad_county"], [{ occupationCode: "02136" }, "bad_occupation_code"],
      [{ contractMonths: 0 }, "bad_contract_months"], [{ contractMonths: 601 }, "bad_contract_months"], [{ contractMonths: 24.5 }, "bad_contract_months"],
      [{ salaryLow: "5" }, "bad_salary"], [{ salaryLow: 0 }, "bad_salary"], [{ salaryHigh: 49999 }, "bad_salary"], [{ salaryLow: null, salaryHigh: null }, "bad_salary"],
      [{ payGrade: "" }, "bad_pay_grade"], [{ healthInsuranceEur: 50_001 }, "bad_health_insurance"], [{ weeklyHours: 39.5 }, "bad_weekly_hours"],
      [{ closesOn: "2030-02-30" }, "bad_closes_on"], [{ closesOn: "2030-1-1" }, "bad_closes_on"], [{ closesOn: 20300101 }, "bad_closes_on"],
      [{ applyUrl: "https://a" }, "bad_apply_url"], [{ applyUrl: "ftp://files.example.ie/x" }, "bad_apply_url"], [{ applyUrl: "https://u:p@x.example.ie/a" }, "bad_apply_url"],
    ];
    for (const [x, code] of cases) expect(why({ ...good, ...x }), JSON.stringify(x)).toBe(code);
  });
});

describe("manualVerdict", () => {
  const post = (x: object = {}) => checkManualPost({ ...good, ...x }) as ManualPost;
  it("passes at the Critical Skills minimum (>=) and fails a euro below", async () => {
    expect(await manualVerdict(post({ salaryLow: 40904, salaryHigh: null }), "Fake Payments Limited")).toMatchObject({ ok: true, passRoute: "stated_pay" });
    expect(await manualVerdict(post({ salaryLow: 40903, salaryHigh: null }), "Fake Payments Limited")).toEqual({ ok: false, code: "pay_below_minimum" });
  });
  it("counts the top of a range and the employer-paid health insurance, and scales the minimum for long hours", async () => {
    expect(await manualVerdict(post({ salaryLow: 30000, salaryHigh: 38000, healthInsuranceEur: 2904 }), "Fake Co")).toMatchObject({ ok: true });
    expect(await manualVerdict(post({ salaryLow: 41953, salaryHigh: null, weeklyHours: 40 }), "Fake Co")).toMatchObject({ ok: false, code: "pay_below_minimum" });
    expect(await manualVerdict(post({ salaryLow: 41954, salaryHigh: null, weeklyHours: 40 }), "Fake Co")).toMatchObject({ ok: true });
  });
  it("needs a list occupation (not an ineligible or unlisted one) and a fixed term of 24 months or more", async () => {
    expect(await manualVerdict(post({ occupationCode: "4112" }), "Fake Co")).toEqual({ ok: false, code: "occupation_ineligible" });
    expect(await manualVerdict(post({ occupationCode: "3545", salaryLow: 90000, salaryHigh: null }), "Fake Co")).toEqual({ ok: false, code: "occupation_not_on_list" });
    expect(await manualVerdict(post({ contractMonths: 23 }), "Fake Co")).toEqual({ ok: false, code: "contract_too_short" });
    expect(await manualVerdict(post({ contractMonths: 24 }), "Fake Co")).toMatchObject({ ok: true });
  });
  it("fails the rules chain on no-sponsorship wording, and holds scam wording back for review", async () => {
    expect(await manualVerdict(post({ description: desc + " We cannot offer visa sponsorship." }), "Fake Co")).toMatchObject({ ok: false, code: "rules_failed" });
    expect(await manualVerdict(post({ description: desc + " Candidates must pay a registration fee before the interview." }), "Fake Co")).toMatchObject({ ok: false, code: "needs_review" });
  });
  it("asks for pay when there is only a grade", async () => {
    expect(await manualVerdict(post({ salaryLow: null, salaryHigh: null, payGrade: "Grade VI" }), "Fake Co")).toEqual({ ok: false, code: "pay_required" });
  });
});

describe("companyRefusal", () => {
  it("turns a '<what> refused: CODE' error into a lower-case QueueRefused and rethrows anything else", () => {
    const e = (message: string, code = "P0001") => Object.assign(new Error(message), { code });
    expect(() => companyRefusal(e("merge refused: ALREADY_MERGED the absorbed company"))).toThrowError(expect.objectContaining({ why: "already_merged" }));
    expect(() => companyRefusal(e("staff refused: NOT_ACTIVE_STAFF"))).toThrowError(expect.objectContaining({ why: "not_active_staff" }));
    expect(() => companyRefusal(e("owner reassign refused: TOO_EARLY the 7 days"))).toThrowError(expect.objectContaining({ why: "too_early" }));
    for (const x of [e("job refused: the organisation is not verified"), e("merge refused: ALREADY_MERGED", "23505"), e("boom"), new Error("merge refused: ALREADY_MERGED")]) {
      try { companyRefusal(x); } catch (r) { expect(r).toBe(x); }
    }
  });
});
