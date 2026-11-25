// Unit, performance and security tests for planAdvert and countyOf. Made-up text only; no database, network or clock.
import { describe, expect, it } from "vitest";
import { assess, CHAIN_RULES_V1, type Assessment, type Bucket, type ChainData, type Stage } from "@portal/rules";
import type { RawAdvert } from "@portal/sources";
import { countyOf } from "./county";
import { planAdvert } from "./plan";
import type { MatchResult } from "./types";

const advert = (o: Partial<RawAdvert> = {}): RawAdvert => ({
  id: "greenhouse:acme:1", source: "greenhouse", board: "acme", employer: "Acme Widgets", title: "Platform Engineer",
  location: "Dublin 2, Ireland", description: "Join our team. The salary is €60,000 a year.", url: "https://example.com/jobs/1", employmentType: "", salaryBox: "", ...o,
});
const asm = (o: Partial<Assessment> = {}): Assessment => ({
  stage: "PASS (salary stated)", bucket: "stated_pay", reason: null, agency: false, scamFlag: false, sponsorYes: false, occupationCode: "2134",
  occupationConfidence: "high", contract: "ok", contractReason: null, salaryLow: 60000.4, salaryHigh: 65000.6, salaryCheck: "pass", bigCompany: false,
  irishVerdict: "irish", irishReason: null, publicPayTier: 0, sector: "IT", readsAdvert: true, ...o,
});
const match = (o: Partial<MatchResult> = {}): MatchResult => ({
  match: { occupationCode: "2134", onCriticalSkillsList: "yes", confidence: "high" }, quote: null, modelId: "rules", failure: null, ...o,
});
const jobOf = (p: ReturnType<typeof planAdvert>) => {
  if (p.action !== "job") throw new Error(`expected job, got ${p.action}`);
  return p;
};
const rejectOf = (p: ReturnType<typeof planAdvert>) => {
  if (p.action !== "reject") throw new Error(`expected reject, got ${p.action}`);
  return p.advert;
};

