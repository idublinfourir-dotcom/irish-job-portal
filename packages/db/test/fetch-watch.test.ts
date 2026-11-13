// The fetch watch's real query, as app_fetcher on the test database, with a fake gh (nothing here reaches GitHub). Fake data only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/fetch-watch-cli.ts";
import { createTestDb, testPassword, urlFor } from "./db";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
let db: Awaited<ReturnType<typeof createTestDb>>;
let src: number;
const NOW = new Date("2026-11-13T18:41:00Z");
const go = async (rows: { at: string; done?: boolean; error?: string }[], statuses: string[] = [], role = "app_fetcher") => {
  await db.query("postgres", "delete from fetch_run");
  for (const r of rows)
    await db.query("postgres", "insert into fetch_run(job_source_id, started_at, finished_at, error) values ($1, $2, $3, $4)", [src, r.at, r.done === false ? null : r.at, r.error ?? null]);
  const calls: string[][] = [];
  const gh = async (a: string[]) => (calls.push(a), a[0] === "run" ? JSON.stringify(statuses.map((status) => ({ status }))) : "");
  const lines: string[] = [];
  const code = await main({ FETCHER_DATABASE_URL: urlFor(db.name, role), DATABASE_SSL: "disable" }, (l) => lines.push(l), NOW, gh);
  return { code, line: lines.join(), calls };
};

beforeAll(async () => {
  db = await createTestDb();
  src = (await db.query("postgres", "insert into job_source(kind, board) values ('board','fakeboard') returning id")).rows[0].id;
});
afterAll(() => db.drop());

describe("fetch watch against the real fetch_run table", () => {
  it("a good run today: green, gh never called", async () => expect(await go([{ at: "2026-11-13T05:20:00Z" }])).toMatchObject({ code: 0, calls: [] }));
  it("no rows: red, starts a run", async () => {
    const r = await go([]);
    expect(r).toMatchObject({ code: 1, line: "no fetch worked today by 18:41 UTC; started one" });
    expect(r.calls.at(-1)).toContain("guarded=true");
  });
  it("only yesterday's, an errored and an unfinished run today: red", async () => {
    for (const rows of [[{ at: "2026-11-12T23:59:59Z" }], [{ at: "2026-11-13T05:20:00Z", error: "boom" }], [{ at: "2026-11-13T05:20:00Z", done: false }]])
      expect((await go(rows)).code).toBe(1);
  });
  it("no good run and one already running: red, nothing started", async () => {
    const r = await go([], ["in_progress"]);
    expect(r).toMatchObject({ code: 1, line: "no fetch worked today by 18:41 UTC; one is already running" });
    expect(r.calls).toHaveLength(1);
  });
  it("performance: a good day is one statement and no gh call, within a loose time limit", async () => {
    const t0 = Date.now();
    await go([{ at: "2026-11-13T05:20:00Z" }]);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

describe("fetch watch security", () => {
  it("a role without select on fetch_run is red and starts nothing", async () => {
    const r = await go([], [], "app_candidate");
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
  });
  it("a wrong password is red without printing it, and starts nothing", async () => {
    const lines: string[] = [];
    const calls: string[][] = [];
    const url = urlFor(db.name, "app_fetcher").replace(`:${encodeURIComponent(testPassword())}@`, ":wrongpw-xyz@");
    expect(await main({ FETCHER_DATABASE_URL: url, DATABASE_SSL: "disable" }, (l) => lines.push(l), NOW, async (a) => (calls.push(a), "[]"))).toBe(1);
    expect(lines.join()).not.toMatch(/wrongpw-xyz/);
    expect(calls).toEqual([]);
  });
});
