// The rules passed in as data (#229): the stand-in loader gives exactly today's values, bad rules are refused, and a changed snapshot changes
// the result (so every path really reads it).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assess, BIG_COMPANY_BRANDS, BIG_COMPANY_LIST_150, chainRules, checkEligibility, checkSnapshot, CRITICAL_SKILLS_MINIMUM, getRules, GRADUATE_MINIMUM,
  GRADUATE_MONTHS, isBigCompany, MIN_CONTRACT_MONTHS, NON_LIST_MINIMUM, NON_LIST_ROUTE, RULES_CHECKED_ON, rulesFromFiles, STANDARD_WEEK_HOURS,
  type AdvertInput, type RulesSnapshot,
} from "./index";

const DATA = new URL("../../fetcher/data/", import.meta.url).pathname;
const json = (f: string) => JSON.parse(readFileSync(DATA + f, "utf8")) as unknown;
const today = rulesFromFiles(DATA);
const withMin = (o: Partial<RulesSnapshot["minimums"]>): RulesSnapshot => ({ ...today, minimums: { ...today.minimums, ...o } });

describe("rulesFromFiles", () => {
  it("gives exactly today's constants and files", async () => {
    expect(today.minimums).toEqual({
      criticalSkills: CRITICAL_SKILLS_MINIMUM, graduate: GRADUATE_MINIMUM, graduateMonths: GRADUATE_MONTHS, nonList: NON_LIST_MINIMUM, nonListRoute: NON_LIST_ROUTE,
      minContractMonths: MIN_CONTRACT_MONTHS, standardWeekHours: STANDARD_WEEK_HOURS, checkedOn: RULES_CHECKED_ON,
    });
    expect(today.minimums).toMatchObject({ criticalSkills: 40904, graduate: 36848, nonList: 68911, minContractMonths: 24, checkedOn: "2026-11-12" });
    expect(today.occupationLists).toEqual(json("occupation-lists.json"));
    expect(today.publicPayEmployers).toEqual(json("L2/public_employers_candidates.json"));
    expect(today.bigCompanyNames).toEqual([...BIG_COMPANY_BRANDS, ...BIG_COMPANY_LIST_150]);
    expect(checkSnapshot(today)).toBe(today);
    expect(await getRules()).toEqual(today); // the apps' loader is the same version 1
  });
});

describe("checkSnapshot refuses bad rules", () => {
  it.each([
    ["a minimum missing", { ...today, minimums: { ...today.minimums, criticalSkills: undefined } }, /criticalSkills is missing/],
    ["a minimum zero", withMin({ nonList: 0 }), /nonList is missing or not positive/],
    ["a minimum negative", withMin({ minContractMonths: -1 }), /minContractMonths/],
    ["a minimum not a number", withMin({ graduate: "36848" as never }), /graduate/],
    ["a minimum NaN", withMin({ standardWeekHours: Number.NaN }), /standardWeekHours/],
    ["no route switch", withMin({ nonListRoute: undefined as never }), /nonListRoute/],
    ["no checked date", withMin({ checkedOn: "" }), /checkedOn/],
    ["no minimums", { ...today, minimums: undefined as never }, /missing/],
    ["an empty Critical Skills list", { ...today, occupationLists: today.occupationLists.filter((e) => e.list !== "critical-skills") }, /Critical Skills list is empty/],
    ["an empty Ineligible list", { ...today, occupationLists: today.occupationLists.filter((e) => e.list !== "ineligible") }, /Ineligible list is empty/],
    ["no lists at all", { ...today, occupationLists: [] }, /list is empty/],
    ["no public pay employers", { ...today, publicPayEmployers: {} }, /public pay employers list is empty/],
    ["no big-company names", { ...today, bigCompanyNames: [] }, /big-company names list is empty/],
  ])("%s", (_n, s, why) => expect(() => checkSnapshot(s as RulesSnapshot)).toThrow(why));
});

