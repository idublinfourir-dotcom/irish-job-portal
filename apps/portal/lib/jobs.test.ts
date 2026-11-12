// No database: the post body checks, the hours minimum, the rules verdicts and the refusal codes. The routes end to end: packages/db/test/jobs-route.test.ts.
import { rulesV1 } from "@portal/rules";
import { describe, expect, it } from "vitest";
import { checkClose, checkEdit, checkPost, checkRenew, jobRefusal, minimumForHours, rulesFor, type Post } from "./jobs";

const desc = "We are hiring a software engineer to build our payments platform in Dublin. Full sponsorship offered.";
export const good = {
  status: "live", title: "Software Engineer", description: desc, county: "Dublin", occupationCode: "2136", contractType: "permanent",
  salaryLow: 50000, salaryHigh: 60000, ownPageUrl: "https://careers.example.ie/jobs/1",
};
const post = (o: object = {}) => checkPost({ ...good, ...o }) as Post;

describe("minimumForHours (DETE's 39-hour week)", () => {
  it("is the annual minimum up to 39 hours and the hourly rate in cents times the hours above", () => {
    expect(minimumForHours(40904, 39)).toBe(40904);
    expect(minimumForHours(40904, 20)).toBe(40904);
    expect(minimumForHours(40904, 40)).toBe(41953.6);
    expect(41953.59 >= minimumForHours(40904, 40)).toBe(false);
    expect(41953.6 >= minimumForHours(40904, 40)).toBe(true);
    expect(minimumForHours(68911, 39)).toBe(68911);
    expect(minimumForHours(68911, 45)).toBeGreaterThan(68911);
  });
});

describe("checkPost", () => {
  it("accepts a good body, trims, and fills the defaults", () => {
    expect(checkPost({ ...good, title: "  Software Engineer " })).toEqual({
      ...good, title: "Software Engineer", contractMonths: null, payGrade: null, healthInsuranceEur: null, weeklyHours: 39, clientName: null, statement: null,
    });
    expect(post({ contractType: "fixed_term", contractMonths: 24 }).contractMonths).toBe(24);
    expect(post({ salaryLow: null, salaryHigh: null, payGrade: "Clinical Nurse Manager 2" }).payGrade).toBe("Clinical Nurse Manager 2");
    expect(post({ statement: { signerName: "Fake Signer", signerTitle: "HR Director" } }).statement).toEqual({ signerName: "Fake Signer", signerTitle: "HR Director", writtenAuthority: false });
    expect(post({ weeklyHours: 60 }).weeklyHours).toBe(60);
    expect(post({ status: "draft" }).status).toBe("draft");
  });
  it.each([
    ["null", null], ["array", []], ["unknown field", { ...good, badge: "sponsor_confirmed" }], ["passRoute sent", { ...good, passRoute: "big_company" }],
    ["organisation sent", { ...good, organisationId: 1 }], ["status closed", { ...good, status: "closed" }], ["status missing", { ...good, status: undefined }],
    ["short title", { ...good, title: "x" }], ["long title", { ...good, title: "x".repeat(201) }], ["rtl title", { ...good, title: "Eng‮ineer" }],
    ["zero width title", { ...good, title: "Eng​ineer" }], ["newline title", { ...good, title: "a\nb" }],
    ["short advert", { ...good, description: "too short" }], ["long advert", { ...good, description: "x".repeat(10_001) }],
    ["null char advert", { ...good, description: desc + "\u0000" }], ["bidi advert", { ...good, description: desc + "⁦" }],
    ["county London", { ...good, county: "London" }], ["county lower case", { ...good, county: "dublin" }], ["county Antrim", { ...good, county: "Antrim" }],
    ["code letters", { ...good, occupationCode: "21a6" }], ["code 5 digits", { ...good, occupationCode: "21366" }], ["code number", { ...good, occupationCode: 2136 }],
    ["code 0xxx", { ...good, occupationCode: "0136" }], ["contract odd", { ...good, contractType: "temp" }],
    ["fixed term no months", { ...good, contractType: "fixed_term" }], ["permanent with months", { ...good, contractMonths: 24 }],
    ["months 0", { ...good, contractType: "fixed_term", contractMonths: 0 }], ["months float", { ...good, contractType: "fixed_term", contractMonths: 24.5 }],
    ["no pay", { ...good, salaryLow: null, salaryHigh: null }], ["top only", { ...good, salaryLow: null, payGrade: "x" }],
    ["top below bottom", { ...good, salaryHigh: 40000 }], ["pay string", { ...good, salaryLow: "50000" }], ["pay float", { ...good, salaryLow: 50000.5 }],
    ["pay negative", { ...good, salaryLow: -1 }], ["pay huge", { ...good, salaryLow: 1e9 }], ["hours 0", { ...good, weeklyHours: 0 }],
    ["hours 61", { ...good, weeklyHours: 61 }], ["hours float", { ...good, weeklyHours: 39.5 }], ["hours null", { ...good, weeklyHours: null }],
    ["health negative", { ...good, healthInsuranceEur: -5 }], ["http url", { ...good, ownPageUrl: "http://careers.example.ie/jobs/1" }],
    ["javascript url", { ...good, ownPageUrl: "javascript:alert(1)//aaaa" }], ["url with login", { ...good, ownPageUrl: "https://a:b@careers.example.ie/x" }],
    ["url not a url", { ...good, ownPageUrl: "not a url at all" }], ["client control", { ...good, clientName: "Acme\u0007" }],
    ["statement extra", { ...good, statement: { signerName: "A Name", signerTitle: "CEO", kind: "admin_on_behalf" } }],
    ["statement no title", { ...good, statement: { signerName: "A Name" } }], ["statement authority string", { ...good, statement: { signerName: "A Name", signerTitle: "CEO", writtenAuthority: "yes" } }],
  ])("refuses %s", (_n, b) => expect(checkPost(b)).toBeNull());
});

