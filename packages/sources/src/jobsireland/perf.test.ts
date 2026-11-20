// Performance budgets of the JobsIreland kind: the mapping (time per 1,000 jobs), and one first-load run at the real board size (4,320 jobs, two
// thirds welfare schemes as on 20 Nov 2026) under the default cap: requests, the polite pause time it plans (at least one second a request) and its CPU time.
import { describe, expect, it } from "vitest";
import { fake, none } from "../ats/testkit";
import { fetchJobsIreland, JI_GAP_MS, jiAdvert } from "./jobsireland";
import { api, B, card, DETAIL, details, hex, lists } from "./testkit";

describe("JobsIreland budgets", () => {
  it("mapping: under 300 ms per 1,000 jobs with a 5,000 character description (measured 37 ms)", () => {
    const d = { ...DETAIL, jobDescription: "Care assistant wanted. ".repeat(220), displaySalary: true, offeredRemunerationPackages: [{ minimumAmount: 30000, maximumAmount: 39999 }] };
    for (let i = 0; i < 200; i++) jiAdvert("jobsireland", hex(i), d, "2026-11-20"); // warm
    const t = performance.now();
    for (let i = 0; i < 1000; i++) jiAdvert("jobsireland", hex(i), d, "2026-11-20");
    const ms = performance.now() - t;
    console.log(`perf jobsireland: mapping ${ms.toFixed(1)} ms per 1,000 jobs`);
    expect(ms).toBeLessThan(300);
  });
  it("first load of 4,320 jobs, cap 500: 44 list calls and 500 detail reads, about 9 minutes of pauses, under 3 s of CPU", async () => {
    const cards = Array.from({ length: 4320 }, (_, i) => card(i, { vacancyType: i % 3 === 0 ? "VTY1" : "VTY4" }));
    const { fetch, calls } = fake(api(cards));
    let paused = 0;
    const t = performance.now();
    const r = await fetchJobsIreland(B, none, fetch, { sleep: async (ms) => void (paused += ms) });
    const ms = performance.now() - t;
    console.log(`perf jobsireland: ${calls.length} requests, ${(paused / 60_000).toFixed(1)} min of pauses, ${ms.toFixed(0)} ms CPU, ${r.seen.length} seen, ${r.adverts.length} read`);
    expect(lists(calls)).toHaveLength(44);
    expect(details(calls)).toHaveLength(500);
    expect(r.seen).toHaveLength(1440);
    expect(r.adverts).toHaveLength(500);
    expect(paused).toBe((calls.length - 1) * JI_GAP_MS); // one second between every two requests, no faster
    expect(paused).toBeLessThanOrEqual(10 * 60_000); // the board's share of the 25 minute run (with a real reply time of about 0.3 s, about 12 minutes)
    expect(ms).toBeLessThan(3000);
  });
});
