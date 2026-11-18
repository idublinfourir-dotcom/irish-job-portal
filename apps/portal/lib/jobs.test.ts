// No database: the post body checks, the hours minimum, the rules verdicts and the refusal codes. The routes end to end: packages/db/test/jobs-route.test.ts.
import { GENERAL_LOWER_CODES, GENERAL_LOWER_MINIMUM, GENERAL_MINIMUM, rulesV1 } from "@portal/rules";
import { describe, expect, it } from "vitest";
import { checkClose, checkEdit, checkPost, checkRenew, CONDITIONS, jobRefusal, minimumForHours, rulesFor, verdictReply, type Post, type Verdict } from "./jobs";

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
      permitType: "critical_skills", exceptionConfirmed: false,
    });
    expect(post({ contractType: "fixed_term", contractMonths: 24 }).contractMonths).toBe(24);
    expect(post({ salaryLow: null, salaryHigh: null, payGrade: "Clinical Nurse Manager 2" }).payGrade).toBe("Clinical Nurse Manager 2");
    expect(post({ statement: { signerName: "Fake Signer", signerTitle: "HR Director" } }).statement).toEqual({ signerName: "Fake Signer", signerTitle: "HR Director", writtenAuthority: false });
    expect(post({ weeklyHours: 60 }).weeklyHours).toBe(60);
    expect(post({ status: "draft" }).status).toBe("draft");
    expect(post({ permitType: "general", exceptionConfirmed: true })).toMatchObject({ permitType: "general", exceptionConfirmed: true });
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
    ["code 0xxx", { ...good, occupationCode: "0136" }], ["four digits, not SOC 2010", { ...good, occupationCode: "9999" }], ["just outside", { ...good, occupationCode: "1110" }],
    ["code with SQL", { ...good, occupationCode: "2136; drop table job" }], ["contract odd", { ...good, contractType: "temp" }],
    ["fixed term no months", { ...good, contractType: "fixed_term" }], ["permanent with months", { ...good, contractMonths: 24 }],
    ["months 0", { ...good, contractType: "fixed_term", contractMonths: 0 }], ["months float", { ...good, contractType: "fixed_term", contractMonths: 24.5 }],
    ["no pay", { ...good, salaryLow: null, salaryHigh: null }], ["top only", { ...good, salaryLow: null, payGrade: "x" }],
    ["top below bottom", { ...good, salaryHigh: 40000 }], ["pay string", { ...good, salaryLow: "50000" }], ["pay float", { ...good, salaryLow: 50000.5 }],
    ["pay negative", { ...good, salaryLow: -1 }], ["pay huge", { ...good, salaryLow: 1e9 }], ["hours 0", { ...good, weeklyHours: 0 }],
    ["hours 61", { ...good, weeklyHours: 61 }], ["hours float", { ...good, weeklyHours: 39.5 }], ["hours null", { ...good, weeklyHours: null }],
    ["health negative", { ...good, healthInsuranceEur: -5 }], ["http url", { ...good, ownPageUrl: "http://careers.example.ie/jobs/1" }],
    ["javascript url", { ...good, ownPageUrl: "javascript:alert(1)//aaaa" }], ["url with login", { ...good, ownPageUrl: "https://a:b@careers.example.ie/x" }],
    ["url not a url", { ...good, ownPageUrl: "not a url at all" }], ["client control", { ...good, clientName: "Acme\u0007" }],
    ["permitType other", { ...good, permitType: "stamp4" }], ["permitType number", { ...good, permitType: 1 }], ["permitType null", { ...good, permitType: null }],
    ["permitType object", { ...good, permitType: { x: 1 } }], ["permitType array", { ...good, permitType: ["general"] }], ["permitType huge", { ...good, permitType: "general".repeat(100_000) }],
    ["permitType upper case", { ...good, permitType: "General" }], ["exception string", { ...good, exceptionConfirmed: "true" }],
    ["exception number", { ...good, exceptionConfirmed: 1 }], ["exception object", { ...good, exceptionConfirmed: { a: 1 } }], ["exception null", { ...good, exceptionConfirmed: null }],
    ["exception huge", { ...good, exceptionConfirmed: "x".repeat(100_000) }],
    ["statement extra", { ...good, statement: { signerName: "A Name", signerTitle: "CEO", kind: "admin_on_behalf" } }],
    ["statement no title", { ...good, statement: { signerName: "A Name" } }], ["statement authority string", { ...good, statement: { signerName: "A Name", signerTitle: "CEO", writtenAuthority: "yes" } }],
  ])("refuses %s", (_n, b) => expect(checkPost(b)).toBeNull());
});

