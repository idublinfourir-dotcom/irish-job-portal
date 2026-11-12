// The fetch guard's real query, as app_fetcher on the test database (migration 0003 grants it select on fetch_run). Fake data only.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/fetch-guard-cli.ts";
import { createTestDb, testPassword, urlFor } from "./db";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
let db: Awaited<ReturnType<typeof createTestDb>>;
let src: number;
const NOW = new Date("2026-11-12T06:02:00Z");
// Fake `now` at 06:02 UTC; each case clears fetch_run first and inserts the rows it names.
const run = async (rows: { at: string; done?: boolean; error?: string }[]) => {
  await db.query("postgres", "delete from fetch_run");
  for (const r of rows)
    await db.query("postgres", "insert into fetch_run(job_source_id, started_at, finished_at, error) values ($1, $2, $3, $4)", [src, r.at, r.done === false ? null : r.at, r.error ?? null]);
  const out = join(mkdtempSync(join(tmpdir(), "guard-")), "out");
  const lines: string[] = [];
  const env = { FETCHER_DATABASE_URL: urlFor(db.name, "app_fetcher"), DATABASE_SSL: "disable", GITHUB_OUTPUT: out };
  const code = await main(env, (l) => lines.push(l), NOW);
  return { code, skipped: existsSync(out) && readFileSync(out, "utf8") === "skip=true\n", line: lines.join() };
};

beforeAll(async () => {
  db = await createTestDb();
  src = (await db.query("postgres", "insert into job_source(kind, board) values ('board','fakeboard') returning id")).rows[0].id;
});
afterAll(() => db.drop());

describe("fetch guard against the real fetch_run table", () => {
  it("no rows: fetch", async () => expect(await run([])).toMatchObject({ code: 0, skipped: false }));
  it("rows from yesterday only: fetch", async () => expect(await run([{ at: "2026-11-11T05:20:00Z" }])).toMatchObject({ code: 0, skipped: false }));
  it("a row today with an error: fetch", async () => expect(await run([{ at: "2026-11-12T05:20:00Z", error: "boom" }])).toMatchObject({ code: 0, skipped: false }));
  it("an unfinished row today: fetch", async () => expect(await run([{ at: "2026-11-12T05:20:00Z", done: false }])).toMatchObject({ code: 0, skipped: false }));
  it("a good row today: skip", async () => expect(await run([{ at: "2026-11-12T05:20:00Z" }])).toMatchObject({ code: 0, skipped: true }));
  it("one good row among bad ones: skip", async () =>
    expect(await run([{ at: "2026-11-12T05:20:00Z", error: "x" }, { at: "2026-11-12T05:21:00Z" }, { at: "2026-11-12T05:22:00Z", done: false }])).toMatchObject({ skipped: true }));
  it("UTC day boundary: 00:00:00 today counts, 23:59:59 yesterday does not", async () => {
    expect((await run([{ at: "2026-11-12T00:00:00Z" }])).skipped).toBe(true);
    expect((await run([{ at: "2026-11-11T23:59:59Z" }])).skipped).toBe(false);
  });
  it("without GITHUB_OUTPUT it still decides and prints one line", async () => {
    const lines: string[] = [];
    await db.query("postgres", "delete from fetch_run");
    expect(await main({ FETCHER_DATABASE_URL: urlFor(db.name, "app_fetcher"), DATABASE_SSL: "disable" }, (l) => lines.push(l), NOW)).toBe(0);
    expect(lines).toHaveLength(1);
  });
});

describe("fetch guard security", () => {
  it("the guard only reads: its code holds one select and no write statement", () => {
    const code = readFileSync(new URL("../src/fetch-guard-cli.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|drop|alter|truncate|grant)\b/i);
    expect(code.match(/client\.query\(/g)).toHaveLength(1);
  });
  it("a hostile connection string and a wrong password fail closed without printing the password", async () => {
    const lines: string[] = [];
    const url = urlFor(db.name, "app_fetcher").replace(`:${encodeURIComponent(testPassword())}@`, ":wrongpw-xyz@");
    expect(await main({ FETCHER_DATABASE_URL: url, DATABASE_SSL: "disable" }, (l) => lines.push(l), NOW)).toBe(1);
    expect(lines.join()).not.toMatch(/wrongpw-xyz/);
  });
  it("a role without select on fetch_run cannot decide, so the guard fails closed", async () => {
    const lines: string[] = [];
    // app_candidate has no grant on fetch_run
    expect(await main({ FETCHER_DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable" }, (l) => lines.push(l), NOW)).toBe(1);
    expect(lines.join()).toMatch(/not fetching/);
  });
});
