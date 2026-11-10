// New rules (A, B, C of brief R1) through the real chain: the real rules matcher and the real `assess`. Made-up adverts only.
import { assess, type AdvertInput } from "@portal/rules";
import { describe, expect, it } from "vitest";
import { rulesMatcher } from "./index";

const data = { deteNames: new Set<string>(), publicPayCandidates: new Map<string, 1 | 2>(), matcher: rulesMatcher };
const advert = (o: Partial<AdvertInput> = {}): AdvertInput => ({
  source: "greenhouse",
  employer: "Example Ltd",
  title: "Software Engineer",
  location: "Dublin, Ireland",
  description: "Build services for our customers. Permanent role.",
  employmentType: "full-time",
  salaryBox: "€70,000",
  ...o,
});
const run = (o: Partial<AdvertInput> = {}) => assess(advert(o), data);

describe("the control advert passes", () => {
  it("stated pay, permanent, no refusal wording", async () => {
    expect(await run()).toMatchObject({ stage: "PASS (salary stated)", bucket: "stated_pay" });
  });
});

describe("A: a required EU member state nationality is sponsorship refused", () => {
  it.each([
    "This role requires you to be a national of an EU member state",
    "This role requires you to be a national of an EU Member state.",
    "Candidate must be a national of an EU member state and residing in the EU",
  ])("%j stops at stage 4", async (line) => {
    const a = await run({ description: `Build services for our customers.\n- ${line}\n- Python` });
    expect(a).toMatchObject({ stage: "4 says no sponsorship", bucket: "rejected" });
    expect(a.reason).toMatch(/national of an EU/i);
  });
});

describe("B: maternity cover is a contract under two years", () => {
  it("stops at stage 7", async () => {
    const a = await run({ description: "This role provides maternity cover for a Software Engineer in our team." });
    expect(a).toMatchObject({ stage: "7 contract under 2 years", bucket: "rejected", contract: "short" });
  });
});

describe("C: yearly pay written with a slash is read", () => {
  it("a salary box of two /yr amounts passes on stated pay", async () => {
    const a = await run({ salaryBox: "€80,000.00/yr - €90,000.00/yr" });
    expect(a).toMatchObject({ stage: "PASS (salary stated)", salaryLow: 80000, salaryHigh: 90000 });
  });
  it("a yearly figure below the minimum is rejected on pay, not skipped", async () => {
    expect(await run({ salaryBox: "€30,000/year" })).toMatchObject({ stage: "8 salary below €40,904" });
  });
  it("a revenue figure is still not pay", async () => {
    const a = await run({ salaryBox: "", description: "Our turnover is €2bn/year. Permanent role." });
    expect(a).toMatchObject({ salaryCheck: "not stated", stage: "8 no salary, not a big company" });
  });
});
