import type { Assessment } from "@portal/rules";
import { assess } from "@portal/rules";
import { describe, expect, it } from "vitest";
import { rulesMatcher } from "../rules";
import { createBatchChecker, type BatchResult } from "./batch";
import { applySecondOpinion, HIGH_PAY, keepsBadge, SHOWN } from "./secondOpinion";
import { batchReply, ENTRIES, item as plain } from "./testkit";

const item = (id: string, o: Record<string, unknown> = {}) => plain(id, { quote: "Design cloud systems", ...o });

const [CS1, CS2, IN1] = ENTRIES as [(typeof ENTRIES)[0], (typeof ENTRIES)[0], (typeof ENTRIES)[0]];
const result = (entry: (typeof ENTRIES)[0] | null, confidence: "high" | "medium" | "low" | "none" = "high", failed = false): BatchResult => ({
  match: { occupationCode: entry?.code ?? "none", onCriticalSkillsList: entry ? (entry.list === "critical-skills" ? "yes" : "no") : "unknown", confidence },
  quote: null,
  modelId: "m",
  failure: failed ? { kind: "bad answer", why: "x" } : null,
  entry,
});

describe("keepsBadge: the Critical Skills list route (pay up to 68,911 or not stated)", () => {
  it.each([null, 40_904, 68_911])("pay %s: a Critical Skills pick at medium or high stays", (pay) => {
    expect(keepsBadge(result(CS1, "high"), pay)).toBe(true);
    expect(keepsBadge(result(CS2, "medium"), pay)).toBe(true);
  });
  it.each([null, 50_000])("pay %s: low confidence, an Ineligible pick, none or a failure goes to the queue", (pay) => {
    expect(keepsBadge(result(CS1, "low"), pay)).toBe(false);
    expect(keepsBadge(result(IN1, "high"), pay)).toBe(false);
    expect(keepsBadge(result(null, "none"), pay)).toBe(false);
    expect(keepsBadge(result(CS1, "high", true), pay)).toBe(false);
  });
});

describe("keepsBadge: the high pay route (pay over 68,911)", () => {
  const pay = HIGH_PAY + 1;
  it("stays when the pick is not on the Ineligible list, whatever the confidence: a Critical Skills pick, low confidence, or none", () => {
    expect(keepsBadge(result(CS1, "high"), pay)).toBe(true);
    expect(keepsBadge(result(CS1, "low"), pay)).toBe(true);
    expect(keepsBadge(result(null, "none"), pay)).toBe(true);
  });
  it("goes to the queue when the pick is on the Ineligible list, or the answer failed", () => {
    expect(keepsBadge(result(IN1, "high"), pay)).toBe(false);
    expect(keepsBadge(result(null, "low", true), pay)).toBe(false);
  });
  it("exactly 68,911 is still the list route (the rule says over)", () => {
    expect(keepsBadge(result(null, "none"), HIGH_PAY)).toBe(false);
  });
});

const dete = { deteNames: new Set<string>(), publicPayCandidates: new Map<string, 1 | 2>(), matcher: rulesMatcher };
const advert = (title: string, pay: number, n = 0) => ({ source: "greenhouse", employer: `Example ${n} Ltd`, title, location: "Dublin, Ireland", description: `Design cloud systems. Salary EUR ${pay} per year. Fixed term contract of 36 months. Ref ${n}.` });
const rowsOf = async (adverts: ReturnType<typeof advert>[]) => Promise.all(adverts.map(async (a) => ({ advert: a, assessment: await assess(a, dete) })));

