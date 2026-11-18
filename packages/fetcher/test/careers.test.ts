// Integration (W1c): the real fetcher (atsTasks, the three career-site adapters, makeCaller, runBoards) against the real test database as
// app_fetcher. The sites are the saved bodies of packages/sources/src/careers/fixtures through a fake fetch; no network, no real waiting.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { page } from "../../sources/src/careers/testkit";
import { createTestDb, type TestDb } from "../../db/test/db";
import { careerRun, counting } from "./helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb;
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p).then((r) => r.rows);
beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());

const saved = async (kind: string, board: string) =>
  (await su("select f.external_id, j.status from fetched_advert f join job_source s on s.id = f.job_source_id left join job j on j.fetched_advert_id = f.id where s.kind = $1 and s.board = $2 order by 1", [kind, board])).map((r) => `${r.external_id} ${r.status}`);
const pageCalls = (calls: string[], host: string) => calls.filter((c) => c.startsWith(`GET https://${host}/`) && !c.endsWith("/sitemap.xml"));

describe("the career-site kinds on the real database (W1c)", () => {
  it("day 1: every Irish job is saved, under its requisition id, inside the first cut's budget (4 statements a board, at most 9 a new job)", async () => {
    const c = counting(db.pool("app_fetcher"));
    const { reports } = await careerRun(db, undefined, c.db);
    expect(c.sql.length).toBeLessThanOrEqual(5 * 4 + 9 * 9);
    expect(reports.map((r) => [r.kind, r.board, r.ok, r.seen, r.passed])).toEqual([
      ["salesforce", "salesforce", true, 2, 2], ["phenom", "mastercard", true, 1, 1], ["phenom", "thermofisher", true, 2, 2], ["sitemap", "citi", true, 2, 2], ["sitemap", "fmr", true, 2, 2],
    ]);
    expect(await saved("phenom", "thermofisher")).toEqual(["phenom:thermofisher:R-01367934 live", "phenom:thermofisher:R-01369062 live"]);
    expect(await saved("sitemap", "citi")).toEqual(["sitemap:citi:261007029 live", "sitemap:citi:261007676 live"]);
    expect(await saved("salesforce", "salesforce")).toEqual(["salesforce:salesforce:JR317362 live", "salesforce:salesforce:JR327834 live"]);
  });

  it("day 2: known ids cost no page call (Citi still reads its two pages: its URL has no Workday id); 4 statements a board", async () => {
    const c = counting(db.pool("app_fetcher"));
    const { reports, calls } = await careerRun(db, undefined, c.db);
    expect(reports.every((r) => r.ok && r.passed === 0 && r.changed === 0)).toBe(true);
    for (const host of ["careers.mastercard.com", "jobs.thermofisher.com", "jobs.fidelity.com"]) expect(pageCalls(calls, host), host).toEqual([]);
    expect(pageCalls(calls, "jobs.citi.com")).toHaveLength(2);
    expect(calls.filter((x) => x.includes("sfdcstatic"))).toHaveLength(1);
    expect(c.sql).toHaveLength(5 * 4); // the first cut's budget: nothing changed costs 4 statements a board
  });

  it("a job gone from a listing that worked is closed", async () => {
    const without = (await import("node:fs")).readFileSync(new URL("../../sources/src/careers/fixtures/fidelity-sitemap.xml", import.meta.url), "utf8").replace(/<url>\s*<loc>[^<]*2136258[^<]*<\/loc>[\s\S]*?<\/url>/, "");
    const { by } = await careerRun(db, (url) => (url === "https://jobs.fidelity.com/sitemap.xml" ? page(without) : undefined));
    expect(by.fmr).toMatchObject({ ok: true, seen: 1, closed: 1 });
    expect(await saved("sitemap", "fmr")).toEqual(["sitemap:fmr:2136258 closed", "sitemap:fmr:2136526 live"]);
  });

  it("a listing that failed closes nothing and records the error", async () => {
    const { by } = await careerRun(db, (url, method) => (method === "POST" && url.startsWith("https://careers.mastercard.com/") ? page("<html>maintenance</html>", 503) : undefined));
    expect(by.mastercard).toMatchObject({ ok: false, closed: 0 });
    expect(by.thermofisher).toMatchObject({ ok: true, closed: 0 });
    expect(await saved("phenom", "mastercard")).toEqual(["phenom:mastercard:R-291229 live"]);
    const [run] = await su("select f.error from fetch_run f join job_source s on s.id = f.job_source_id where s.board = 'mastercard' order by f.id desc limit 1");
    expect(run.error).toMatch(/^HTTP 503 after 3 tries/);
  });
});
