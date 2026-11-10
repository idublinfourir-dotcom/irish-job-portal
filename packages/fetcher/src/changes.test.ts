// Unit tests for the next cut (design 3.8): the hash, the day rule, the state of a known advert, the write each state needs, the stage limit.
// No database, no network, no clock. Made-up text only.
import { describe, expect, it } from "vitest";
import type { RawAdvert } from "@portal/sources";
import { fake, reply } from "../../sources/src/ats/testkit";
import { atsTasks } from "./boards";
import { hashAdvert, isDue } from "./hash";
import { changeOf, planAdvert, stateOf } from "./plan";
import type { Known, Plan } from "./types";
import type { Assessment, Stage } from "@portal/rules";

const advert = (o: Partial<RawAdvert> = {}): RawAdvert => ({
  id: "fake:b:1", source: "fake", board: "b", employer: "Acme", title: "Engineer", location: "Dublin", description: "Build things.",
  url: "https://example.test/1", employmentType: "full", salaryBox: "50000", ...o,
});

describe("hashAdvert", () => {
  it("is 64 lowercase hex, and the same advert gives the same hash", () => {
    expect(hashAdvert(advert())).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAdvert(advert())).toBe(hashAdvert({ ...advert() }));
  });
  it.each(["title", "employer", "location", "description", "employmentType", "salaryBox"] as const)("a different %s gives a different hash", (field) => {
    expect(hashAdvert(advert({ [field]: "changed" }))).not.toBe(hashAdvert(advert()));
  });
  it("id and url are not part of the hash", () => {
    expect(hashAdvert(advert({ id: "fake:b:2", url: "https://example.test/other" }))).toBe(hashAdvert(advert()));
  });
  it("field order and separators cannot collide", () => {
    expect(hashAdvert(advert({ title: "a,b", employer: "c" }))).not.toBe(hashAdvert(advert({ title: "a", employer: "b,c" })));
    expect(hashAdvert(advert({ title: "a", employer: "" }))).not.toBe(hashAdvert(advert({ title: "", employer: "a" })));
    expect(hashAdvert(advert({ title: 'a","b', employer: "c" }))).not.toBe(hashAdvert(advert({ title: "a", employer: 'b","c' })));
  });
  it("hostile text hashes without throwing (null byte, lone surrogate, 31,000 characters)", () => {
    for (const description of ["a\0b", "x\ud800y", "z".repeat(31_000)]) expect(hashAdvert(advert({ description }))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isDue (the reread rule)", () => {
  const day = (n: number) => new Date(n * 86_400_000 + 3_600_000);
  const ids = Array.from({ length: 700 }, (_, i) => `fake:b:${i}`);
  it("1 means every id, every day; unset or 0 means never", () => {
    expect(ids.every((id) => isDue(id, 1, day(20_000)))).toBe(true);
    expect(ids.some((id) => isDue(id, undefined, day(20_000)) || isDue(id, 0, day(20_000)))).toBe(false);
  });
  it("7 means each id is due on exactly one day of every seven", () => {
    for (const id of ids.slice(0, 50)) expect(Array.from({ length: 7 }, (_, d) => isDue(id, 7, day(20_000 + d))).filter(Boolean)).toHaveLength(1);
  });
  it("7 spreads the ids: each day about a seventh is due", () => {
    for (let d = 0; d < 7; d++) {
      const due = ids.filter((id) => isDue(id, 7, day(20_000 + d))).length;
      expect(due).toBeGreaterThan(60);
      expect(due).toBeLessThan(140);
    }
  });
  it("the same id on the same day always gives the same answer", () => {
    expect(isDue("fake:b:9", 7, day(20_003))).toBe(isDue("fake:b:9", 7, new Date(day(20_003).getTime() + 5_000)));
  });
});

const known = (o: Partial<Known> = {}): Known => ({ advertId: 1, hash: "h", gone: false, jobId: 10, status: "live", closeReason: null, ...o });
describe("stateOf", () => {
  it.each([
    ["not gone, same hash, live job", known(), "h", "same"],
    ["not gone, same hash, no job (a rejected advert)", known({ jobId: null, status: null }), "h", "same"],
    ["different hash", known(), "g", "again"],
    ["no hash yet (saved before this change) counts as changed once", known({ hash: null }), "h", "again"],
    ["gone, same hash: it came back", known({ gone: true, status: "closed", closeReason: "closed" }), "h", "again"],
    ["closed by the fetcher (recheck_failed), changed", known({ status: "closed", closeReason: "recheck_failed" }), "g", "again"],
    ["closed as expired, changed", known({ status: "closed", closeReason: "expired" }), "g", "again"],
    ["in_review, changed", known({ status: "in_review" }), "g", "held"],
    ["hidden, changed", known({ status: "hidden" }), "g", "held"],
    ["in_review, gone and back", known({ status: "in_review", gone: true }), "h", "held"],
    ["draft or under_review are held too", known({ status: "under_review" }), "g", "held"],
    ["closed by staff (removed), changed", known({ status: "closed", closeReason: "removed" }), "g", "settle"],
    ["closed by staff (under_review_expired)", known({ status: "closed", closeReason: "under_review_expired" }), "g", "settle"],
    ["closed with abandoned", known({ status: "closed", closeReason: "abandoned" }), "g", "settle"],
    ["closed with no reason at all is staff's", known({ status: "closed", closeReason: null }), "g", "settle"],
  ] as const)("%s", (_name, k, hash, expected) => {
    expect(stateOf(k, hash)).toBe(expected);
  });
});

describe("changeOf (the table of 3.8)", () => {
  const row = { externalId: "x", url: "u", title: "t", employerName: "e", stage: "s", reason: null, quotedEvidence: null, matcherModel: null } as const;
  const reject: Plan = { action: "reject", advert: { ...row, result: "rejected" } };
  const job = (status: "live" | "in_review"): Plan => ({
    action: "job", text: "t", advert: { ...row, result: status === "live" ? "passed" : "queued" },
    job: { title: "t", employerName: "e", county: null, sector: "IT", occupationCode: null, salaryLow: null, salaryHigh: null, passRoute: null, status, ownPageUrl: "u" },
  });
  const noDefer = (p: Plan) => p as Exclude<Plan, { action: "defer" }>;
  const noJob = known({ jobId: null, status: null });
  const closed = known({ status: "closed", closeReason: "recheck_failed" });
  it.each([
    ["no job, rejected: the advert row only", noJob, reject, "advert"],
    ["no job, passes: a job is made", noJob, job("live"), "insert"],
    ["no job, unsure: a queued job is made", noJob, job("in_review"), "insert"],
    ["live job, passes: content updated", known(), job("live"), "update"],
    ["live job, unsure: content updated and status in_review", known(), job("in_review"), "update"],
    ["live job, now fails: closed", known(), reject, "close"],
    ["closed job, passes: reopened", closed, job("live"), "reopen"],
    ["closed job, unsure: stays closed", closed, job("in_review"), "advert"],
    ["closed job, fails: stays closed", closed, reject, "advert"],
  ] as const)("%s", (_name, k, p, expected) => {
    expect(changeOf(k, noDefer(p))).toBe(expected);
  });
});

describe("stage limit", () => {
  const asm = { stage: "9 ".repeat(200) as Stage, bucket: "queue", reason: null, scamFlag: false, irishReason: null, contractReason: null, sector: "IT", occupationCode: null, salaryLow: null, salaryHigh: null } as unknown as Assessment;
  it("a long stage is cut to 200 code points so the database check can never refuse the advert", () => {
    const p = planAdvert(advert(), asm, null);
    if (p.action === "defer") throw new Error("defer");
    expect(Array.from(p.advert.stage)).toHaveLength(200);
  });
  it("a long stage of emoji is cut by code point, not by UTF-16 unit", () => {
    const p = planAdvert(advert(), { ...asm, stage: "😀".repeat(400) as Stage }, null);
    if (p.action === "defer") throw new Error("defer");
    expect(Array.from(p.advert.stage)).toHaveLength(200);
  });
});

describe("atsTasks reread days", () => {
  it("1 for the kinds whose list call carries the text, 7 for those that need a request per advert", () => {
    const { fetch } = fake(() => reply({}));
    const tasks = atsTasks({ greenhouse: [["g", "G"]], ashby: [["a", "A"]], smartrecruiters: [["s", "S"]], workday: [["W", "t", "wd3", "x"]], amazon: true }, fetch);
    expect(Object.fromEntries(tasks.map((t) => [t.kind, t.rereadDays]))).toEqual({ greenhouse: 1, ashby: 1, smartrecruiters: 7, workday: 7, amazon: 1 });
  });
});
