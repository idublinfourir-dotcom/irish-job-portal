// Unit tests for the decision chain. Made-up text only; the matcher is a fake the test controls.
import { describe, expect, it, vi } from "vitest";
import { assess, type AdvertInput, type ChainData, type ChainMatcher } from "./assess";
import { cleanEmployerName } from "../employers";

type Match = Awaited<ReturnType<ChainMatcher>>;
const found = (occupationCode: string, onCriticalSkillsList: Match["onCriticalSkillsList"], confidence: Match["confidence"]): ChainMatcher => async () => ({ occupationCode, onCriticalSkillsList, confidence });
const GOOD = found("2134", "yes", "high");

const data = (o: Partial<ChainData> = {}): ChainData => ({ deteNames: new Set(), publicPayCandidates: new Map(), matcher: GOOD, ...o });
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
const run = (a: Partial<AdvertInput> = {}, d: Partial<ChainData> = {}) => assess(advert(a), data(d));

describe("a clean pass", () => {
  it("passes with the salary stated and fills every field", async () => {
    expect(await run()).toEqual({
      stage: "PASS (salary stated)",
      bucket: "stated_pay",
      reason: null,
      agency: false,
      scamFlag: false,
      sponsorYes: false,
      occupationCode: "2134",
      occupationConfidence: "high",
      contract: "ok",
      contractReason: "permanent or not stated",
      salaryLow: 60000,
      salaryHigh: 60000,
      salaryCheck: "pass",
      bigCompany: false,
      irishVerdict: "irish",
      irishReason: "employer known in Ireland",
      publicPayTier: 0,
      sector: "IT",
      readsAdvert: true,
    });
  });

  it("treats missing and null fields as empty and does not throw", async () => {
    const a = await assess({ source: "greenhouse", employer: null, title: undefined, location: null, description: null, employmentType: null, salaryBox: null }, data());
    expect(a.stage).toBe("3 not in Ireland");
  });
});

describe("the order of the rules", () => {
  it("stops at 3 when the location is not Irish and does not ask the matcher", async () => {
    const matcher = vi.fn(GOOD);
    const a = await run({ location: "Paris, France" }, { matcher });
    expect(a).toMatchObject({ stage: "3 not in Ireland", bucket: "rejected", occupationCode: null, contract: null, salaryCheck: null, irishVerdict: null, readsAdvert: false });
    expect(matcher).not.toHaveBeenCalled();
  });

  it("known quirk: D1 the location test runs before the no sponsorship test", async () => {
    const a = await run({ location: "Paris", description: "We do not offer visa sponsorship." });
    expect(a.stage).toBe("3 not in Ireland");
    expect(a.reason).toBeNull();
  });

  it("stops at 4 with the matched phrase", async () => {
    const a = await run({ description: "We do not offer visa sponsorship. Salary €60,000." });
    expect(a).toMatchObject({ stage: "4 says no sponsorship", reason: "do not offer visa sponsorship", bucket: "rejected", readsAdvert: false, occupationCode: null, irishVerdict: null });
  });

  it("5: occupation not recognised", async () => {
    expect(await run({}, { matcher: found("none", "unknown", "none") })).toMatchObject({ stage: "5 occupation not recognised", occupationCode: "none", occupationConfidence: "none", bucket: "rejected", contract: null });
  });

  it("6: not on the Critical Skills list", async () => {
    expect(await run({}, { matcher: found("3542", "no", "medium") })).toMatchObject({ stage: "6 not on Critical Skills list", bucket: "rejected" });
  });

  it("5: a low confidence match goes to the admin queue", async () => {
    expect(await run({}, { matcher: found("3542", "yes", "low") })).toMatchObject({ stage: "5 unsure occupation (admin queue)", bucket: "queue", readsAdvert: true });
  });

  it("the not on the list test comes before the low confidence test", async () => {
    expect((await run({}, { matcher: found("x", "no", "low") })).stage).toBe("6 not on Critical Skills list");
  });

  it("an unknown list answer with medium confidence goes on to the contract", async () => {
    expect((await run({}, { matcher: found("engineer?", "unknown", "medium") })).contract).toBe("ok");
  });

  it("7: a contract under 2 years", async () => {
    expect(await run({ description: "A 12 month contract. Salary €60,000." })).toMatchObject({ stage: "7 contract under 2 years", contract: "short", contractReason: "12 months", salaryCheck: null, bucket: "rejected" });
  });

  it("7: an unclear contract goes to the admin queue", async () => {
    expect(await run({ employmentType: "Contract" })).toMatchObject({ stage: "7 contract unclear (admin queue)", contract: "unclear", bucket: "queue" });
  });

  it("8: salary below the minimum", async () => {
    expect(await run({ description: "Salary €30,000." })).toMatchObject({ stage: "8 salary below €40,904", salaryCheck: "below", salaryLow: 30000, bucket: "rejected" });
  });

  it("8: no salary and not a big company", async () => {
    expect(await run({ description: "No money mentioned." })).toMatchObject({ stage: "8 no salary, not a big company", salaryCheck: "not stated", bigCompany: false, bucket: "no_salary", readsAdvert: false });
  });

  it("a big company with no salary passes by the big-company rule", async () => {
    expect(await run({ employer: "Google Ireland Limited", description: "No money mentioned." })).toMatchObject({ stage: "PASS (big-company rule)", bucket: "big_company", bigCompany: true, readsAdvert: true });
  });

  it("a big company that looks like an agency does not pass by the big-company rule", async () => {
    expect(await run({ employer: "Google Recruitment", description: "No money mentioned." })).toMatchObject({ stage: "8 no salary, not a big company", agency: true, bigCompany: true });
  });

  it("known quirk: D3 a range crossing the minimum is a stage 8 drop yet its bucket is stated_pay", async () => {
    expect(await run({ description: "Salary €30,000 to €45,000." })).toMatchObject({ stage: "8 range crosses €40,904 (no rule yet)", salaryCheck: "range crosses", bucket: "stated_pay", readsAdvert: true });
  });
});

