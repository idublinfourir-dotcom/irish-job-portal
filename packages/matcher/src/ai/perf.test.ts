// Time and request count for the matcher with a fake model. Budgets are about three times the measured time (see the hand-over).
import { describe, expect, it } from "vitest";
import { createAiMatcher } from "./matcher";
import { answer, ENTRIES, fakeClient } from "./testkit";

// Measured on 10 November 2026: about 300 ms for the 1,000 adverts (three runs: 300, 303, 328). Budget 1,000 ms.
const BUDGET_MS = 1000;

describe("performance", () => {
  it("1,000 adverts of about 10,000 characters: one request each, inside the time budget", async () => {
    const f = fakeClient(answer({ quote: "design cloud systems" }));
    const { match } = createAiMatcher({ client: f.client, modelId: "m", entries: ENTRIES });
    const body = "We need a person to design cloud systems. ".repeat(250); // about 10,500 characters
    const started = performance.now();
    for (let i = 0; i < 1000; i++) await match(`Cloud architect ${i}`, `${body}${i}`);
    const ms = performance.now() - started;
    console.log(`1,000 adverts in ${ms.toFixed(0)} ms`);
    expect(f.prompts).toHaveLength(1000);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("two requests, not more, for an advert whose answers are bad", async () => {
    const f = fakeClient("nope");
    await createAiMatcher({ client: f.client, modelId: "m", entries: ENTRIES }).match("t", "d");
    expect(f.prompts).toHaveLength(2);
  });
});
