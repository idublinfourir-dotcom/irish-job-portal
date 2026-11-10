// The runner end to end with the real chain (`assess`), a made-up test set and a fake model host.
// No real model and no real test set are used anywhere in this file.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENTRIES } from "../ai/testkit";
import { runGate } from "./run";
import { sha256 } from "./testset";

const KEY = "sk-gate-test-KEY-98765";
const ARCH = "Cloud Solutions Architect";
const advert = (title: string) => ({ source: "greenhouse", employer: "Example Ltd", title, location: "Dublin, Ireland", description: `Design cloud systems. Salary EUR 70,000 per year. Fixed term contract of 36 months. Role: ${title}.` });
const line = (id: string, title: string, qualifies: boolean) => JSON.stringify({ id, advert: advert(title), label: { qualifies, occupationCode: "2135", note: "made up" } });

/** passedRight + passedWrong architect adverts (the model says yes to all), then rejectedRight chef adverts (the model says ineligible). */
function setOf(passedRight: number, passedWrong: number, rejectedRight: number) {
  const lines: string[] = [];
  for (let i = 0; i < passedRight; i++) lines.push(line(`ok-${i}`, ARCH, true));
  for (let i = 0; i < passedWrong; i++) lines.push(line(`bad-${i}`, ARCH, false));
  for (let i = 0; i < rejectedRight; i++) lines.push(line(`chef-${i}`, "Head Chef", false));
  return lines.join("\n") + "\n";
}