describe("test postings and the Irish check", () => {
  it("a test posting beats every other stage and skips the Irish check", async () => {
    expect(await run({ title: "Test Posting - do not apply", location: "Paris" })).toMatchObject({ stage: "0 test posting", bucket: "rejected", irishVerdict: null, readsAdvert: false });
    expect(await run({ title: "Test Posting" })).toMatchObject({ stage: "0 test posting", irishVerdict: null, occupationCode: "2134" });
  });

  it("known quirk: the Irish check is skipped when the stage already starts with 3 or 4", async () => {
    expect((await run({ location: "Paris" })).irishVerdict).toBeNull();
    expect((await run({ description: "We do not offer visa sponsorship." })).irishVerdict).toBeNull();
  });

  it("the Irish check runs on stages 5 to 8 and records its verdict", async () => {
    expect(await run({}, { matcher: found("none", "unknown", "none") })).toMatchObject({ irishVerdict: "irish", irishReason: "employer known in Ireland" });
  });

  it("not Irish gives stage 3 with the reason, whatever the stage was", async () => {
    const a = await run({ description: "A job with the NHS. Salary €60,000." }, { matcher: found("none", "unknown", "none") });
    expect(a).toMatchObject({ stage: "3 not an Irish job: strong foreign signs: nhs", bucket: "rejected", irishVerdict: "not irish", readsAdvert: false });
  });

  it("cuts the Irish reason to 60 characters in the stage but keeps it whole in irishReason", async () => {
    const a = await run({ description: "belfast catalunya londonderry northern ireland" });
    expect(a.irishReason).toBe("strong foreign signs: belfast, catalunya, londonderry, northern ireland");
    expect(a.stage).toBe("3 not an Irish job: " + a.irishReason!.slice(0, 60));
  });

  const vague = { source: "linkedin", location: "Ireland" };
  it("known quirk: D2 every non-LinkedIn advert counts as known", async () => {
    expect((await run({ ...vague, source: "greenhouse" })).stage).toBe("PASS (salary stated)");
    expect(await run(vague)).toMatchObject({ stage: "3 unsure Irish employer (admin queue)", bucket: "queue", irishVerdict: "unsure", readsAdvert: true });
  });

  it("a LinkedIn advert is known when the employer is in the DETE list", async () => {
    const deteNames = new Set([cleanEmployerName("Acme Widgets Ltd")]);
    expect((await run(vague, { deteNames })).stage).toBe("PASS (salary stated)");
  });

  it("a LinkedIn advert is known when the employer is a big company", async () => {
    expect((await run({ ...vague, employer: "Stripe" })).stage).toBe("PASS (salary stated)");
  });

  it("a LinkedIn advert is known when the employer has a public pay tier", async () => {
    const publicPayCandidates = new Map<string, 1 | 2>([["acme widgets", 2]]);
    expect((await run(vague, { publicPayCandidates })).stage).toBe("PASS (salary stated)");
  });

  it("known quirk: unsure queues only when the stage is a pass or starts with 8", async () => {
    expect(await run(vague, { matcher: found("none", "unknown", "none") })).toMatchObject({ stage: "5 occupation not recognised", irishVerdict: "unsure" });
    expect((await run({ ...vague, description: "A 12 month contract." })).stage).toBe("7 contract under 2 years");
    expect((await run({ ...vague, description: "No money mentioned." })).stage).toBe("3 unsure Irish employer (admin queue)");
  });
});

