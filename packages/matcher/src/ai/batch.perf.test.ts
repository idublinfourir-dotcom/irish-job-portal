// Size and time for the batched check with a fake model. Measured on 11 November 2026: about 210 ms for the 100 batches (200, 213, 208); the time budget is about three times that. The size limits are exact.
import { describe, expect, it } from "vitest";
import { createBatchChecker } from "./batch";
import { batchSystemMessage, buildBatchPrompt } from "./prompt";
import { batchReply, ENTRIES, item } from "./testkit";

const body = (n: number) => `We need a person to design cloud systems. ${n} `.repeat(300); // well over 6,000 characters
const adverts = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Cloud architect ${i}`.padEnd(400, "x"), description: body(i) }));

// A real list is about 250 lines; build one so the system message is realistic.
const REAL_LIST = Array.from({ length: 250 }, (_, i) => ({ id: `e-${i}`, code: String(1000 + i), title: "An occupation title of about this long", list: i < 60 ? ("critical-skills" as const) : ("ineligible" as const) }));

describe("the batch prompt", () => {
  it("10 adverts at the description limit: the user message stays under 64,500 characters, the system message under 20,000", () => {
    const { prompt } = buildBatchPrompt(batchSystemMessage(REAL_LIST), adverts(10), { title: 300, description: 6000 });
    console.log(`batch of 10 at the limits: user ${prompt.user.length} characters, system ${prompt.system.length}`);
    expect(prompt.user.length).toBeLessThan(10 * (6000 + 300 + 100) + 500); // 64,500
    expect(prompt.system.length).toBeLessThan(20_000);
  });
});

describe("checking the answers", () => {
  it("100 batches of 10 adverts at the limits (answers read and every quote searched) in under 600 ms", async () => {
    const list = adverts(10);
    const reply = JSON.stringify(list.map((_, i) => item(`A${i + 1}`, { quote: "design cloud systems." })));
    const f = batchReply(reply);
    const check = createBatchChecker({ client: f.client, modelId: "m", entries: ENTRIES });
    const started = performance.now();
    for (let i = 0; i < 100; i++) await check(list);
    const ms = performance.now() - started;
    console.log(`100 batches of 10 in ${ms.toFixed(0)} ms (${(ms / 100).toFixed(1)} ms a batch, prompt building included)`);
    expect(f.prompts).toHaveLength(100);
    expect(ms).toBeLessThan(600);
  });

  it("a garbled reply costs two requests, not more", async () => {
    const f = batchReply("nope");
    await createBatchChecker({ client: f.client, modelId: "m", entries: ENTRIES })(adverts(10));
    expect(f.prompts).toHaveLength(2);
  });
});
