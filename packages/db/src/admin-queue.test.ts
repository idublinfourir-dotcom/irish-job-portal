// Unit tests for the pure parts of the admin queue: the staff input check, the list answer and the re-run of the rules. No database.
import { CHAIN_RULES_V1 } from "@portal/rules";
import { describe, expect, it } from "vitest";
import { checkApproveInput, claim, listAnswer, QueueRefused, reassess, stageChecks } from "./admin-queue";

const LISTS = [
  { code: "2134", list: "critical-skills" },
  { code: "2229", list: "critical-skills" },
  { code: "2229", list: "ineligible" },
  { code: "1225", list: "ineligible" },
];
const CHAIN = { deteNames: new Set<string>(), publicPayCandidates: new Map<string, 1 | 2>(), ...CHAIN_RULES_V1 };
const why = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof QueueRefused ? e.why : "other";
  }
  return "accepted";
};
const job = (o: Partial<Parameters<typeof reassess>[0]> = {}) => ({
  title: "Platform Engineer", employer_name: "Acme Widgets", county: "Dublin", source: "greenhouse", advert_text: "The salary is €60,000 a year.", ...o,
});

describe("listAnswer", () => {
  it("yes for a Critical Skills code, no for an ineligible one, null for a code on neither", () => {
    expect(listAnswer(LISTS, "2134")).toBe("yes");
    expect(listAnswer(LISTS, "1225")).toBe("no");
    expect(listAnswer(LISTS, "2229")).toBe("yes");
    expect(listAnswer(LISTS, "9999")).toBeNull();
  });
});

describe("checkApproveInput", () => {
  it("passes a good input through", () => {
    expect(checkApproveInput({ occupationCode: "2134" }, LISTS)).toEqual({ staff: { contractConfirmed: false }, onList: "yes" });
    expect(checkApproveInput({ occupationCode: "1225", salaryLow: 45000, contractConfirmed: true }, LISTS)).toEqual({ staff: { contractConfirmed: true, salary: { low: 45000, high: 45000 } }, onList: "no" });
    expect(checkApproveInput({ occupationCode: "2134", salaryLow: 45000, salaryHigh: 50000 }, LISTS).staff.salary).toEqual({ low: 45000, high: 50000 });
  });
  it("refuses bad codes, pay and flags", () => {
    expect(why(() => checkApproveInput({ occupationCode: "9999" }, LISTS))).toBe("bad_occupation_code");
    expect(why(() => checkApproveInput({ occupationCode: "21345" }, LISTS))).toBe("bad_occupation_code");
    expect(why(() => checkApproveInput({ occupationCode: "2134", salaryLow: -5 }, LISTS))).toBe("bad_salary");
    expect(why(() => checkApproveInput({ occupationCode: "2134", salaryLow: 1_000_001 }, LISTS))).toBe("bad_salary");
    expect(why(() => checkApproveInput({ occupationCode: "2134", salaryHigh: 50000 }, LISTS))).toBe("bad_salary");
    expect(why(() => checkApproveInput({ occupationCode: "2134", salaryLow: 50000, salaryHigh: 40000 }, LISTS))).toBe("bad_salary");
    expect(why(() => checkApproveInput({ occupationCode: "2134", contractConfirmed: 1 } as never, LISTS))).toBe("bad_input");
  });
});

describe("reassess", () => {
  it("passes on stated pay, and on a big company with no pay", async () => {
    expect((await reassess(job(), "2134", "yes", {}, CHAIN)).route).toBe("stated_pay");
    expect((await reassess(job({ employer_name: "Google", advert_text: "Pay is discussed later." }), "2134", "yes", {}, CHAIN)).route).toBe("big_company");
  });
  it("the matcher answer is the staff code, high confidence", async () => {
    const r = await reassess(job(), "2134", "yes", {}, CHAIN);
    expect(r.a).toMatchObject({ occupationCode: "2134", occupationConfidence: "high" });
    expect((await reassess(job(), "1225", "no", {}, CHAIN)).stage).toBe("6 not on Critical Skills list");
  });
  it("never passes scam wording, and says so", async () => {
    const r = await reassess(job({ advert_text: "The salary is €60,000 a year. You must pay a registration fee." }), "2134", "yes", {}, CHAIN);
    expect(r).toMatchObject({ route: null, stage: "0 scam wording (admin queue)" });
  });
  it("a job with no county is read as in Ireland, so the location test passes as it did when it was fetched", async () => {
    expect((await reassess(job({ county: null }), "2134", "yes", {}, CHAIN)).route).toBe("stated_pay");
  });
  it("a range that crosses the minimum goes live as stated pay, as the fetcher does (#66)", async () => {
    expect((await reassess(job({ advert_text: "Pay €38,000 to €56,000 a year." }), "2134", "yes", {}, CHAIN)).route).toBe("stated_pay");
  });
});