describe("a changed snapshot changes the result", () => {
  const advert = (o: Partial<AdvertInput> = {}): AdvertInput => ({
    source: "greenhouse", employer: "Acme Widgets", title: "Platform Engineer", location: "Dublin, Ireland", employmentType: "Full-time",
    description: "Salary: €45,000 per year. Permanent role. Visa sponsorship available.", ...o,
  });
  const run = (s: RulesSnapshot, a = advert()) =>
    assess(a, { deteNames: new Set(), ...chainRules(s), matcher: async () => ({ occupationCode: "2134", onCriticalSkillsList: "yes", confidence: "high" }) });

  it("the chain: a higher Critical Skills minimum turns a pass into a pay drop", async () => {
    expect((await run(today)).stage).toBe("PASS (salary stated)");
    expect((await run(withMin({ criticalSkills: 50_000 }))).salaryCheck).toBe("below");
  });
  it("the chain: a longer minimum contract makes a 30 month contract short", async () => {
    const a = advert({ description: "Salary: €45,000. This is a 30 month contract. Visa sponsorship available." });
    expect((await run(today, a)).stage).not.toBe("7 contract under 2 years");
    expect((await run(withMin({ minContractMonths: 36 }), a)).stage).toBe("7 contract under 2 years");
  });
  it("the chain and isBigCompany: a removed big-company name loses the big-company rule", async () => {
    const google = advert({ employer: "Google Ireland", description: "Permanent role. Visa sponsorship available." });
    expect((await run(today, google)).stage).toBe("PASS (big-company rule)");
    const without = { ...today, bigCompanyNames: today.bigCompanyNames.filter((n) => n !== "google") };
    expect((await run(without, google)).stage).toBe("8 no salary, not a big company");
    expect(isBigCompany("Google Ireland", without.bigCompanyNames)).toBe(false);
  });
  it("the chain: a removed public pay employer loses its tier", async () => {
    const name = Object.keys(today.publicPayEmployers)[0]!;
    const a = advert({ employer: name, description: "Permanent role. Visa sponsorship available." });
    expect((await run(today, a)).publicPayTier).toBe(2);
    expect((await run({ ...today, publicPayEmployers: { other: { tier: 2 } } }, a)).publicPayTier).toBe(0);
  });
  it("the checker: the minimums, the route switch, the date and the lists all come from the snapshot", () => {
    const input = { occupationCode: "2134", annualPay: 45_000, relevantDegree: true, contractMonths: null };
    expect(checkEligibility(input, today)).toMatchObject({ qualifies: true, minimum: 40904, rulesCheckedOn: "2026-11-12" });
    const later = withMin({ criticalSkills: 46_000, checkedOn: "2027-03-01" });
    expect(checkEligibility(input, later)).toMatchObject({ qualifies: false, minimum: 46000, rulesCheckedOn: "2027-03-01" });
    expect(checkEligibility(input, later).standingLine).toContain("Rules last checked on 2027-03-01.");
    expect(checkEligibility({ ...input, contractMonths: 30 }, withMin({ minContractMonths: 36 })).reason).toBe("contract_too_short");
    const unlisted = { ...input, occupationCode: "3545", annualPay: 70_000 };
    expect(checkEligibility(unlisted, today).reason).toBe("non_list_route");
    expect(checkEligibility(unlisted, withMin({ nonListRoute: false })).reason).toBe("non_list_route_blocked");
    expect(checkEligibility(input, { ...today, occupationLists: [{ code: "2134", list: "ineligible" }] }).reason).toBe("ineligible");
    expect(checkEligibility({ ...input, weeklyHours: 40 }, withMin({ standardWeekHours: 40 })).minimum).toBe(40904); // 40 hours is the standard week
  });
});

describe("getRules budget", () => {
  it("loads once per process: 10,000 calls share one snapshot in under 50 ms", async () => {
    const first = await getRules();
    const t = performance.now();
    let same = 0;
    for (let i = 0; i < 10_000; i++) if ((await getRules()) === first) same++;
    expect(performance.now() - t).toBeLessThan(50);
    expect(same).toBe(10_000);
  });
});