describe("the #95 rules", () => {
  it("a doctor grade with no stated term goes to the admin queue", async () => {
    expect(await run({ title: "Registrar in Surgery" })).toMatchObject({ stage: "7 doctor grade, contract unconfirmed (admin queue, #95)", bucket: "queue" });
  });

  it("a doctor grade with a stated 2 year term is left alone", async () => {
    expect((await run({ title: "Registrar in Surgery", description: "A 2 year contract. Salary €60,000." })).stage).toBe("PASS (salary stated)");
  });

  it("permanent or specified purpose goes to the admin queue", async () => {
    expect(await run({ description: "A permanent or specified purpose. Salary €60,000." })).toMatchObject({ stage: "7 permanent or specified purpose (admin queue, #95)", bucket: "queue" });
  });

  it("the doctor rule is tried first", async () => {
    expect((await run({ title: "SHO Doctor", description: "Permanent or specified purpose." })).stage).toBe("7 doctor grade, contract unconfirmed (admin queue, #95)");
  });

  it("the rules apply to a stage 8 drop but not to stages 5, 6 or 7", async () => {
    expect((await run({ title: "Registrar", description: "No money mentioned." })).stage).toBe("7 doctor grade, contract unconfirmed (admin queue, #95)");
    expect((await run({ title: "Registrar" }, { matcher: found("none", "unknown", "none") })).stage).toBe("5 occupation not recognised");
    expect((await run({ title: "Registrar", description: "A 6 month contract." })).stage).toBe("7 contract under 2 years");
  });
});

describe("buckets and the public tier", () => {
  const noPay = { employer: "HSE Dublin", description: "No money mentioned." };
  it("known quirk: D4 the public tier changes only the bucket", async () => {
    expect(await run(noPay)).toMatchObject({ stage: "8 no salary, not a big company", bucket: "public_hse", publicPayTier: 1 });
    expect(await run({ employer: "Beaumont Hospital", description: "Salary €30,000." }, { publicPayCandidates: new Map([["beaumont hospital", 2]]) })).toMatchObject({ stage: "8 salary below €40,904", bucket: "public_s38", publicPayTier: 2 });
  });

  it("a public employer with a stated salary stays stated_pay", async () => {
    expect(await run({ employer: "HSE Dublin" })).toMatchObject({ stage: "PASS (salary stated)", bucket: "stated_pay", publicPayTier: 1 });
  });

  it("the tier does not change an earlier stage", async () => {
    expect(await run({ employer: "HSE Dublin" }, { matcher: found("none", "unknown", "none") })).toMatchObject({ stage: "5 occupation not recognised", bucket: "rejected", publicPayTier: 1 });
  });

  it("a range that crosses stays stated_pay for a public employer", async () => {
    expect((await run({ employer: "HSE Dublin", description: "Salary €30,000 to €45,000." })).bucket).toBe("stated_pay");
  });
});

describe("flags", () => {
  it("known quirk: the scam flag is computed and changes nothing", async () => {
    expect(await run({ description: "Pay a registration fee. Salary €60,000." })).toMatchObject({ scamFlag: true, stage: "PASS (salary stated)" });
  });

  it("sets the sponsor-yes flag", async () => {
    expect((await run({ description: "Visa sponsorship available. Salary €60,000." })).sponsorYes).toBe(true);
  });

  it("flags an agency by employer name", async () => {
    expect((await run({ employer: "Acme Recruitment" })).agency).toBe(true);
  });

  it("still sets the flags when a later rule stops the advert", async () => {
    expect(await run({ location: "Paris", employer: "Acme Recruitment", description: "Pay a registration fee. Visa sponsorship available." })).toMatchObject({ agency: true, scamFlag: true, sponsorYes: true });
  });
});

describe("sector", () => {
  const sector = async (code: string, o: Partial<AdvertInput> = {}) => (await run(o, { matcher: found(code, "yes", "high") })).sector;
  it("is read from the occupation code", async () => {
    expect(await sector("2231")).toBe("health");
    expect(await sector("2135")).toBe("IT");
    expect(await sector("2431")).toBe("construction and engineering");
    expect(await sector("2421")).toBe("finance");
    expect(await sector("2461")).toBe("pharma and science");
    expect(await sector("3542")).toBe("other");
  });

  it("is pharma for a pharma employer whatever the code", async () => {
    expect(await sector("2231", { employer: "Pfizer Ireland" })).toBe("pharma and science");
  });

  it("settles 212x/213x by IT words in the title and the first 2,000 characters", async () => {
    expect(await sector("212x/213x", { description: "We use Python daily. Salary €60,000." })).toBe("IT");
    expect(await sector("212x/213x", { description: "Pumps. Salary €60,000." })).toBe("construction and engineering");
    expect(await sector("212x/213x", { description: "Pumps. ".repeat(400) + "python" })).toBe("construction and engineering");
  });

  it("is other when no occupation rule ran", async () => {
    expect((await run({ location: "Paris" })).sector).toBe("other");
  });
});

describe("readsAdvert", () => {
  it("is false for stages 0, 3 not, 4 and the no_salary bucket", async () => {
    expect((await run({ title: "Test job" })).readsAdvert).toBe(false);
    expect((await run({ location: "Paris" })).readsAdvert).toBe(false);
    expect((await run({ description: "We do not offer visa sponsorship. Salary €60,000." })).readsAdvert).toBe(false);
    expect((await run({ description: "No money." })).readsAdvert).toBe(false);
  });

  it("known quirk: the advert is read for a rejected stage 5, 6 and 7", async () => {
    expect((await run({}, { matcher: found("none", "unknown", "none") })).readsAdvert).toBe(true);
    expect((await run({}, { matcher: found("x", "no", "high") })).readsAdvert).toBe(true);
  });
});
