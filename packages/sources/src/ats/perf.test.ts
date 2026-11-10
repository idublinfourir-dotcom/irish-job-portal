// A board of 600 postings costs exactly the requests the paging predicts, and finishes inside a time budget.
// Budgets are 1 second, about four to five times the slowest measurement on the build machine (the first test of a run is the slowest: cold code).
import { describe, expect, it } from "vitest";
import { fetchAmazon, fetchAshby, fetchGreenhouse, fetchSmartRecruiters, fetchWorkday } from "./index";
import { fake, fixtures as fx, none, reply } from "./testkit";

const N = 600;
const GH = { slug: "acme", employer: "Acme" };
const WD = { employer: "Acme", tenant: "acme", wd: "wd3", site: "External" };
const known = (prefix: string, ids: (string | number)[]) => new Set(ids.map((i) => `${prefix}${i}`));
const timed = async <T>(run: () => Promise<T>) => {
  const t = performance.now();
  const value = await run();
  return { value, ms: performance.now() - t };
};
const ghJob = (i: number) => ({ ...fx.greenhouse.jobs[0]!, id: i });
const ashbyJob = (i: number) => ({ ...fx.ashby.jobs[0]!, id: String(i) });
const amazonJob = (i: number) => ({ ...fx.amazon.jobs[0]!, id_icims: String(i) });
const srDetail = Object.values(fx.srDetails)[0] as object;
const wdDetail = Object.values(fx.wdDetails)[0] as object;
const BUDGET = { one: 1000, many: 1000 }; // ms

describe("600 postings", () => {
  it("greenhouse: 1 request (measured 225 to 235 ms, cold)", async () => {
    const { fetch, calls } = fake(() => reply({ jobs: Array.from({ length: N }, (_, i) => ghJob(i)) }));
    const { value, ms } = await timed(() => fetchGreenhouse(GH, none, fetch));
    expect([calls.length, value.seen.length, value.adverts.length]).toEqual([1, N, N]);
    expect(ms).toBeLessThan(BUDGET.one);
  });
  it("ashby: 1 request (measured 55 ms)", async () => {
    const { fetch, calls } = fake(() => reply({ jobs: Array.from({ length: N }, (_, i) => ashbyJob(i)) }));
    const { value, ms } = await timed(() => fetchAshby(GH, none, fetch));
    expect([calls.length, value.seen.length, value.adverts.length]).toEqual([1, N, N]);
    expect(ms).toBeLessThan(BUDGET.one);
  });
  it("amazon: 6 requests, all new (measured 90 to 105 ms)", async () => {
    const { fetch, calls } = fake((c) => {
      const off = Number(new URL(c.url).searchParams.get("offset"));
      return reply({ hits: N, jobs: Array.from({ length: 100 }, (_, i) => amazonJob(off + i)) });
    });
    const { value, ms } = await timed(() => fetchAmazon(undefined, none, fetch));
    expect([calls.length, value.seen.length, value.adverts.length]).toEqual([6, N, N]);
    expect(ms).toBeLessThan(BUDGET.many);
  });
  it("smartrecruiters: 6 list requests + 600 detail requests (measured 92 to 99 ms)", async () => {
    const { fetch, calls } = fake((c) => {
      if (c.url.includes("?")) {
        const off = Number(new URL(c.url).searchParams.get("offset"));
        return reply({ totalFound: N, content: Array.from({ length: 100 }, (_, i) => ({ id: String(off + i) })) });
      }
      return reply(srDetail);
    });
    const { value, ms } = await timed(() => fetchSmartRecruiters(GH, none, fetch));
    expect([calls.length, value.seen.length, value.adverts.length]).toEqual([606, N, N]);
    expect(ms).toBeLessThan(BUDGET.many);
  });
  it("smartrecruiters: all known means 6 list requests and no detail request", async () => {
    const ids = Array.from({ length: N }, (_, i) => i);
    const { fetch, calls } = fake((c) => {
      const off = Number(new URL(c.url).searchParams.get("offset"));
      return reply({ totalFound: N, content: Array.from({ length: 100 }, (_, i) => ({ id: String(off + i) })) });
    });
    const { value } = await timed(() => fetchSmartRecruiters(GH, known("smartrecruiters:acme:", ids), fetch));
    expect([calls.length, value.seen.length, value.adverts.length]).toEqual([6, N, 0]);
  });
  it("workday: 30 list requests + 600 detail requests (measured 175 to 195 ms)", async () => {
    const { fetch, calls } = fake((c) => {
      if (c.method === "POST") {
        const off = (c.body as { offset: number }).offset;
        return reply({ total: N, jobPostings: Array.from({ length: 20 }, (_, i) => ({ externalPath: `/job/p${off + i}` })) });
      }
      return reply(wdDetail);
    });
    const { value, ms } = await timed(() => fetchWorkday(WD, none, fetch));
    expect([calls.length, value.seen.length, value.adverts.length]).toEqual([630, N, N]);
    expect(ms).toBeLessThan(BUDGET.many);
  });
  it("workday: all known means 30 list requests and no detail request", async () => {
    const { fetch, calls } = fake((c) => {
      const off = (c.body as { offset: number }).offset;
      return reply({ total: N, jobPostings: Array.from({ length: 20 }, (_, i) => ({ externalPath: `/job/p${off + i}` })) });
    });
    const { value } = await timed(() => fetchWorkday(WD, known("workday:acme:/job/p", Array.from({ length: N }, (_, i) => i)), fetch));
    expect([calls.length, value.seen.length, value.adverts.length]).toEqual([30, N, 0]);
  });
});