describe("planAdvert, one test per step of design 3.7", () => {
  it("1. a model error defers: no rows", () => {
    const m = match({ failure: { kind: "model error", why: "timeout" } });
    expect(planAdvert(advert(), asm(), m)).toEqual({ action: "defer", why: "timeout" });
  });
  it("1. a bad answer is not a no (#298): it defers too, whatever the chain says, so the model is asked again next run", () => {
    const m = match({ failure: { kind: "bad answer", why: "junk" } });
    for (const a of [asm(), asm({ stage: "5 unsure occupation (admin queue)", bucket: "queue" })]) expect(planAdvert(advert(), a, m)).toEqual({ action: "defer", why: "junk" });
  });
  it("2. too long: rejected, title cut to 300 code points, no text kept", () => {
    const a = advert({ title: "T".repeat(5000), description: "d".repeat(40000) });
    const p = planAdvert(a, asm({ stage: "0 advert too long (admin queue)", bucket: "queue" }), null);
    expect(p.action).toBe("reject");
    const row = rejectOf(p);
    expect(row).toMatchObject({ result: "rejected", stage: "0 advert too long (admin queue)" });
    expect(Array.from(row.title)).toHaveLength(300);
    expect(JSON.stringify(p)).not.toContain("ddddd");
  });
  it.each(["", "x".repeat(2001), "ftp://example.com/a", "not a url", "javascript:alert(1)", "data:text/html,hi"])("3. no usable link (%s.length): rejected", (url) => {
    expect(rejectOf(planAdvert(advert({ url }), asm(), null))).toMatchObject({ result: "rejected", stage: "0 no advert link", url: null });
  });
  it("3. an advert the chain already rejected keeps the chain's own reason when it also has no link", () => {
    const a = asm({ stage: "6 not on Critical Skills list", bucket: "rejected" });
    expect(rejectOf(planAdvert(advert({ url: "" }), a, null))).toMatchObject({ result: "rejected", stage: "6 not on Critical Skills list", url: null });
  });
  it("3. an http link is kept", () => {
    expect(jobOf(planAdvert(advert({ url: "http://example.com/a" }), asm(), null)).job.ownPageUrl).toBe("http://example.com/a");
  });
  it.each<[Stage, Bucket, "passed" | "rejected", "live" | null, "stated_pay" | "big_company" | "public_pay" | null]>([
    ["PASS (salary stated)", "stated_pay", "passed", "live", "stated_pay"],
    ["8 range crosses €40,904 (no rule yet)", "stated_pay", "passed", "live", "stated_pay"],
    ["PASS (big-company rule)", "big_company", "passed", "live", "big_company"],
    // #299: the HSE goes live on its pay scale, whatever pay is stated (#67); the Section 38 names stay off (#80)
    ["8 salary below €40,904", "public_hse", "passed", "live", "public_pay"],
    ["8 no salary, not a big company", "public_hse", "passed", "live", "public_pay"],
    ["8 no salary, not a big company", "public_s38", "rejected", null, null],
    ["8 salary below €40,904", "public_s38", "rejected", null, null],
    // #298: doubt means no badge, and no person is asked
    ["3 unsure Irish employer (admin queue)", "queue", "rejected", null, null],
    ["5 unsure occupation (admin queue)", "queue", "rejected", null, null],
    ["7 contract unclear (admin queue)", "queue", "rejected", null, null],
    ["7 doctor grade, contract unconfirmed (admin queue, #95)", "queue", "rejected", null, null],
    ["7 permanent or specified purpose (admin queue, #95)", "queue", "rejected", null, null],
    ["0 test posting", "rejected", "rejected", null, null],
    ["3 not in Ireland", "rejected", "rejected", null, null],
    ["3 not an Irish job: staffing agency", "rejected", "rejected", null, null],
    ["4 says no sponsorship", "rejected", "rejected", null, null],
    ["5 occupation not recognised", "rejected", "rejected", null, null],
    ["6 not on Critical Skills list", "rejected", "rejected", null, null],
    ["7 contract under 2 years", "rejected", "rejected", null, null],
    ["8 salary below €40,904", "rejected", "rejected", null, null],
    ["8 no salary, not a big company", "no_salary", "rejected", null, null],
  ])("4. %s (%s) gives %s", (stage, bucket, result, status, route) => {
    const p = planAdvert(advert(), asm({ stage, bucket }), null);
    if (!status) return expect(rejectOf(p)).toMatchObject({ result, stage });
    const j = jobOf(p);
    expect([j.advert.result, j.advert.stage, j.job.status, j.job.passRoute]).toEqual([result, stage, status, route]);
  });
  it.each<[Stage, Bucket]>([["PASS (salary stated)", "stated_pay"], ["PASS (big-company rule)", "big_company"], ["8 no salary, not a big company", "public_hse"]])("5. scam wording on a pass refuses it with its own stage, and keeps no text: %s (%s)", (stage, bucket) => {
    const p = planAdvert(advert({ description: "You must pay a registration fee." }), asm({ scamFlag: true, stage, bucket }), null);
    expect(rejectOf(p)).toMatchObject({ result: "rejected", stage: "0 scam wording (admin queue)" });
    expect(JSON.stringify(p)).not.toContain("registration fee");
  });
  it("5. scam wording on a refused or doubtful advert changes nothing", () => {
    for (const [stage, bucket] of [["3 not in Ireland", "rejected"], ["7 contract unclear (admin queue)", "queue"]] as [Stage, Bucket][])
      expect(rejectOf(planAdvert(advert(), asm({ scamFlag: true, stage, bucket }), null)).stage).toBe(stage);
  });
  it("5. a doubtful advert keeps the rules' words and the model on its row, and no text", () => {
    const p = planAdvert(advert(), asm({ stage: "5 unsure occupation (admin queue)", bucket: "queue", irishReason: "employer known in Ireland" }), match({ quote: "the matched words", modelId: "m-1" }));
    expect(rejectOf(p)).toMatchObject({ reason: "employer known in Ireland", quotedEvidence: "the matched words", matcherModel: "m-1" });
    expect(p).not.toHaveProperty("text");
  });
  it("6. fields: reason, evidence, model, euros, county, text, ids", () => {
    const m = match({ quote: "the matched words", modelId: "m-1" });
    const p = jobOf(planAdvert(advert(), asm({ irishReason: "irish reason", contractReason: "contract reason", reason: null }), m));
    expect(p.advert).toEqual({
      externalId: "greenhouse:acme:1", url: "https://example.com/jobs/1", title: "Platform Engineer", employerName: "Acme Widgets", result: "passed",
      stage: "PASS (salary stated)", reason: "irish reason", quotedEvidence: "the matched words", matcherModel: "m-1",
    });
    expect(p.job).toEqual({
      title: "Platform Engineer", employerName: "Acme Widgets", county: "Dublin", sector: "IT", occupationCode: "2134", salaryLow: 60000, salaryHigh: 65001,
      passRoute: "stated_pay", status: "live", ownPageUrl: "https://example.com/jobs/1",
    });
    expect(p.text).toBe("Join our team. The salary is €60,000 a year.");
  });
  it("6. reason falls back to the contract reason, evidence prefers the rule's words over the quote, no model gives null", () => {
    const p = jobOf(planAdvert(advert(), asm({ contractReason: "c", reason: "rule words" }), match({ quote: "q", modelId: null })));
    expect([p.advert.reason, p.advert.quotedEvidence, p.advert.matcherModel]).toEqual(["c", "rule words", null]);
    const n = jobOf(planAdvert(advert(), asm(), null));
    expect([n.advert.reason, n.advert.quotedEvidence, n.advert.matcherModel]).toEqual([null, null, null]);
  });
  it("6. reason and evidence are cut to 300 code points", () => {
    const long = "😀".repeat(500);
    const p = jobOf(planAdvert(advert(), asm({ irishReason: long, reason: long }), null));
    expect(Array.from(p.advert.reason ?? "")).toHaveLength(300);
    expect(Array.from(p.advert.quotedEvidence ?? "")).toHaveLength(300);
  });
  it("6. no salary found keeps nulls", () => {
    const p = jobOf(planAdvert(advert(), asm({ salaryLow: null, salaryHigh: null, stage: "PASS (big-company rule)", bucket: "big_company" }), null));
    expect([p.job.salaryLow, p.job.salaryHigh, p.job.passRoute]).toEqual([null, null, "big_company"]);
  });
});

