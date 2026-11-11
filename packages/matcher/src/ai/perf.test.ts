// Time and request count for the matcher with a fake model. Budgets are about three times the measured time (see the hand-over).
import { describe, expect, it } from "vitest";
import { checkAnswer } from "./check";
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

// The close-quote check on its worst case: a 500-character quote of 250 one-letter words against a 6,000-character advert of one-letter
// words that never match well enough, so the whole table is filled. Measured on 11 November 2026: about 2 ms for 6,000 characters and 18 ms for 60,000 (linear). Budget 20 ms, about ten times the measure.
describe("the close quote check", () => {
  const quote = Array.from({ length: 250 }, (_, i) => "ab"[i % 2]).join(" "); // 499 characters
  const advertOf = (chars: number) => Array.from({ length: chars / 2 }, (_, i) => "cd"[i % 2]).join(" "); // never matches
  const run = (chars: number) => {
    const text = advertOf(chars);
    const raw = answer({ quote });
    const byId = new Map(ENTRIES.map((e) => [e.id, e]));
    const started = performance.now();
    const r = checkAnswer(raw, byId, text);
    expect(r).toMatchObject({ ok: true, quoteFound: false });
    return performance.now() - started;
  };
  const best = (chars: number) => Math.min(run(chars), run(chars), run(chars));

  it("a 6,000-character advert takes under 20 ms, and ten times the advert takes under twenty times as long (linear)", () => {
    run(6000); // warm up
    const small = best(6000);
    const big = best(60_000);
    console.log(`close quote, worst case: 6,000 characters ${small.toFixed(1)} ms, 60,000 characters ${big.toFixed(1)} ms`);
    expect(small).toBeLessThan(20);
    expect(big).toBeLessThan(Math.max(20 * small, 20));
  });
});
