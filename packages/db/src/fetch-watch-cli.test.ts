// No database, no network: the watch's decision with a fake database and a fake gh. The real query is packages/db/test/fetch-watch.test.ts.
import { describe, expect, it } from "vitest";
import { FAILED_BOARDS_TODAY, main, watch } from "./fetch-watch-cli.ts";

const NOW = new Date("2026-11-13T12:11:00Z");
// `good`: rows the guard's question finds; `failed`: boards whose last try today failed.
const fakeDb = (good: number, failed = 0) => ({ query: async (sql: string) => (sql === FAILED_BOARDS_TODAY ? { rows: [{ n: failed }] } : { rowCount: good }) }) as never;
const fakeGh = (statuses: string[]) => {
  const calls: string[][] = [];
  const gh = async (args: string[]) => (calls.push(args), args[0] === "run" ? JSON.stringify(statuses.map((status) => ({ status }))) : "");
  return { gh, calls };
};
const go = async (rows: number, statuses: string[], failed = 0) => {
  const lines: string[] = [];
  const g = fakeGh(statuses);
  return { code: await watch(fakeDb(rows, failed), (l) => lines.push(l), NOW, g.gh), lines, calls: g.calls };
};

describe("fetch watch decision", () => {
  it("a fetch worked and no board failed: green, one line, gh never called", async () => {
    const r = await go(1, []);
    expect(r).toMatchObject({ code: 0, lines: ["a fetch worked today (UTC)"], calls: [] });
  });
  // 14 Nov 2026: Workday's maintenance failed 13 boards at 12:09 UTC and nothing tried them again that day.
  it("a fetch worked but boards failed: starts one unguarded retry and stays green (a known maintenance window is no alarm)", async () => {
    const r = await go(1, ["completed"], 13);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(["a fetch worked today (UTC) but 13 boards failed; started a retry"]);
    expect(r.calls.at(-1)).toEqual(["workflow", "run", "daily-fetch.yml", "-f", "guarded=false"]);
    expect(r.calls.filter((c) => c[0] === "workflow")).toHaveLength(1);
  });
  it("boards failed but a fetch is already queued or running: starts nothing, green", async () => {
    const r = await go(1, ["in_progress"], 2);
    expect(r).toMatchObject({ code: 0, lines: ["a fetch worked today (UTC) but 2 boards failed; one is already running"] });
    expect(r.calls).toHaveLength(1);
  });
  it("none worked and nothing running: starts a guarded run and goes red", async () => {
    const r = await go(0, ["completed", "completed"]);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(["no fetch worked today by 12:11 UTC; started one"]);
    expect(r.calls.at(-1)).toEqual(["workflow", "run", "daily-fetch.yml", "-f", "guarded=true"]);
  });
  // 24 Nov 2026: the 17:41 slot of 23 Nov started at 03:28 UTC, judged the new day and went red although 23 Nov's fetch had worked.
  it.each([
    ["2026-11-24T03:28:00Z", "2026-11-23T00:00:00Z", "yesterday"],
    ["2026-11-24T11:59:59Z", "2026-11-23T00:00:00Z", "yesterday"],
    ["2026-11-24T12:00:00Z", "2026-11-24T00:00:00Z", "today"],
    ["2026-11-24T23:59:59Z", "2026-11-24T00:00:00Z", "today"],
    ["2026-12-01T02:00:00Z", "2026-11-30T00:00:00Z", "yesterday"],
  ])("a slot started at %s judges the day from %s", async (now, day, word) => {
    const days: Date[] = [], lines: string[] = [];
    const db = { query: async (sql: string, args: [Date]) => (days.push(args[0]), sql === FAILED_BOARDS_TODAY ? { rows: [{ n: 0 }] } : { rowCount: 1 }) } as never;
    expect(await watch(db, (l) => lines.push(l), new Date(now), fakeGh([]).gh)).toBe(0);
    expect(days).toEqual([new Date(day), new Date(day)]);
    expect(lines).toEqual([`a fetch worked ${word} (UTC)`]);
  });
  it.each(["queued", "in_progress", "waiting", "pending", "requested"])("none worked and one is %s: starts nothing, goes red", async (st) => {
    const r = await go(0, ["completed", st]);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(["no fetch worked today by 12:11 UTC; one is already running"]);
    expect(r.calls).toHaveLength(1);
  });
  it("a gh failure or garbage from gh is red and starts nothing", async () => {
    const lines: string[] = [];
    expect(await watch(fakeDb(0), (l) => lines.push(l), NOW, async () => "<html>not json").catch(() => "threw")).toBe("threw");
    const started: string[][] = [];
    const bad = async (a: string[]) => (a[0] === "run" ? "{}" : (started.push(a), ""));
    expect(await watch(fakeDb(0), () => {}, NOW, bad).catch(() => "threw")).toBe("threw");
    expect(started).toEqual([]);
  });
  it("on the retry path too, garbage from gh throws (main makes it red) and starts nothing", async () => {
    const started: string[][] = [];
    const bad = async (a: string[]) => (a[0] === "run" ? "<html>not json" : (started.push(a), ""));
    expect(await watch(fakeDb(1, 5), () => {}, NOW, bad).catch(() => "threw")).toBe("threw");
    expect(started).toEqual([]);
  });
  it("a garbage count from the database never starts a run on its own", async () => {
    const g = fakeGh([]);
    for (const n of [0, null, undefined]) {
      const db = { query: async (sql: string) => (sql === FAILED_BOARDS_TODAY ? { rows: [{ n }] } : { rowCount: 1 }) } as never;
      expect(await watch(db, () => {}, NOW, g.gh)).toBe(0);
    }
    expect(g.calls).toEqual([]);
  });
});