/** A fake model host. `failFrom`: from this call number on it answers HTTP 429. */
function fakeHost(failFrom = Infinity) {
  const calls: { url: string; body: { messages: { content: string }[] } }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    calls.push({ url: String(input), body });
    if (calls.length >= failFrom) return new Response(`quota used up for ${KEY}`, { status: 429 });
    const user = body.messages[1].content as string;
    const reply = user.includes("Head Chef")
      ? { code: "5111", entry: "in-1", confidence: "high", quote: "Head Chef" }
      : { code: "2135", entry: "cs-2", confidence: "high", quote: "Design cloud systems" };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

let dir: string;
const write = (set: string, hash = sha256(set)) => {
  writeFileSync(join(dir, "testset.jsonl"), set);
  writeFileSync(join(dir, "testset.sha256"), `${hash}  testset.jsonl\n`);
};
const env = (extra: Record<string, string> = {}) => ({ PORTAL_PRIVATE_DATA: dir, PORTAL_GATE_MODEL_URL: "https://models.example/v1", PORTAL_GATE_MODEL_KEY: KEY, PORTAL_GATE_MODEL_ID: "vendor/model:free", ...extra });
const noSleep = async () => {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gate-"));
  writeFileSync(join(dir, "dete-2026.json"), "[]");
  writeFileSync(join(dir, "public_employers_candidates.json"), "{}");
  writeFileSync(join(dir, "occupation-lists.json"), JSON.stringify(ENTRIES));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("runGate with a fake model", () => {
  it("a set that passes: 300 rows, all badges right", async () => {
    write(setOf(60, 0, 240));
    const host = fakeHost();
    const { report, file } = await runGate(env(), { fetch: host.fetch, sleep: noSleep });
    expect(report.score).toMatchObject({ scored: 300, passed: 60, passedCorrect: 60, share: 1, rejected: 240, rejectedCorrect: 240, enoughRows: true, holds: true, wrongPassed: [], wrongRejected: [] });
    expect(report).toMatchObject({ matcher: "ai", modelId: "vendor/model:free", testSetSha256: sha256(readFileSync(join(dir, "testset.jsonl"))), modelCalls: 300, answersReused: 0, badAnswers: 0 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(report);
    expect(host.calls).toHaveLength(300);
  });

  it("a set that fails at 97%", async () => {
    write(setOf(291, 9, 0));
    const { report } = await runGate(env(), { fetch: fakeHost().fetch, sleep: noSleep });
    expect(report.score.share).toBe(0.97);
    expect(report.score.holds).toBe(false);
    expect(report.score.wrongPassed).toEqual(Array.from({ length: 9 }, (_, i) => `bad-${i}`));
  });

  it("a set under 300 rows reports the numbers and is not a gate", async () => {
    write(setOf(50, 0, 49));
    const { report } = await runGate(env(), { fetch: fakeHost().fetch, sleep: noSleep });
    expect(report.score).toMatchObject({ scored: 99, share: 1, enoughRows: false, holds: false });
    expect(report.score.note).toMatch(/not a gate/);
  });

  it("refuses a set that was changed after it was frozen, and calls no model", async () => {
    const set = setOf(5, 0, 5);
    write(set + " ", sha256(set));
    const host = fakeHost();
    await expect(runGate(env(), { fetch: host.fetch })).rejects.toThrow(/does not match its frozen hash/);
    expect(host.calls).toHaveLength(0);
  });

  it("a stopped run goes on from the saved answers and makes no second call for a saved advert", async () => {
    write(setOf(6, 0, 4)); // 10 adverts
    const first = fakeHost(5); // the 5th call is refused (quota)
    await expect(runGate(env(), { fetch: first.fetch, sleep: noSleep })).rejects.toThrow(/stopped at advert ok-4: model host answered HTTP 429.*run again later/);
    expect(first.calls).toHaveLength(5);
    expect(readdirSync(join(dir, "answers"))).toHaveLength(4); // the refused call saved nothing
    expect(readdirSync(dir).filter((n) => n.startsWith("report"))).toEqual([]); // no report from half a run

    const second = fakeHost();
    const { report } = await runGate(env(), { fetch: second.fetch, sleep: noSleep });
    expect(second.calls).toHaveLength(6); // 10 adverts, 4 saved
    expect(report).toMatchObject({ modelCalls: 6, answersReused: 4 });
    expect(report.score.scored).toBe(10);

    const third = fakeHost();
    const again = await runGate(env(), { fetch: third.fetch, sleep: noSleep });
    expect(third.calls).toHaveLength(0);
    expect(again.report.score).toEqual(report.score);
  });

  it("waits between real requests only, through the sleep it is given", async () => {
    write(setOf(3, 0, 0));
    const waits: number[] = [];
    await runGate(env({ PORTAL_GATE_DELAY_MS: "250" }), { fetch: fakeHost().fetch, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([250, 250]);
    waits.length = 0;
    await runGate(env({ PORTAL_GATE_DELAY_MS: "250" }), { fetch: fakeHost().fetch, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([]); // all saved
  });

  it("sends only title and description of each advert, to the address it was given", async () => {
    write(setOf(2, 0, 0));
    const host = fakeHost();
    await runGate(env(), { fetch: host.fetch, sleep: noSleep });
    for (const c of host.calls) {
      expect(c.url).toBe("https://models.example/v1/chat/completions");
      const sent = JSON.stringify(c.body);
      expect(sent).not.toContain("Example Ltd");
      expect(sent).not.toContain("Dublin");
    }
  });

  it("keeps the key out of the report, the saved answers and the error", async () => {
    write(setOf(6, 0, 0));
    const failing = fakeHost(3);
    const e = (await runGate(env(), { fetch: failing.fetch, sleep: noSleep }).catch((x: Error) => x)) as Error;
    expect(e.message).not.toContain(KEY);
    await runGate(env(), { fetch: fakeHost().fetch, sleep: noSleep });
    for (const name of [...readdirSync(dir).filter((n) => n.startsWith("report")), ...readdirSync(join(dir, "answers")).map((n) => join("answers", n))]) {
      expect(readFileSync(join(dir, name), "utf8")).not.toContain(KEY);
    }
    expect(readdirSync(dir).join()).not.toContain(KEY);
  });

  it("the report holds numbers and ids, never advert text", async () => {
    write(setOf(2, 1, 1));
    const { file } = await runGate(env(), { fetch: fakeHost().fetch, sleep: noSleep });
    const text = readFileSync(file, "utf8");
    for (const word of ["Architect", "Design cloud", "Example Ltd", "Dublin", "Chef"]) expect(text).not.toContain(word);
    expect(text).toContain("bad-0");
  });

  it("counts a bad model answer as not passed and reports how many", async () => {
    write(setOf(3, 0, 0));
    const host = { fetch: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "yes it qualifies" } }] }), { status: 200 })) as typeof fetch };
    const { report } = await runGate(env(), { fetch: host.fetch, sleep: noSleep });
    expect(report.badAnswers).toBe(3);
    expect(report.score).toMatchObject({ passed: 0, rejected: 3, wrongRejected: ["ok-0", "ok-1", "ok-2"] });
  });
});

describe("runGate with the rules matcher alone", () => {
  it("needs no key and makes no network call", async () => {
    write(setOf(3, 0, 2));
    const refusing = (async () => {
      throw new Error("the network was used");
    }) as typeof fetch;
    const { report, file } = await runGate({ PORTAL_PRIVATE_DATA: dir, PORTAL_GATE_MATCHER: "rules" }, { fetch: refusing });
    expect(report).toMatchObject({ matcher: "rules", modelId: null, modelCalls: 0 });
    expect(report.score.scored).toBe(5);
    expect(file).toBe(join(dir, "report-rules.json"));
  });
});

describe("runGate fails with a clear message", () => {
  const f = fakeHost().fetch;
  it("when PORTAL_PRIVATE_DATA is not set", async () => {
    await expect(runGate({}, { fetch: f })).rejects.toThrow(/PORTAL_PRIVATE_DATA is not set/);
  });
  it("when the test set is missing", async () => {
    await expect(runGate(env(), { fetch: f })).rejects.toThrow(/the test set \(testset\.jsonl\) is missing/);
  });
  it("when the frozen hash is missing", async () => {
    writeFileSync(join(dir, "testset.jsonl"), setOf(1, 0, 0));
    await expect(runGate(env(), { fetch: f })).rejects.toThrow(/frozen hash \(testset\.sha256\) is missing/);
  });
  it("when a model setting is missing", async () => {
    write(setOf(1, 0, 0));
    await expect(runGate({ PORTAL_PRIVATE_DATA: dir }, { fetch: f })).rejects.toThrow(/PORTAL_GATE_MODEL_ID is not set/);
    await expect(runGate(env({ PORTAL_GATE_MODEL_KEY: "" }), { fetch: f })).rejects.toThrow(/PORTAL_GATE_MODEL_KEY is not set/);
  });
  it("when the occupation lists are missing", async () => {
    write(setOf(1, 0, 0));
    rmSync(join(dir, "occupation-lists.json"));
    await expect(runGate(env(), { fetch: f })).rejects.toThrow(/occupation-lists\.json\) is missing/);
  });
});
