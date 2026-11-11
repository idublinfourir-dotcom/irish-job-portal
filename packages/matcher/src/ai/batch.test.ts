import { describe, expect, it } from "vitest";
import { createBatchChecker } from "./batch";
import { ADVERT, batchReply, CHEF, ENTRIES, item } from "./testkit";

const QUEUE = { occupationCode: "none", onCriticalSkillsList: "unknown", confidence: "low" };
const two = [ADVERT, CHEF];
const chef = (id: string, o: Record<string, unknown> = {}) => item(id, { code: "5111", entry: "in-1", quote: "cook fine meals", ...o });
const make = (reply: Parameters<typeof batchReply>[0], retry?: boolean) => {
  const f = batchReply(reply);
  return { ...f, check: createBatchChecker({ client: f.client, modelId: "test/model", entries: ENTRIES, options: { retry } }) };
};

describe("the request", () => {
  it("is one request with an id on each advert, the lists and the rules", async () => {
    const m = make([item("A1"), chef("A2")]);
    await m.check(two);
    expect(m.prompts).toHaveLength(1);
    const { system, user } = m.prompts[0]!;
    expect(user).toBe(
      [
        "<<<ADVERT A1>>>",
        "Title: Cloud Solutions Architect",
        "Description:",
        ADVERT.description,
        "<<<END ADVERT A1>>>",
        "",
        "<<<ADVERT A2>>>",
        "Title: Head Chef",
        "Description:",
        CHEF.description,
        "<<<END ADVERT A2>>>",
      ].join("\n"),
    );
    expect(system).toContain("cs-2 | 2135 | IT business analyst, architect | critical-skills");
    expect(system).toContain("in-1 | 5111 | Chef de partie | ineligible");
    expect(system).toContain("Judge each advert alone");
  });
  it("does nothing for an empty batch", async () => {
    const m = make([]);
    expect(await m.check([])).toEqual([]);
    expect(m.prompts).toHaveLength(0);
  });
  it("refuses a bad list entry, as the one advert matcher does", () => {
    expect(() => createBatchChecker({ client: async () => "", modelId: "m", entries: [{ id: "x", code: "12", title: "t", list: "ineligible" }] })).toThrow(/bad list entry/);
  });
});

describe("the answers", () => {
  it("a good batch: one result per advert, in order, with the picked entry", async () => {
    const r = await make([chef("A2"), item("A1")]).check(two); // answered out of order
    expect(r[0]).toMatchObject({ match: { occupationCode: "2135", onCriticalSkillsList: "yes", confidence: "high" }, quote: "design cloud systems", modelId: "test/model", failure: null, entry: ENTRIES[1] });
    expect(r[1]).toMatchObject({ match: { occupationCode: "5111", onCriticalSkillsList: "no", confidence: "high" }, failure: null, entry: ENTRIES[2] });
  });
  it("a fenced reply is read", async () => {
    const r = await make("```json\n" + JSON.stringify([item("A1")]) + "\n```").check([ADVERT]);
    expect(r[0]!.failure).toBeNull();
  });
  it("none is a usable answer, not a failure", async () => {
    const r = await make([item("A1", { code: "none", entry: "none", quote: "" })]).check([ADVERT]);
    expect(r[0]).toMatchObject({ match: { occupationCode: "none", confidence: "none" }, quote: null, failure: null, entry: null });
  });
  it("one bad answer queues that advert only, and costs no second request", async () => {
    const m = make([item("A1"), chef("A2", { entry: "in-99" })]);
    const r = await m.check(two);
    expect(r[0]!.failure).toBeNull();
    expect(r[1]).toMatchObject({ match: QUEUE, quote: null, failure: { kind: "bad answer", why: "entry id was not sent" }, entry: null });
    expect(m.prompts).toHaveLength(1);
  });
  it("a quote taken from another advert queues the advert", async () => {
    const r = await make([item("A1", { quote: "cook fine meals" }), chef("A2")]).check(two);
    expect(r[0]).toMatchObject({ match: QUEUE, failure: { why: "quote not found in this advert" } });
    expect(r[1]!.failure).toBeNull();
  });
  it("a reply that misses an id queues that advert", async () => {
    const m = make([item("A1")]);
    const r = await m.check(two);
    expect(r[0]!.failure).toBeNull();
    expect(r[1]).toMatchObject({ match: QUEUE, failure: { kind: "bad answer", why: "no answer for this advert" } });
    expect(m.prompts).toHaveLength(1);
  });
  it("a code without an entry queues the advert", async () => {
    const r = await make([item("A1", { entry: "none" })]).check([ADVERT]);
    expect(r[0]).toMatchObject({ match: QUEUE, failure: { why: "a code without an entry" } });
  });
  it("a code that does not match its entry queues the advert", async () => {
    const r = await make([item("A1", { code: "2134" })]).check([ADVERT]);
    expect(r[0]).toMatchObject({ match: QUEUE, failure: { why: "code does not match its entry" } });
  });
  it("a missing field queues the advert", async () => {
    const noQuote: Record<string, unknown> = item("A1");
    delete noQuote.quote;
    const r = await make([noQuote]).check([ADVERT]);
    expect(r[0]).toMatchObject({ match: QUEUE, failure: { why: "fields are not exactly code, entry, confidence, quote" } });
  });
});

describe("the retry", () => {
  it("a garbled reply then a good one: two requests, the second with a note, good results", async () => {
    const m = make((n) => (n === 1 ? "Sure! here you go" : [item("A1"), chef("A2")]));
    const r = await m.check(two);
    expect(m.prompts).toHaveLength(2);
    expect(m.prompts[1]!.user).toBe(`${m.prompts[0]!.user}\n\nYour last reply could not be used. Reply with the JSON array only.`);
    expect(r.map((x) => x.failure)).toEqual([null, null]);
  });
  it("garbled twice: every advert is queued after exactly two requests", async () => {
    const m = make("no");
    const r = await m.check(two);
    expect(m.prompts).toHaveLength(2);
    expect(r.map((x) => [x.match, x.failure])).toEqual([[QUEUE, { kind: "bad answer", why: "not JSON" }], [QUEUE, { kind: "bad answer", why: "not JSON" }]]);
  });
  it("a reply that is JSON but answers no advert is asked again too", async () => {
    const m = make((n) => (n === 1 ? [item("A9")] : [item("A1")]));
    const r = await m.check([ADVERT]);
    expect(m.prompts).toHaveLength(2);
    expect(r[0]!.failure).toBeNull();
  });
  it("retry off: one request", async () => {
    const m = make("no", false);
    await m.check(two);
    expect(m.prompts).toHaveLength(1);
  });
});

describe("a model error", () => {
  it("queues every advert, with the error, and does not retry or throw", async () => {
    const f = batchReply(() => {
      throw new Error("model host answered HTTP 429");
    });
    const r = await createBatchChecker({ client: f.client, modelId: "m", entries: ENTRIES })(two);
    expect(f.prompts).toHaveLength(1);
    expect(r.map((x) => x.failure)).toEqual([{ kind: "model error", why: "model host answered HTTP 429" }, { kind: "model error", why: "model host answered HTTP 429" }]);
  });
});