describe("fetch watch with skipped kinds (W1b)", () => {
  it("passes the skipped kinds to both questions as a parameter", async () => {
    const seen: unknown[][] = [];
    const db = { query: async (sql: string, values: unknown[]) => (seen.push(values), sql === FAILED_BOARDS_TODAY ? { rows: [{ n: 0 }] } : { rowCount: 1 }) } as never;
    expect(await watch(db, () => {}, NOW, fakeGh([]).gh, ["workday"])).toBe(0);
    expect(seen).toEqual([[new Date("2026-11-13T00:00:00Z"), ["workday"]], [new Date("2026-11-13T00:00:00Z"), ["workday"]]]);
    expect(FAILED_BOARDS_TODAY).toMatch(/kind = any\(\$2::text\[\]\)/);
  });
  it("with no skip it passes an empty list (every kind counts, as before)", async () => {
    const seen: unknown[][] = [];
    const db = { query: async (_s: string, values: unknown[]) => (seen.push(values), { rowCount: 1, rows: [{ n: 0 }] }) } as never;
    await watch(db, () => {}, NOW, fakeGh([]).gh);
    expect(seen[0]![1]).toEqual([]);
  });
  it("a bad FETCHER_SKIP_KINDS is exit 2 before it connects or calls gh", async () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    expect(await main({ FETCHER_DATABASE_URL: "postgres://x@127.0.0.1:1/x", FETCHER_SKIP_KINDS: "x;y" }, (l) => lines.push(l), NOW, async (a) => (calls.push(a), "[]"))).toBe(2);
    expect(lines).toEqual(["FETCHER_SKIP_KINDS must be a comma list of board kinds"]);
    expect(calls).toEqual([]);
  });
});

describe("fetch watch main, failure paths", () => {
  it("exit 2 without the login", async () => {
    const lines: string[] = [];
    expect(await main({}, (l) => lines.push(l))).toBe(2);
    expect(lines.join()).toMatch(/FETCHER_DATABASE_URL is not set/);
  });
  it("red, and never prints the connection string, when the database or gh fails", async () => {
    const lines: string[] = [];
    const url = "postgres://app_fetcher:hunter2secret@127.0.0.1:1/postgres";
    expect(await main({ FETCHER_DATABASE_URL: url, DATABASE_SSL: "disable" }, (l) => lines.push(l), NOW, async () => "[]")).toBe(1);
    expect(lines.join()).toMatch(/could not finish/);
    expect(lines.join()).not.toMatch(/hunter2secret|127\.0\.0\.1|app_fetcher/);
  });
});