describe("planAdvert with the real rules chain", () => {
  const data: ChainData = {
    deteNames: new Set(), publicPayCandidates: new Map(), ...CHAIN_RULES_V1,
    matcher: async () => ({ occupationCode: "2134", onCriticalSkillsList: "yes", confidence: "high" }),
  };
  it("a clean advert becomes a live job", async () => {
    const a = advert();
    const p = jobOf(planAdvert(a, await assess(a, data), match()));
    expect([p.advert.result, p.job.status, p.job.passRoute]).toEqual(["passed", "live", "stated_pay"]);
  });
  it("an advert over the size limit becomes a rejected row with no text", async () => {
    const a = advert({ description: "x".repeat(30001) });
    expect(rejectOf(planAdvert(a, await assess(a, data), null)).stage).toBe("0 advert too long (admin queue)");
  });
});

describe("countyOf", () => {
  it.each([
    ["Dublin 2, Ireland", "Dublin"], ["co. cork", "Cork"], ["County Kerry", "Kerry"], ["Galway / Mayo", "Galway"], ["Mayo, Galway", "Mayo"],
    ["Ireland - Wicklow - Bray", "Wicklow"], ["DUBLIN", "Dublin"], ["Dun Laoghaire, Dublin", "Dublin"],
  ])("%s gives %s", (loc, county) => expect(countyOf(loc)).toBe(county));
  it.each(["", "Ireland", "Remote", "Southlouth", "Corkscrew Lane", "Belfast, Antrim", "x".repeat(100000)])("%s gives null", (loc) => expect(countyOf(loc)).toBeNull());
  it("only looks at the first 2,000 characters", () => expect(countyOf(" ".repeat(2000) + "Cork")).toBeNull());
  it("knows all 26", () => {
    const all = "Carlow Cavan Clare Cork Donegal Dublin Galway Kerry Kildare Kilkenny Laois Leitrim Limerick Longford Louth Mayo Meath Monaghan Offaly Roscommon Sligo Tipperary Waterford Westmeath Wexford Wicklow".split(" ");
    expect(all).toHaveLength(26);
    for (const c of all) expect(countyOf(`Co. ${c}`)).toBe(c);
  });
});

describe("planAdvert performance", () => {
  it("plans 1,000 adverts inside the budget", () => {
    const adverts = Array.from({ length: 1000 }, (_, i) => advert({ id: `greenhouse:acme:${i}`, description: "d".repeat(20000), url: `https://example.com/${i}` }));
    const start = performance.now();
    for (const a of adverts) planAdvert(a, asm(), match());
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
// measured 24 to 26 ms on 10 November 2026; budget is three times that
const BUDGET_MS = 75;

describe("planAdvert with hostile input", () => {
  const hostile = "a\0b\ud800c\udfffd'; drop table job; --";
  it("strips NUL from every stored string and survives lone surrogates", () => {
    const a = advert({ title: hostile, employer: hostile, description: hostile, location: hostile, url: "https://example.com/\0x" });
    const p = jobOf(planAdvert(a, asm({ irishReason: hostile, reason: hostile }), match({ quote: hostile, modelId: hostile })));
    const strings = JSON.stringify(p);
    expect(strings).not.toContain("\\u0000");
    expect(p.job.title).toContain("drop table job");
    expect(p.text).not.toContain("\0");
  });
  it("a 31,000 point description is not copied into a rejected row", () => {
    const a = advert({ description: "z".repeat(31000), title: "q".repeat(100000), employer: "e".repeat(100000) });
    const p = planAdvert(a, asm({ stage: "0 advert too long (admin queue)", bucket: "queue" }), null);
    expect(JSON.stringify(p).length).toBeLessThan(3000);
  });
  it("a 5,000 character link is refused", () => {
    expect(rejectOf(planAdvert(advert({ url: "https://example.com/" + "a".repeat(5000) }), asm(), null)).stage).toBe("0 no advert link");
  });
  it("salary numbers that cannot fit an integer column become null", () => {
    const p = jobOf(planAdvert(advert(), asm({ salaryLow: 1e12, salaryHigh: Number.NaN }), null));
    expect([p.job.salaryLow, p.job.salaryHigh]).toEqual([null, null]);
  });
  it("a NUL inside a javascript scheme does not sneak through", () => {
    expect(rejectOf(planAdvert(advert({ url: "java\0script:alert(1)" }), asm(), null)).stage).toBe("0 no advert link");
  });
});
