// Integration (D1-B, 20 Nov 2026): the five new boards through the real fetcher (atsTasks with the boards.json row shapes, the real adapters,
// makeCaller, runBoards and the real planAdvert) on the real test database as app_fetcher. Sites answer from the saved bodies; no network.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Fetch } from "@portal/sources";
import { page, sites } from "../../sources/src/careers/testkit";
import { createTestDb, type TestDb } from "../../db/test/db";
import { atsTasks, runBoards, type BoardsFile, type Db } from "../src";
import { counting, deps, fakeModel, NOW } from "./helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// The rows as boards.json writes them (packages/fetcher/data/boards.json)
const BOARDS: BoardsFile = {
  sitemap: [
    ["Rezoomo", "rezoomo", "https://www.rezoomo.com", "/sitemap.xml", "^https://www\\.rezoomo\\.com/job/(\\d+)/\\?", "url", { place: "url" }],
    ["HSE Dublin and North East", "hsedne", "https://careers-hsedne.icims.com", "/sitemap.xml", "^https://careers-hsedne\\.icims\\.com/jobs/(\\d+)/[^/]+/job$", "url", { query: "?in_iframe=1" }],
    ["Dawn Meats", "dawnmeats", "https://careers-dawnmeats.icims.com", "/sitemap.xml", "^https://careers-dawnmeats\\.icims\\.com/jobs/(\\d+)/[^/]+/job$", "url", { query: "?in_iframe=1" }],
  ],
  eightfold: [
    ["Microsoft", "microsoft", "https://apply.careers.microsoft.com", "microsoft.com"],
    ["Qualcomm", "qualcomm", "https://careers.qualcomm.com", "qualcomm.com"],
  ],
};

let db: TestDb;
let day = 0;
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p).then((r) => r.rows);
beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());

async function run(over: (url: string, method: string) => Response | undefined = () => undefined, pool: Db = db.pool("app_fetcher")) {
  const calls: string[] = [];
  const answer = sites(over);
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    return answer({ url: String(input), method: init?.method ?? "GET" });
  }) as Fetch;
  const tasks = atsTasks(BOARDS, fetch, () => {}, async () => {}).map((t) => ({ ...t, rereadDays: undefined }));
  const reports = await runBoards(deps(pool, tasks, { checkBatch: fakeModel().checkBatch, now: () => new Date(NOW.getTime() + ++day * 86_400_000) }));
  return { calls, by: Object.fromEntries(reports.map((r) => [r.board, r])) };
}
const saved = async (board: string) =>
  (await su("select f.external_id, j.status from fetched_advert f join job_source s on s.id = f.job_source_id left join job j on j.fetched_advert_id = f.id where s.board = $1 order by 1", [board])).map((r) => `${r.external_id} ${r.status ?? "-"}`);