describe("checkEdit, checkRenew, checkClose", () => {
  it("edit takes the whole post and a job id", () => {
    expect(checkEdit({ ...good, jobId: "5" })?.jobId).toBe("5");
    for (const jobId of [0, -1, 1.5, 7, 2 ** 53, Infinity, null, "0", "07", "-1", "1.5", " 7", "9".repeat(19), "9223372036854775808", 5, 1e30, undefined]) expect(checkEdit({ ...good, jobId }), String(jobId)).toBeNull();
    expect(checkEdit({ ...good, jobId: "5", extra: 1 })).toBeNull();
  });
  it("renew takes an optional hire answer, close needs one (#49)", () => {
    expect(checkRenew({ jobId: "3" })).toEqual({ jobId: "3", hireAnswer: null });
    expect(checkRenew({ jobId: "3", hireAnswer: "yes" })).toEqual({ jobId: "3", hireAnswer: "yes" });
    expect(checkClose({ jobId: "3", hireAnswer: "no" })).toEqual({ jobId: "3", hireAnswer: "no" });
    for (const b of [{ jobId: "3" }, { jobId: 3, hireAnswer: "no" }, { jobId: "03", hireAnswer: "no" }, { jobId: "3", hireAnswer: "maybe" }, { jobId: "3", hireAnswer: "no", x: 1 }, { hireAnswer: "no" }, null]) expect(checkClose(b)).toBeNull();
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
    ["job guard: a client not found in the DETE names needs staff review", 409, "NEEDS_REVIEW"],
    ["status refused: NOT_A_MEMBER no active membership", 403, "NOT_A_MEMBER"], ["anything else", 403, "REFUSED"],
  ])("maps %s", (m, status, code) => expect(jobRefusal(e(m))).toEqual({ status, code }));
  it("leaves other errors alone", () => {
    expect(jobRefusal(e("x", "23505"))).toBeNull();
    expect(jobRefusal(new Error("boom"))).toBeNull();
    expect(jobRefusal(undefined)).toBeNull();
  });
});

