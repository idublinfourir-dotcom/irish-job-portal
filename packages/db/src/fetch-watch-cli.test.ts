// No database, no network: the watch's decision with a fake database and a fake gh. The real query is packages/db/test/fetch-watch.test.ts.
import { describe, expect, it } from "vitest";
import { main, watch } from "./fetch-watch-cli.ts";

const NOW = new Date("2026-11-13T12:11:00Z");
const fakeDb = (rows: number) => ({ query: async () => ({ rowCount: rows }) }) as never;
const fakeGh = (statuses: string[]) => {
  const calls: string[][] = [];
  const gh = async (args: string[]) => (calls.push(args), args[0] === "run" ? JSON.stringify(statuses.map((status) => ({ status }))) : "");
  return { gh, calls };
};
const go = async (rows: number, statuses: string[]) => {
  const lines: string[] = [];
  const g = fakeGh(statuses);
  return { code: await watch(fakeDb(rows), (l) => lines.push(l), NOW, g.gh), lines, calls: g.calls };
};

describe("fetch watch decision", () => {
  it("a fetch worked: green, one line, gh never called", async () => {
    const r = await go(1, []);
    expect(r).toMatchObject({ code: 0, lines: ["a fetch worked today (UTC)"], calls: [] });
  });
  it("none worked and nothing running: starts a guarded run and goes red", async () => {
    const r = await go(0, ["completed", "completed"]);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(["no fetch worked today by 12:11 UTC; started one"]);
    expect(r.calls.at(-1)).toEqual(["workflow", "run", "daily-fetch.yml", "-f", "guarded=true"]);
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
