// The fetch watch's real query, as app_fetcher on the test database, with a fake gh (nothing here reaches GitHub). Fake data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/fetch-watch-cli.ts";
import { createTestDb, testPassword, urlFor } from "./db";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
let db: Awaited<ReturnType<typeof createTestDb>>;
let src: number;
let src2: number;
const NOW = new Date("2026-11-13T18:41:00Z");
// Rows go in the order given (ids rise with it); `two` puts the row on the second board.
const go = async (rows: { at: string; done?: boolean; error?: string; two?: boolean }[], statuses: string[] = [], role = "app_fetcher") => {
  await db.query("postgres", "delete from fetch_run");
  for (const r of rows)
    await db.query("postgres", "insert into fetch_run(job_source_id, started_at, finished_at, error) values ($1, $2, $3, $4)", [r.two ? src2 : src, r.at, r.done === false ? null : r.at, r.error ?? null]);
  const calls: string[][] = [];
  const gh = async (a: string[]) => (calls.push(a), a[0] === "run" ? JSON.stringify(statuses.map((status) => ({ status }))) : "");
  const lines: string[] = [];
  const code = await main({ FETCHER_DATABASE_URL: urlFor(db.name, role), DATABASE_SSL: "disable" }, (l) => lines.push(l), NOW, gh);
  return { code, line: lines.join(), calls };
};

beforeAll(async () => {
  db = await createTestDb();
  src = (await db.query("postgres", "insert into job_source(kind, board) values ('board','fakeboard') returning id")).rows[0].id;
  src2 = (await db.query("postgres", "insert into job_source(kind, board) values ('board','fakeboard2') returning id")).rows[0].id;
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
  // 14 Nov 2026: one board worked, 13 Workday boards failed (maintenance), and nothing tried them again.
  it("a good run but a board's last try today failed: one unguarded retry, green", async () => {
    const r = await go([{ at: "2026-11-13T12:09:00Z" }, { at: "2026-11-13T12:09:05Z", error: "HTTP 303 redirect not followed", two: true }], ["completed"]);
    expect(r).toMatchObject({ code: 0, line: "a fetch worked today (UTC) but 1 board failed; started a retry" });
    expect(r.calls.at(-1)).toEqual(["workflow", "run", "daily-fetch.yml", "-f", "guarded=false"]);
  });
  it("a board that failed and then worked later today is not retried", async () => {
    const r = await go([{ at: "2026-11-13T12:09:00Z", error: "boom" }, { at: "2026-11-13T12:09:01Z", two: true }, { at: "2026-11-13T13:03:00Z" }]);
    expect(r).toMatchObject({ code: 0, line: "a fetch worked today (UTC)", calls: [] });
  });
  it("a board that worked and then failed later today is retried (its last try counts)", async () => {
    const r = await go([{ at: "2026-11-13T12:09:00Z" }, { at: "2026-11-13T13:03:00Z", error: "boom" }]);
    expect(r.line).toBe("a fetch worked today (UTC) but 1 board failed; started a retry");
  });
  it("failures from yesterday and an unfinished try today do not start a retry", async () => {
    const r = await go([{ at: "2026-11-12T12:09:00Z", error: "boom", two: true }, { at: "2026-11-13T12:09:00Z" }, { at: "2026-11-13T18:40:00Z", done: false, two: true }]);
    expect(r).toMatchObject({ code: 0, calls: [] });
  });
  it("two failed boards are counted once each, however many tries", async () => {
    const r = await go([{ at: "2026-11-13T05:00:00Z" }, { at: "2026-11-13T12:09:00Z", error: "a" }, { at: "2026-11-13T12:09:00Z", error: "b", two: true }, { at: "2026-11-13T13:03:00Z", error: "c", two: true }]);
    expect(r.line).toBe("a fetch worked today (UTC) but 2 boards failed; started a retry");
  });
  it("boards failed but a fetch is running: nothing started, green", async () => {
    const r = await go([{ at: "2026-11-13T12:09:00Z" }, { at: "2026-11-13T12:09:05Z", error: "x", two: true }], ["queued"]);
    expect(r).toMatchObject({ code: 0, line: "a fetch worked today (UTC) but 1 board failed; one is already running" });
    expect(r.calls).toHaveLength(1);
  });
  it("performance: a good day is two statements and no gh call, within a loose time limit", async () => {
    const t0 = Date.now();
    await go([{ at: "2026-11-13T05:20:00Z" }]);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

describe("fetch watch security", () => {
  it("the watch only reads: its code holds no write statement, and the only runs it starts are the two fixed commands", () => {
    const code = readFileSync(new URL("../src/fetch-watch-cli.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|drop|alter|truncate|grant)\b/i);
    expect([...code.matchAll(/gh\(\[([^\]]*)\]\)/g)].map((m) => m[1])).toEqual([
      `"run", "list", "--workflow", WORKFLOW, "--limit", "20", "--json", "status"`,
      `"workflow", "run", WORKFLOW, "-f", "guarded=false"`,
      `"workflow", "run", WORKFLOW, "-f", "guarded=true"`,
    ]);
  });
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