describe("rulesFor: General Employment Permit posts", () => {
  const sponsor = { signerName: "Fake Signer", signerTitle: "HR Director" };
  const care = { occupationCode: "6145", title: "Healthcare Assistant", description: "We are hiring a healthcare assistant for our care home in Cork. Full sponsorship offered.", permitType: "general", statement: sponsor, exceptionConfirmed: true };
  const withGeneral = async (m: object = {}) => {
    const today = await rulesV1();
    return { ...today, minimums: { ...today.minimums, general: GENERAL_MINIMUM, generalLower: GENERAL_LOWER_MINIMUM, generalLowerCodes: [...GENERAL_LOWER_CODES], generalQuotaFullCodes: [], ...m } };
  };
  const gen = async (o: object = {}, m: object = {}) => rulesFor(post({ ...care, salaryLow: 33000, salaryHigh: null, ...o }), "Fake Care Home Limited", await withGeneral(m));

  it("the figures are the S.I. 643/2025 ones", () => {
    expect([GENERAL_MINIMUM, GENERAL_LOWER_MINIMUM, GENERAL_LOWER_CODES]).toEqual([36605, 32691, ["6145"]]);
  });
  it("refuses GENERAL_RULES_NOT_SET when the rules in force have none of the General fields (version 1)", async () => {
    expect(await rulesFor(post({ ...care, salaryLow: 33000, salaryHigh: null }), "Fake Care Home Limited", await rulesV1())).toEqual({ ok: false, code: "GENERAL_RULES_NOT_SET" });
  });
  it("passes at the lower rate for 6145 with stated pay, and needs the standard rate for another code on no list", async () => {
    expect(await gen()).toMatchObject({ ok: true, passRoute: "stated_pay", status: "live" });
    expect(await gen({ salaryLow: 32691 })).toMatchObject({ ok: true });
    expect(await gen({ salaryLow: 32690 })).toEqual({ ok: false, code: "PAY_BELOW_MINIMUM" });
    expect(await gen({ occupationCode: "3545", title: "Sales Executive" })).toEqual({ ok: false, code: "PAY_BELOW_MINIMUM" }); // 33,000 is under 36,605
    expect(await gen({ occupationCode: "3545", title: "Sales Executive", salaryLow: 36605 })).toMatchObject({ ok: true });
    expect(await gen({ occupationCode: "3545", title: "Sales Executive", salaryLow: 36604 })).toEqual({ ok: false, code: "PAY_BELOW_MINIMUM" });
  });
  it("scales with the hours, counts the top of a range and health insurance, and needs stated pay", async () => {
    expect(await gen({ salaryLow: 33000, weeklyHours: 45 })).toEqual({ ok: false, code: "PAY_BELOW_MINIMUM" }); // 32,691 / 39 h * 45 h is about 37,720
    expect(await gen({ salaryLow: 38000, weeklyHours: 45 })).toMatchObject({ ok: true });
    expect(await gen({ salaryLow: 30000, salaryHigh: 33000 })).toMatchObject({ ok: true });
    expect(await gen({ salaryLow: 30000, healthInsuranceEur: 2691 })).toMatchObject({ ok: true });
    expect(await gen({ salaryLow: 30000, healthInsuranceEur: 2690 })).toEqual({ ok: false, code: "PAY_BELOW_MINIMUM" });
    expect(await gen({ salaryLow: null, salaryHigh: null, payGrade: "Care assistant scale" }, {})).toEqual({ ok: false, code: "PAY_REQUIRED" });
    expect(await gen({ salaryLow: null, salaryHigh: null, payGrade: "Care assistant scale" }, {})).not.toMatchObject({ passRoute: "public_pay" });
  });
  it("has no minimum contract length, in the fields or in the advert text", async () => {
    expect(await gen({ contractType: "fixed_term", contractMonths: 6 })).toMatchObject({ ok: true });
    expect(await gen({ description: care.description + " This is a 6 month contract role." })).toMatchObject({ ok: true });
    expect(await gen({ description: care.description + " This is maternity cover." })).toMatchObject({ ok: false, code: "RULES_FAILED" });
  });
  it("needs the sponsorship statement for a live post", async () => {
    expect(await gen({ statement: null })).toEqual({ ok: false, code: "STATEMENT_REQUIRED" });
  });
  it("refuses a code whose quota is full, and an Ineligible code", async () => {
    expect(await gen({}, { generalQuotaFullCodes: ["6145"] })).toEqual({ ok: false, code: "QUOTA_FULL" });
    expect(await gen({}, { generalQuotaFullCodes: ["3545"] })).toMatchObject({ ok: true });
    expect(await gen({ occupationCode: "4112" })).toEqual({ ok: false, code: "OCCUPATION_INELIGIBLE" });
  });
  it("runs the chain: no sponsorship wording and a post outside Ireland are refused", async () => {
    expect(await gen({ description: "We are hiring a healthcare assistant in Cork. We cannot offer visa sponsorship for this role." })).toMatchObject({ ok: false, code: "RULES_FAILED" });
    expect(await gen({ description: care.description + " This role is located in Cork, Ireland or London, United Kingdom." })).toMatchObject({ ok: false, code: "RULES_FAILED" });
  });
  it("never uses the public pay route and the default type is still Critical Skills", async () => {
    expect(post().permitType).toBe("critical_skills");
    expect(await rulesFor(post(), "Fake Payments Limited", await withGeneral())).toMatchObject({ ok: true }); // the General fields do not change a Critical Skills post
  });
});