describe("applySecondOpinion with the real chain", () => {
  it("only badges are sent, in batches of the size given, and the order is kept", async () => {
    const adverts = [
      ...Array.from({ length: 25 }, (_, i) => advert("Cloud Solutions Architect", 50_000, i)),
      advert("Head Chef", 50_000), // rejected by the rules: never sent
    ];
    const rows = await rowsOf(adverts);
    expect(rows.filter((r) => SHOWN.has(r.assessment.bucket))).toHaveLength(25);
    const f = batchReply((n) => Array.from({ length: n === 3 ? 5 : 10 }, (_, i) => item(`A${i + 1}`)));
    const out = await applySecondOpinion(rows, createBatchChecker({ client: f.client, modelId: "m", entries: ENTRIES }), 10);
    expect(f.prompts).toHaveLength(3);
    expect(f.prompts.map((p) => p.user.split("<<<END ADVERT").length - 1)).toEqual([10, 10, 5]);
    expect(f.prompts.join()).not.toContain("Head Chef");
    expect(out).toHaveLength(26);
    expect(out.slice(0, 25).every((a) => a.bucket === "stated_pay")).toBe(true);
    expect(out[25]).toBe(rows[25]!.assessment); // untouched, same object
  });

  it("a badge the AI does not back moves to the admin queue (stage 5, bucket queue), never dropped", async () => {
    const rows = await rowsOf([advert("Cloud Solutions Architect", 50_000, 1), advert("Cloud Solutions Architect", 50_000, 2)]);
    const f = batchReply([item("A1"), item("A2", { code: "5111", entry: "in-1" })]);
    const out = await applySecondOpinion(rows, createBatchChecker({ client: f.client, modelId: "m", entries: ENTRIES }));
    expect(out[0]!.bucket).toBe("stated_pay");
    expect(out[1]).toMatchObject({ stage: "5 unsure occupation (admin queue)", bucket: "queue", salaryLow: 50_000 });
    expect(rows[1]!.assessment.bucket).toBe("stated_pay"); // the input is not changed
  });

  it("the two routes through the chain: pay 50,000 needs the list, pay 70,000 only needs not Ineligible", async () => {
    const rows = await rowsOf([advert("Cloud Solutions Architect", 50_000, 1), advert("Cloud Solutions Architect", 70_000, 2)]);
    const none = { code: "none", entry: "none", quote: "" };
    const f = batchReply([item("A1", none), item("A2", none)]);
    const out = await applySecondOpinion(rows, createBatchChecker({ client: f.client, modelId: "m", entries: ENTRIES }));
    expect(out.map((a: Assessment) => a.bucket)).toEqual(["queue", "stated_pay"]);
  });

  it("a model fault queues the whole batch's badges", async () => {
    const rows = await rowsOf([advert("Cloud Solutions Architect", 70_000, 1), advert("Cloud Solutions Architect", 50_000, 2)]);
    const f = batchReply("garbage");
    const out = await applySecondOpinion(rows, createBatchChecker({ client: f.client, modelId: "m", entries: ENTRIES }));
    expect(out.map((a) => a.bucket)).toEqual(["queue", "queue"]);
  });

  it("sends nothing when there is no badge", async () => {
    const f = batchReply([]);
    const out = await applySecondOpinion(await rowsOf([advert("Head Chef", 50_000)]), createBatchChecker({ client: f.client, modelId: "m", entries: ENTRIES }));
    expect(f.prompts).toHaveLength(0);
    expect(out).toHaveLength(1);
  });

  it("refuses a batch size that is not a whole number of at least 1, and a checker that answers the wrong count", async () => {
    const rows = await rowsOf([advert("Cloud Solutions Architect", 50_000, 1)]);
    for (const bad of [0, -1, 1.5, Number.NaN]) await expect(applySecondOpinion(rows, async () => [], bad)).rejects.toThrow(/batch size/);
    await expect(applySecondOpinion(rows, async () => [])).rejects.toThrow(/different number/);
  });

  it("the check throwing is not hidden", async () => {
    const rows = await rowsOf([advert("Cloud Solutions Architect", 50_000, 1)]);
    await expect(applySecondOpinion(rows, async () => { throw new Error("stop"); })).rejects.toThrow("stop");
  });
});