// A fake database that answers the acting-staff statement with the given flags and records everything it is asked.
const fakeDb = (answer: { active: boolean; reviewer: boolean }) => {
  const sql: string[] = [];
  const client = { query: async (text: string) => (sql.push(text), { rows: [answer], rowCount: 1 }), release: () => {} };
  return { sql, db: { query: client.query, connect: async () => client } as never };
};
const claimWhy = async (answer: { active: boolean; reviewer: boolean }) => {
  const f = fakeDb(answer);
  try {
    await claim(f.db, "staff1", "1");
  } catch (e) {
    return { why: e instanceof QueueRefused ? e.why : "other", sql: f.sql };
  }
  return { why: "accepted", sql: f.sql };
};

describe("acting staff check", () => {
  it("not_active_staff comes before not_reviewer, and neither runs the action", async () => {
    for (const reviewer of [true, false]) expect((await claimWhy({ active: false, reviewer })).why).toBe("not_active_staff");
    const r = await claimWhy({ active: true, reviewer: false });
    expect(r.why).toBe("not_reviewer");
    expect(r.sql).toEqual([expect.stringMatching(/^begin/), expect.stringContaining("fetched_job_reviewer"), "rollback"]);
  });
  it("the role is checked in the same statement as active staff, and no other role stands in", async () => {
    const r = await claimWhy({ active: true, reviewer: false });
    expect(r.sql[1]).toMatch(/r\.role = 'fetched_job_reviewer'/);
    expect(r.sql[1]).not.toMatch(/administrator|account_reviewer/);
  });
  it("an empty, huge or non-string staff id is refused before the database is touched", async () => {
    for (const bad of ["", "x".repeat(201), undefined, 5]) {
      const f = fakeDb({ active: true, reviewer: true });
      await expect(claim(f.db, bad as never, "1")).rejects.toMatchObject({ why: "not_active_staff" });
      expect(f.sql).toEqual([]);
    }
  });
});

describe("stageChecks (B63, the dry run's per-check list)", () => {
  const a = { irishReason: "brand list match", reason: null, occupationCode: "2134", contractReason: "two years stated", salaryCheck: "pass" as const, scamFlag: false };
  const result = (stage: string, over: Partial<typeof a> = {}) => Object.fromEntries(stageChecks({ ...a, ...over }, stage).map((c) => [c.check, c.result]));
  it("passes every check on a PASS stage, in the chain's order", () => {
    expect(stageChecks(a, "PASS (salary stated)").map((c) => c.check)).toEqual(["irish_employer", "sponsorship_wording", "occupation_known", "critical_skills_list", "contract", "salary", "scam_wording"]);
    expect(Object.values(result("PASS (salary stated)"))).toEqual(Array(7).fill("pass"));
  });
  it("marks the stage the chain stopped at as failed, the earlier ones passed and the later ones not run", () => {
    expect(result("7 contract under 2 years")).toMatchObject({ irish_employer: "pass", critical_skills_list: "pass", contract: "fail", salary: "not_run" });
    expect(result("3 not in Ireland")).toMatchObject({ irish_employer: "fail", sponsorship_wording: "not_run", contract: "not_run" });
  });
  it("marks a stop that goes to the admin queue as unsure, not failed", () => {
    expect(result("7 contract unclear (admin queue)").contract).toBe("unsure");
    expect(result("3 unsure Irish employer (admin queue)").irish_employer).toBe("unsure");
  });
  it("gives the detail only for checks that ran, and flags scam wording whatever the stage", () => {
    const c = stageChecks({ ...a, scamFlag: true }, "7 contract under 2 years");
    expect(c.find((x) => x.check === "contract")!.detail).toBe("two years stated");
    expect(c.find((x) => x.check === "salary")!.detail).toBeNull();
    expect(c.find((x) => x.check === "scam_wording")!.result).toBe("fail");
  });
});
