// Manual posting: the body check and the rules check, with no database and no network (the rules chain is local code; the matcher is a fake inside manualVerdict).
import { offScale, rulesV1 } from "@portal/rules";
import { describe, expect, it } from "vitest";
import { QueueRefused } from "./admin-queue";
import { checkManualPost, manualChecks, manualVerdict, type ManualPost } from "./manual-posting";
import { companyRefusal } from "./merges";

const v1 = await rulesV1(); // version 1 of the rules (the seed), as the database holds it

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
      [{ description: desc + "\u0007" }, "bad_description"], [{ county: "dublin" }, "bad_county"], [{ occupationCode: "02136" }, "bad_occupation_code"], [{ occupationCode: "9999" }, "bad_occupation_code"], [{ occupationCode: "1110" }, "bad_occupation_code"], [{ occupationCode: "0000" }, "bad_occupation_code"],
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
    expect(await manualVerdict(post({ salaryLow: 40904, salaryHigh: null }), "Fake Payments Limited", v1)).toMatchObject({ ok: true, passRoute: "stated_pay" });
    expect(await manualVerdict(post({ salaryLow: 40903, salaryHigh: null }), "Fake Payments Limited", v1)).toEqual({ ok: false, code: "pay_below_minimum" });
  });
  it("counts the top of a range and the employer-paid health insurance, and scales the minimum for long hours", async () => {
    expect(await manualVerdict(post({ salaryLow: 30000, salaryHigh: 38000, healthInsuranceEur: 2904 }), "Fake Co", v1)).toMatchObject({ ok: true });
    expect(await manualVerdict(post({ salaryLow: 41953, salaryHigh: null, weeklyHours: 40 }), "Fake Co", v1)).toMatchObject({ ok: false, code: "pay_below_minimum" });
    expect(await manualVerdict(post({ salaryLow: 41954, salaryHigh: null, weeklyHours: 40 }), "Fake Co", v1)).toMatchObject({ ok: true });
  });
  it("refuses an Ineligible occupation, takes a role off the list at the non-list minimum (#225, #150), and needs a fixed term of 24 months or more", async () => {
    expect(await manualVerdict(post({ occupationCode: "4112" }), "Fake Co", v1)).toEqual({ ok: false, code: "occupation_ineligible" });
    expect(await manualVerdict(post({ occupationCode: "3545", salaryLow: 68911, salaryHigh: null }), "Fake Co", v1)).toMatchObject({ ok: true, passRoute: "stated_pay" });
    expect(await manualVerdict(post({ occupationCode: "3545", salaryLow: 68910, salaryHigh: null }), "Fake Co", v1)).toEqual({ ok: false, code: "pay_below_minimum" });
    expect(await manualVerdict(post({ occupationCode: "3545", salaryLow: 90000, salaryHigh: null }), "Fake Co", { ...v1, minimums: { ...v1.minimums, nonListRoute: false } })).toEqual({ ok: false, code: "occupation_not_on_list" });
    expect(await manualVerdict(post({ contractMonths: 23 }), "Fake Co", v1)).toEqual({ ok: false, code: "contract_too_short" });
    expect(await manualVerdict(post({ contractMonths: 24 }), "Fake Co", v1)).toMatchObject({ ok: true });
  });
  it("fails the rules chain on no-sponsorship wording, and holds scam wording back for review", async () => {
    expect(await manualVerdict(post({ description: desc + " We cannot offer visa sponsorship." }), "Fake Co", v1)).toMatchObject({ ok: false, code: "rules_failed" });
    expect(await manualVerdict(post({ description: desc + " Candidates must pay a registration fee before the interview." }), "Fake Co", v1)).toMatchObject({ ok: false, code: "needs_review" });
  });
  it("asks for pay when there is only a grade", async () => {
    expect(await manualVerdict(post({ salaryLow: null, salaryHigh: null, payGrade: "Grade VI" }), "Fake Co", v1)).toEqual({ ok: false, code: "pay_required" });
  });
  it("a public pay employer with a listed grade needs its stated pay on the scale (#269); free text and no version as before", async () => {
    const r = { ...v1, payScales: [{ code: "2135", title: "Staff Nurse", firstEur: 38166, lastEur: 56592, sourceUrl: "https://example.test/p.pdf", sourcePage: 14 }] };
    const nurse = (o: Partial<ManualPost>) => post({ title: "Staff Nurse", occupationCode: "2231", salaryLow: 39000, salaryHigh: null, payGrade: "2135", ...o });
    expect(await manualVerdict(nurse({}), "HSE South West", r)).toMatchObject({ ok: true, passRoute: "public_pay" });
    expect(await manualVerdict(nurse({ salaryLow: 38000 }), "HSE South West", r)).toEqual({ ok: false, code: "pay_not_on_scale" });
    expect(await manualVerdict(nurse({ salaryLow: 38000, payGrade: "Staff Nurse scale" }), "HSE South West", r)).toMatchObject({ ok: true, passRoute: "public_pay" });
    expect(await manualVerdict(nurse({ salaryLow: 38000 }), "HSE South West", v1)).toMatchObject({ ok: true, passRoute: "public_pay" }); // no version in force
    expect(await manualVerdict(nurse({}), "Fake Co", r)).toEqual({ ok: false, code: "pay_below_minimum" });
    // the one rule both posts use: the edges of the scale count, a null grade or no stated pay is never off it
    expect([offScale(r, "2135", 38166, 56592), offScale(r, "2135", 38165, null), offScale(r, "2135", 40000, 56593), offScale(r, "2135", null, null), offScale(r, null, 1, 1), offScale(r, "x", 1, 1)])
      .toEqual([false, true, true, false, false, false]);
  });
});

describe("manualChecks (B72)", () => {
  const run = (x: object = {}, name = "Fake Co") => manualChecks(checkManualPost({ ...good, ...x }), name, v1);
  it("lists every check with its facts, all passing", async () => {
    const { verdict, checks } = await run();
    expect(verdict.ok).toBe(true);
    expect(checks.map((c) => [c.id, c.state])).toEqual([["occupation", "pass"], ["contract", "pass"], ["wording", "pass"], ["money", "pass"], ["pay", "pass"]]);
    expect(checks.find((c) => c.id === "pay")!.detail).toEqual({ minimumEur: 40904, countedEur: 60000, healthInsuranceEur: 0, weeklyHours: 39, route: "stated_pay" });
  });
  it("goes on after a blocked check, and the verdict is the first refusal", async () => {
    const { verdict, checks } = await run({ occupationCode: "4112", contractMonths: 12, salaryLow: 20000, salaryHigh: null, description: desc + " Candidates must pay a registration fee before the interview." });
    expect(verdict).toEqual({ ok: false, code: "occupation_ineligible" });
    expect(Object.fromEntries(checks.map((c) => [c.id, c.code ?? null]))).toMatchObject({ occupation: "occupation_ineligible", contract: "contract_too_short", money: "needs_review", pay: "pay_below_minimum" });
    expect(checks.find((c) => c.id === "money")!.detail).toEqual({ phrase: "pay a registration fee" });
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