describe("checkEdit, checkRenew, checkClose", () => {
  it("edit takes the whole post and a job id", () => {
    expect(checkEdit({ ...good, jobId: 5 })?.jobId).toBe(5);
    for (const jobId of [0, -1, "5", 1.5, 1e30, undefined]) expect(checkEdit({ ...good, jobId })).toBeNull();
    expect(checkEdit({ ...good, jobId: 5, extra: 1 })).toBeNull();
  });
  it("renew takes an optional hire answer, close needs one (#49)", () => {
    expect(checkRenew({ jobId: 3 })).toEqual({ jobId: 3, hireAnswer: null });
    expect(checkRenew({ jobId: 3, hireAnswer: "yes" })).toEqual({ jobId: 3, hireAnswer: "yes" });
    expect(checkClose({ jobId: 3, hireAnswer: "no" })).toEqual({ jobId: 3, hireAnswer: "no" });
    for (const b of [{ jobId: 3 }, { jobId: 3, hireAnswer: "maybe" }, { jobId: 3, hireAnswer: "no", x: 1 }, { hireAnswer: "no" }, null]) expect(checkClose(b)).toBeNull();
  });
});

describe("rulesFor", () => {
  const run = async (o: object = {}, employer = "Fake Payments Limited") => rulesFor(post(o), employer, await rulesV1());
  it("reads the rules in force (#229): a changed snapshot changes the verdict", async () => {
    const today = await rulesV1();
    const at = (m: object) => rulesFor(post({ salaryLow: 45000, salaryHigh: null }), "Fake Payments Limited", { ...today, minimums: { ...today.minimums, ...m } });
    expect(await at({})).toMatchObject({ ok: true, passRoute: "stated_pay" });
    expect(await at({ criticalSkills: 45001 })).toEqual({ ok: false, code: "PAY_BELOW_MINIMUM" });
    expect(await rulesFor(post({ contractType: "fixed_term", contractMonths: 30 }), "Fake Payments Limited", { ...today, minimums: { ...today.minimums, minContractMonths: 36 } })).toEqual({ ok: false, code: "CONTRACT_TOO_SHORT" });
    expect(await rulesFor(post({ occupationCode: "3545", salaryLow: 70000, salaryHigh: null }), "Fake Payments Limited", { ...today, minimums: { ...today.minimums, nonListRoute: false } })).toEqual({ ok: false, code: "OCCUPATION_NOT_ON_LIST" });
    expect(await rulesFor(post(), "Fake Payments Limited", { ...today, occupationLists: [{ id: "in-2136", code: "2136", title: "T", list: "ineligible" }] })).toEqual({ ok: false, code: "OCCUPATION_INELIGIBLE" });
  });
  it("passes a Critical Skills role at the minimum, and the top of a range counts (#66)", async () => {
    expect(await run()).toMatchObject({ ok: true, passRoute: "stated_pay", status: "live", sector: "IT" });
    expect(await run({ salaryLow: 40904, salaryHigh: null })).toMatchObject({ ok: true, passRoute: "stated_pay" });
    expect(await run({ salaryLow: 38000, salaryHigh: 41000 })).toMatchObject({ ok: true, passRoute: "stated_pay" });
    expect(await run({ salaryLow: 40903, salaryHigh: null })).toEqual({ ok: false, code: "PAY_BELOW_MINIMUM" });
  });
  it("checks the pay against the hours: 40 hours needs 41,953.60", async () => {
    expect(await run({ salaryLow: 41953, weeklyHours: 40, salaryHigh: null })).toEqual({ ok: false, code: "PAY_BELOW_MINIMUM" });
    expect(await run({ salaryLow: 41954, weeklyHours: 40, salaryHigh: null })).toMatchObject({ ok: true });
    expect(await run({ salaryLow: 40904, weeklyHours: 39, salaryHigh: null })).toMatchObject({ ok: true });
    expect(await run({ salaryLow: 40000, salaryHigh: null, healthInsuranceEur: 904 })).toMatchObject({ ok: true }); // #68
  });
  it("a role not on the list needs 68,911 (#225); an ineligible role never passes", async () => {
    expect(await run({ occupationCode: "3545", salaryLow: 68910, salaryHigh: null })).toEqual({ ok: false, code: "PAY_BELOW_MINIMUM" });
    expect(await run({ occupationCode: "3545", salaryLow: 68911, salaryHigh: null })).toMatchObject({ ok: true, passRoute: "stated_pay" });
    expect(await run({ occupationCode: "4112", salaryLow: 200000, salaryHigh: null })).toEqual({ ok: false, code: "OCCUPATION_INELIGIBLE" });
  });
  it("a contract under 24 months fails, in its fields or in the advert text", async () => {
    expect(await run({ contractType: "fixed_term", contractMonths: 23 })).toEqual({ ok: false, code: "CONTRACT_TOO_SHORT" });
    expect(await run({ contractType: "fixed_term", contractMonths: 24 })).toMatchObject({ ok: true });
    expect(await run({ description: desc + " This is a 12 month contract role." })).toMatchObject({ ok: false, code: "RULES_FAILED", stage: "7 contract under 2 years" });
  });
  it("runs the chain's text rules: no sponsorship, a post based elsewhere", async () => {
    expect(await run({ description: "We are hiring a software engineer in Dublin. We cannot offer visa sponsorship for this role." })).toMatchObject({ ok: false, code: "RULES_FAILED" });
    expect(await run({ description: desc + " This role is located in Dublin, Ireland or London, United Kingdom." })).toMatchObject({ ok: false, code: "RULES_FAILED" });
  });
  it("a public pay grade passes only for a public pay employer on a list role; otherwise pay is required", async () => {
    const grade = { salaryLow: null, salaryHigh: null, payGrade: "Staff Nurse scale" };
    expect(await run(grade, "Beaumont Hospital")).toMatchObject({ ok: true, passRoute: "public_pay" });
    expect(await run(grade, "HSE")).toMatchObject({ ok: true, passRoute: "public_pay" });
    expect(await run(grade)).toEqual({ ok: false, code: "PAY_REQUIRED" });
    expect(await run({ ...grade, occupationCode: "3545" }, "Beaumont Hospital")).toEqual({ ok: false, code: "PAY_REQUIRED" });
  });
  it("scam wording sends the job to review instead of live", async () => {
    const v = await run({ description: desc + " Candidates must pay a registration fee before the interview." });
    expect(v).toMatchObject({ ok: true, status: "in_review" });
  });
});

describe("jobRefusal", () => {
  const e = (message: string, code = "P0001") => ({ code, message });
  it.each([
    ["job guard: the portal writes a job only for an active poster, recruiter or account owner of its company", 403, "NOT_A_POSTER"],
    ["signer refused: not an active poster", 403, "NOT_A_SIGNER"], ["job guard: sponsor_confirmed is refused while the organisation is restricted", 403, "BADGE_RESTRICTED"],
    ["job refused: the organisation is not verified", 403, "COMPANY_NOT_ACTIVE"], ["job guard: the portal may not move a job from closed to live", 409, "BAD_STATE"],
    ["status refused: NOT_A_MEMBER no active membership", 403, "NOT_A_MEMBER"], ["anything else", 403, "REFUSED"],
  ])("maps %s", (m, status, code) => expect(jobRefusal(e(m))).toEqual({ status, code }));
  it("leaves other errors alone", () => {
    expect(jobRefusal(e("x", "23505"))).toBeNull();
    expect(jobRefusal(new Error("boom"))).toBeNull();
    expect(jobRefusal(undefined)).toBeNull();
  });
});
