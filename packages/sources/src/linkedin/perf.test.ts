// A full search and 250 details cost exactly the requests the rules predict, and one big detail page parses inside a time budget.
import { describe, expect, it } from "vitest";
import { parseLinkedinDetail, TERM_GROUPS } from "./index";
import { detailPage, idOf, isSearch, page, run, searchPage, startOf, termOf } from "./testkit";

const TERMS = TERM_GROUPS.flatMap(([, t]) => t);
// Measured on the build machine, 3 runs: the full run 53 to 54 ms, the 20,000 row list 19 to 20 ms, the large page parse 17 to 18 ms (cold). Budgets are 3 to 4 times that.
const BUDGET = { run: 200, parse: 60 }; // ms
const timed = async <T>(f: () => Promise<T> | T) => {
  const t = performance.now();
  const value = await f();
  return { value, ms: performance.now() - t };
};

describe("request counts", () => {
  it("a full search (every term gives 4 full pages) and 250 details make exactly 44 x 4 + 250 requests and as many sleeps", async () => {
    const termNo = (u: string) => TERMS.indexOf(termOf(u)!);
    const { value, ms } = await timed(() =>
      run((c) => (isSearch(c.url) ? page(searchPage([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => termNo(c.url) * 1000 + startOf(c.url) * 10 + k))) : page(detailPage({ title: `T${idOf(c.url)}` })))),
    );
    // 44 terms x 4 pages = 176 search requests (a page with ids is always followed by the next page, up to the 4th); 1760 ids; 250 read
    expect(value.calls.length).toBe(44 * 4 + 250);
    expect(value.result.requests).toBe(426);
    expect(value.waits.length).toBe(44 * 4 + 250);
    expect(value.result.seen.length).toBe(1760);
    expect(value.result.adverts.length).toBe(250);
    expect(value.result.waiting.filter((r) => !r.done).length).toBe(1760 - 250);
    expect(ms).toBeLessThan(BUDGET.run);
  });
  it("a search where every term has no result makes 44 requests; a full backlog makes 250 and no search", async () => {
    expect((await run(() => page(""))).calls.length).toBe(44);
    const w = Array.from({ length: 1327 }, (_, i) => ({ id: String(i + 1), term: "t", group: "g" + (i % 7), firstSeen: "2026-11-06", lastSeen: "2026-11-06", done: false }));
    const { calls, result } = await run(() => page(detailPage()), w);
    expect(calls.length).toBe(250);
    expect(result.waiting.filter((r) => !r.done).length).toBe(1327 - 250);
  });
  it("a list of 20,000 rows is handled inside the time budget", async () => {
    const w = Array.from({ length: 20_000 }, (_, i) => ({ id: String(i + 1), term: "t", group: "g" + (i % 7), firstSeen: "2026-11-06", lastSeen: "2026-11-06", done: i % 2 === 0 }));
    const { value, ms } = await timed(() => run(() => page(detailPage()), w, { options: { maxRequests: 300 } }));
    expect(value.calls.length).toBe(250);
    expect(ms).toBeLessThan(BUDGET.run);
  });
});

describe("parse time", () => {
  it("one large detail page (about 600 KB, a long description with many tags) parses inside the budget", async () => {
    const desc = "<p>Made up paragraph with <b>bold</b> &amp; text.</p><ul><li>one</li><li>two</li></ul>".repeat(6000);
    const d = detailPage({ desc, type: "Full-time", salary: "x" });
    expect(d.length).toBeGreaterThan(450_000);
    const { value, ms } = await timed(() => parseLinkedinDetail("1", d));
    expect(value.description.length).toBeGreaterThan(100_000);
    expect(ms).toBeLessThan(BUDGET.parse);
  });
});
