// Performance budgets of the career-site readers: requests a board costs, the JSON-LD reader on the biggest saved page (State Street, a
// 13,209 character description), and the Salesforce filter on an 11 MB file (time and memory). Budgets leave ten times the measured time, for a loaded build machine.
import { describe, expect, it } from "vitest";
import { fake, none, noSleep } from "../ats/testkit";
import { fetchEightfold, fetchPhenom, fetchSalesforce, jobPosting, readPosting } from "./careers";
import { EF, page, PH, read, SF } from "./testkit";

const timed = <T>(run: () => T) => {
  const t = performance.now();
  const value = run();
  return { value, ms: performance.now() - t };
};

describe("career-site budgets", () => {
  it("JSON-LD reader on the 13k character State Street page: under 5 ms a page (measured 0.4 ms warm)", () => {
    const html = read("phenom-statestreet-R-793506.html");
    expect(readPosting(jobPosting(html)!).description.length).toBeGreaterThan(5_000); // also warms the code
    const { ms } = timed(() => {
      for (let i = 0; i < 100; i++) readPosting(jobPosting(html)!);
    });
    console.log(`perf careers: JSON-LD reader ${(ms / 100).toFixed(2)} ms a page`);
    expect(ms / 100).toBeLessThan(5);
  });
  it("Salesforce filter on an 11 MB file: under 1.5 s and 250 MB more heap (measured 118 ms and 26 MB)", async () => {
    const rows = JSON.parse(read("salesforce-jobs_2.json")).Report_Entry as Record<string, unknown>[];
    const entry = Array.from({ length: 5200 }, (_, i) => ({ ...rows[i % 4]!, Job_Requisition_Ref_ID: `JR${i}` }));
    const body = JSON.stringify({ Report_Entry: entry });
    expect(body.length).toBeGreaterThan(11 * 1024 * 1024);
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const t = performance.now();
    const r = await fetchSalesforce(SF, none, fake(() => page(body)).fetch, noSleep);
    const ms = performance.now() - t;
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    const mb = (peak - before) / 1024 / 1024;
    console.log(`perf careers: Salesforce 11 MB ${ms.toFixed(0)} ms, heap +${mb.toFixed(0)} MB, ${r.seen.length} Irish`);
    expect(r.seen).toHaveLength(2600);
    expect(ms).toBeLessThan(1500);
    expect(mb).toBeLessThan(250);
  });
  it("Phenom with 85 Irish jobs: 2 listing calls and 85 page calls the first day, 2 calls once all are known", async () => {
    const posting = read("phenom-mastercard-R-291229.html");
    const { fetch, calls } = fake((c) => {
      if (c.method !== "POST") return page(posting);
      const from = (c.body as { from: number }).from;
      return page(JSON.stringify({ refineSearch: { totalHits: 85, data: { jobs: Array.from({ length: Math.min(50, 85 - from) }, (_, i) => ({ reqId: `R-${from + i}`, title: "T", country: "Ireland" })) } } }));
    });
    const first = await fetchPhenom(PH.mastercard, none, fetch, noSleep);
    expect([calls.length, first.adverts.length]).toEqual([87, 85]);
    calls.length = 0;
    const again = await fetchPhenom(PH.mastercard, new Set(first.seen), fetch, noSleep);
    expect([calls.length, again.seen.length, again.adverts.length]).toEqual([2, 85, 0]);
  });
  it("Eightfold with 85 Irish jobs: 9 listing calls and 85 detail calls the first day, 9 calls once all are known, under 250 ms (measured 21 ms)", async () => {
    const detail = read("eightfold-amat-790319296162.json");
    const { fetch, calls } = fake((c) => {
      const start = Number(new URL(c.url).searchParams.get("start"));
      if (c.url.includes("position_details")) return page(detail);
      return page(JSON.stringify({ data: { count: 85, positions: Array.from({ length: Math.min(10, 85 - start) }, (_, i) => ({ id: 1000 + start + i, displayJobId: `R${start + i}`, name: "T", locations: ["Leixlip,IRL"] })) } }));
    });
    const t = performance.now();
    const first = await fetchEightfold(EF, none, fetch, noSleep);
    const ms = performance.now() - t;
    console.log(`perf careers: Eightfold 85 jobs ${ms.toFixed(1)} ms, ${calls.length} calls`);
    expect([calls.length, first.adverts.length]).toEqual([9 + 85, 85]);
    expect(ms).toBeLessThan(250);
    calls.length = 0;
    const again = await fetchEightfold(EF, new Set(first.seen), fetch, noSleep);
    expect([calls.length, again.seen.length, again.adverts.length]).toEqual([9, 85, 0]);
  });
});
