// Integration (W1): the real fetcher (atsTasks, the real adapters and makeCaller, runBoards) against the real test database as app_fetcher,
// with fake boards: a Workday board that answers 429 twice then 200, one that always answers 429, and a Greenhouse board that is fine.
// No network (fake fetch), no real waiting (the sleep only records).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Fetch } from "@portal/sources";
import { createTestDb, type TestDb } from "../../db/test/db";
import { atsTasks, kindFilter, runBoards, runFailure } from "../src";
import { deps, plan } from "./helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb;
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p).then((r) => r.rows);
beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());

const BOARDS = { workday: [["Flaky Fake Ltd", "wflaky", "wd3", "External"], ["Down Fake Ltd", "wdown", "wd3", "External"]] as [string, string, string, string][], greenhouse: [["ghfine", "Fine Fake Ltd"]] as [string, string][] };
const LIMITED = { "retry-after": "2", "cf-ray": "8e1f2a3b4c5d6e7f-DUB", "cf-mitigated": "challenge", server: "cloudflare" };
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers });
/** Every board's one Irish posting. `refuse(tenant, n)`: answer 429 to that tenant's n-th call (1, 2, ...). */
function server(refuse: (tenant: string, n: number) => boolean) {
  const n = new Map<string, number>();
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://boards-api.greenhouse.io/")) return json({ jobs: [{ id: 1, title: "Engineer", location: { name: "Dublin, Ireland" }, content: "Work.", absolute_url: "https://example.test/gh/1" }] });
    const tenant = /^https:\/\/([a-z]+)\.wd3\.myworkdayjobs\.com\//.exec(url)?.[1];
    if (!tenant) throw new Error(`unexpected host ${url}`);
    const k = (n.get(tenant) ?? 0) + 1;
    n.set(tenant, k);
    if (refuse(tenant, k)) return new Response("<html>Error 1015 You are being rate limited</html>", { status: 429, headers: LIMITED });
    if (init?.method === "POST") return json({ total: 1, jobPostings: [{ externalPath: "/job/1", locationsText: "Ireland - Dublin" }] });
    return json({ jobPostingInfo: { title: "Engineer", location: "Ireland - Dublin", jobDescription: "<p>Work.</p>", externalUrl: `https://example.test/${tenant}/1` } });
  }) as Fetch;
  return fetch;
}
/** `only`: FETCHER_ONLY_KINDS, as main.ts applies it. */
async function run(fetch: Fetch, only?: string) {
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  const keep = kindFilter(only);
  const tasks = atsTasks(BOARDS, fetch, () => {}, sleep).filter((t) => keep(t.kind));
  const reports = await runBoards(deps(db.pool("app_fetcher"), tasks, { sleep }), (x) => plan(x, "passed"));
  return { reports, waits };
}
const lastRun = async (board: string) => (await su("select f.error from fetch_run f join job_source s on s.id = f.job_source_id where s.board = $1 order by f.id desc limit 1", [board]))[0];
const openJobs = async (board: string) =>
  Number((await su("select count(*) from job j join fetched_advert a on a.id = j.fetched_advert_id join job_source s on s.id = a.job_source_id where s.board = $1 and j.status = 'live' and a.gone_at is null", [board]))[0].count);

describe("Workday 429 on the real database (W1)", () => {
  it("day 1: every board works and saves its job", async () => {
    const { reports } = await run(server(() => false));
    expect(reports.map((r) => [r.board, r.ok, r.passed])).toEqual([["ghfine", true, 1], ["wflaky", true, 1], ["wdown", true, 1]]);
    for (const b of ["ghfine", "wflaky", "wdown"]) expect(await openJobs(b)).toBe(1);
  });

  it("day 2: 429 twice then 200 succeeds; always 429 fails, closes nothing and logs what Workday said; the run stays green", async () => {
    const fetch = server((t, k) => (t === "wflaky" ? k <= 2 : t === "wdown"));
    const { reports, waits } = await run(fetch);
    const by = Object.fromEntries(reports.map((r) => [r.board, r]));
    expect(by.ghfine).toMatchObject({ ok: true });
    expect(by.wflaky).toMatchObject({ ok: true, error: null });
    expect(by.wdown).toMatchObject({ ok: false, closed: 0 });
    // the down board's job is still live: a failed board closes nothing
    for (const b of ["ghfine", "wflaky", "wdown"]) expect(await openJobs(b)).toBe(1);
    const { error } = await lastRun("wdown");
    expect(error).toMatch(/^HTTP 429 after 3 tries \(retry-after 2; cf-ray 8e1f2a3b4c5d6e7f-DUB; cf-mitigated challenge; server cloudflare\): <html>Error 1015 You are being rate limited/);
    expect((await lastRun("wflaky")).error).toBeNull();
    expect(waits).toContain(2_000); // Retry-After was honoured
    expect(runFailure(reports)).toBeNull(); // one Workday board still works and 1 of 3 is not more than half
  });

  it("day 3: both Workday boards refused: the run's verdict is red, the Greenhouse job is still saved", async () => {
    const { reports } = await run(server((t) => t !== "ghfine"));
    expect(reports.find((r) => r.board === "ghfine")).toMatchObject({ ok: true });
    expect(runFailure(reports)).toBe("every workday board failed (2 of 3 boards failed)");
    expect(await openJobs("ghfine")).toBe(1);
    expect(await openJobs("wdown")).toBe(1);
    expect(Number((await su("select count(*) from fetch_run where error like 'HTTP 429 after 3 tries%'"))[0].count)).toBe(3);
  });

  // W1b: the laptop's run (workday-fetch.yml) has FETCHER_ONLY_KINDS=workday.
  it("day 4: a Workday-only run touches only Workday sources and closes nothing on other boards", async () => {
    const before = await su("select s.board, count(f.id)::int as runs from job_source s left join fetch_run f on f.job_source_id = s.id group by s.board order by s.board");
    const empty = server(() => false);
    const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith("https://boards-api.greenhouse.io/") ? json({ jobs: [] }) : empty(input, init)) as Fetch;
    const { reports } = await run(fetch, "workday");
    expect(reports.map((r) => [r.kind, r.board, r.ok])).toEqual([["workday", "wflaky", true], ["workday", "wdown", true]]);
    const after = await su("select s.board, count(f.id)::int as runs from job_source s left join fetch_run f on f.job_source_id = s.id group by s.board order by s.board");
    const runs = (rows: { board: string; runs: number }[]) => Object.fromEntries(rows.map((r) => [r.board, r.runs]));
    expect(runs(after).ghfine).toBe(runs(before).ghfine);
    expect(runs(after).wflaky).toBe(runs(before).wflaky! + 1);
    expect(await openJobs("ghfine")).toBe(1); // the Greenhouse board was not read at all: no run row, its job still live
    expect(runFailure(reports)).toBeNull();
  });

  it("day 5: a Workday-only run where every Workday board is challenged ends red, so the engineer hears of it", async () => {
    const { reports } = await run(server(() => true), "workday");
    expect(reports.every((r) => r.kind === "workday" && !r.ok)).toBe(true);
    expect(runFailure(reports)).toBe("every workday board failed (2 of 2 boards failed)");
  });
});