describe("D1-B boards on the real database", () => {
  it("day 1: Republic Rezoomo jobs, Irish iCIMS jobs and all 20 Eightfold jobs are saved; the Rezoomo salary reaches the job", async () => {
    const c = counting(db.pool("app_fetcher"));
    const { by } = await run(undefined, c.db);
    expect(Object.fromEntries(Object.entries(by).map(([b, r]) => [b, [r.ok, r.seen]]))).toEqual({ rezoomo: [true, 3], hsedne: [true, 16], dawnmeats: [true, 18], microsoft: [true, 10], qualcomm: [true, 10] });
    expect(await saved("rezoomo")).toEqual(["sitemap:rezoomo:100118 live", "sitemap:rezoomo:105422 live", "sitemap:rezoomo:68522 -"]); // 100118: Bray (G1); 68522: no contract, so doubt and no job (#298)
    expect((await saved("hsedne")).map((x) => x.split(" ")[0])).toEqual(["sitemap:hsedne:5359"]);
    expect(await saved("microsoft")).toHaveLength(10);
    const [j] = await su("select j.title, j.employer_name, j.county, j.salary_low, j.salary_high from job j join fetched_advert f on f.id = j.fetched_advert_id where f.external_id = 'sitemap:rezoomo:105422'");
    expect(j).toMatchObject({ employer_name: "HSE Dublin and North East", county: "Dublin", salary_low: 38908, salary_high: 56948 });
    const [m] = await su("select j.county, j.status from job j join fetched_advert f on f.id = j.fetched_advert_id where f.external_id = 'eightfold:microsoft:200061754'");
    expect(m).toEqual({ county: "Dublin", status: "live" });
    // Qualcomm states no salary and is not on the big-company list, so the rules reject all its jobs (a Leftover in the report)
    expect((await su("select distinct result from fetched_advert where external_id like 'eightfold:qualcomm:%'")).map((r) => r.result)).toEqual(["rejected"]);
    expect(await su("select 1 from fetched_advert where external_id = 'sitemap:rezoomo:105268'")).toEqual([]); // Craigavon: never read, never saved
  });

  it("day 2: saved jobs cost no page or detail call (iCIMS pages with no saved body are shells: seen, never saved, so read again)", async () => {
    const { calls, by } = await run();
    expect(Object.values(by).every((r) => r.ok && r.passed === 0 && r.changed === 0)).toBe(true);
    expect(calls.filter((u) => u.includes("rezoomo.com/job/") || u.includes("/jobs/5359/") || u.includes("/jobs/5124/") || u.includes("position_details"))).toEqual([]);
    expect(calls.filter((u) => u.endsWith("/sitemap.xml") || u.includes("/api/pcsx/search"))).toHaveLength(5);
    expect(calls).toHaveLength(5 + 15 + 17); // plus the HSE and Dawn Meats shells
  });

  it("a Rezoomo job gone from a sitemap that worked is closed; a 429 then 200 on Microsoft still works; a failed sitemap closes nothing", async () => {
    let n = 0;
    const { by } = await run((url) => {
      if (url === "https://www.rezoomo.com/sitemap.xml") return page(`<urlset><url><loc><![CDATA[https://www.rezoomo.com/job/68522/?Nurse%20%2D%20Limerick]]></loc></url></urlset>`);
      if (url.includes("apply.careers.microsoft.com/api/pcsx/search") && n++ === 0) return page("Please try again later", 429, { "retry-after": "1" });
      if (url.startsWith("https://careers-dawnmeats.icims.com/sitemap.xml")) return page("down", 503);
      return undefined;
    });
    expect(by.rezoomo).toMatchObject({ ok: true, seen: 1, closed: 2 }); // 105422 and 100118 (Bray) were live
    expect(await saved("rezoomo")).toContain("sitemap:rezoomo:105422 closed");
    expect(by.microsoft).toMatchObject({ ok: true, seen: 10, closed: 0 });
    expect(by.dawnmeats).toMatchObject({ ok: false, closed: 0 });
    expect((await saved("dawnmeats")).every((x) => x.endsWith(" live") || x.endsWith(" in_review") || x.endsWith(" -"))).toBe(true);
  });

  it("gap round G2: a capped Rezoomo row saves maxPages jobs a run and the rest on the next run", async () => {
    const row = BOARDS.sitemap![0]!;
    const capped: BoardsFile = { sitemap: [[row[0], "rezoomo-cap", row[2], row[3], row[4], row[5], { place: "url", maxPages: 1 }]] };
    const once = async () => {
      const tasks = atsTasks(capped, (async (input: string | URL | Request) => sites()({ url: String(input), method: "GET" })) as Fetch, () => {}, async () => {}).map((t) => ({ ...t, rereadDays: undefined }));
      const [r] = await runBoards(deps(db.pool("app_fetcher"), tasks, { checkBatch: fakeModel().checkBatch, now: () => new Date(NOW.getTime() + ++day * 86_400_000) }));
      return r!;
    };
    expect(await once()).toMatchObject({ ok: true, seen: 3, closed: 0 });
    expect(await saved("rezoomo-cap")).toHaveLength(1);
    expect(await once()).toMatchObject({ ok: true, seen: 3, closed: 0 });
    expect(await saved("rezoomo-cap")).toHaveLength(2);
    await once();
    expect((await saved("rezoomo-cap")).map((x) => x.split(" ")[0])).toEqual(["sitemap:rezoomo-cap:100118", "sitemap:rezoomo-cap:105422", "sitemap:rezoomo-cap:68522"]);
  });
});