describe("rulesFor: an Ineligible entry with an exception", () => {
  const sponsor = { signerName: "Fake Signer", signerTitle: "HR Director" };
  const chef = { occupationCode: "5434", title: "Head Chef", description: "We are hiring a head chef for our restaurant in Galway. Full sponsorship offered.", salaryLow: 80000, salaryHigh: null, statement: sponsor };
  const run = async (o: object = {}, employer = "Fake Restaurant Limited") => rulesFor(post({ ...chef, ...o }), employer, await rulesV1());
  it("refuses a chef without the tick, with the exception wording in the reply, for both permit types", async () => {
    const v = await run();
    expect(v).toMatchObject({ ok: false, code: "OCCUPATION_INELIGIBLE", exception: expect.stringContaining("with the exception of") });
    expect(verdictReply(v as Verdict & { ok: false }).status).toBe(422);
    expect(await (verdictReply(v as Verdict & { ok: false }).json())).toMatchObject({ code: "OCCUPATION_INELIGIBLE", exception: expect.stringContaining("Executive Chef") });
    const today = await rulesV1();
    const general = { ...today, minimums: { ...today.minimums, general: GENERAL_MINIMUM, generalLower: GENERAL_LOWER_MINIMUM, generalLowerCodes: ["6145"], generalQuotaFullCodes: [] } };
    expect(await rulesFor(post({ ...chef, permitType: "general" }), "Fake Restaurant Limited", general)).toMatchObject({ ok: false, code: "OCCUPATION_INELIGIBLE", exception: expect.any(String) });
    expect(await rulesFor(post({ ...chef, permitType: "general", exceptionConfirmed: true, salaryLow: 40000 }), "Fake Restaurant Limited", general)).toMatchObject({ ok: true, passRoute: "stated_pay" });
  });
  it("passes with the tick (a Critical Skills post then needs the non-list minimum)", async () => {
    expect(await run({ exceptionConfirmed: true })).toMatchObject({ ok: true, passRoute: "stated_pay" });
    expect(await run({ exceptionConfirmed: true, salaryLow: 50000 })).toEqual({ ok: false, code: "PAY_BELOW_MINIMUM" });
  });
  it("a code with no exception wording is refused with or without the tick, and no wording is returned", async () => {
    expect(await run({ occupationCode: "4112", exceptionConfirmed: true })).toEqual({ ok: false, code: "OCCUPATION_INELIGIBLE" });
  });
  it("the pharmaceutical technician (3217, S.I. 558/2026) is Ineligible with an exception", async () => {
    const v = await run({ occupationCode: "3217", title: "Pharmaceutical Technician" });
    expect(v).toMatchObject({ ok: false, code: "OCCUPATION_INELIGIBLE", exception: expect.stringContaining("Pharmaceutical Technicians working in healthcare settings") });
  });
});

describe("rulesFor: conditions the Ineligible titles do not name (P6)", () => {
  const sponsor = { signerName: "Fake Signer", signerTitle: "HR Director" };
  const care = { occupationCode: "6145", title: "Home Carer", description: "We are hiring a home carer for our care company in Cork. Full sponsorship offered.", salaryLow: 33000, salaryHigh: null, permitType: "general", statement: sponsor };
  const general = async () => {
    const today = await rulesV1();
    return { ...today, minimums: { ...today.minimums, general: GENERAL_MINIMUM, generalLower: GENERAL_LOWER_MINIMUM, generalLowerCodes: ["6145"], generalQuotaFullCodes: [] } };
  };
  it("a care job (6145) needs the tick that the employer is not a private household, and the refusal carries the wording", async () => {
    expect(await rulesFor(post(care), "Fake Care Limited", await general())).toEqual({ ok: false, code: "OCCUPATION_INELIGIBLE", exception: CONDITIONS["6145"] });
    expect(CONDITIONS["6145"]).toContain("private household");
    expect(await rulesFor(post({ ...care, exceptionConfirmed: true }), "Fake Care Limited", await general())).toMatchObject({ ok: true });
  });
  it("every other named condition is already in an Ineligible title that asks for the tick", async () => {
    const lists = (await rulesV1()).occupationLists.filter((e) => e.list === "ineligible" && e.title.includes("with the exception of"));
    const named = (code: string, words: string[]) => expect(words.every((w) => lists.find((e) => e.code === code)?.title.includes(w)), code).toBe(true);
    named("5434", ["5 years", "2 years", "fast food"]); // chefs: experience and "not fast food"
    for (const code of ["1242", "2229", "3231", "3239", "6146"]) named(code, ["disability services"]);
    expect((await rulesV1()).occupationLists.some((e) => e.code === "6145"), "6145 is on no list, so its condition lives in CONDITIONS").toBe(false);
  });
});
