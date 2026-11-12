// No database: the guard's decision, the UTC day boundary, and its failure paths. The query itself is packages/db/test/fetch-guard.test.ts.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide, main, utcDayStart } from "./fetch-guard-cli.ts";

describe("fetch guard decision", () => {
  it("skips only when at least one good run started today", () => {
    expect(decide(0)).toBe("fetch");
    expect(decide(1)).toBe("skip");
    expect(decide(40)).toBe("skip");
  });
  it("the day starts at 00:00:00.000 UTC, whatever the clock's own zone", () => {
    expect(utcDayStart(new Date("2026-11-12T06:02:00Z")).toISOString()).toBe("2026-11-12T00:00:00.000Z");
    expect(utcDayStart(new Date("2026-11-12T00:00:00.000Z")).toISOString()).toBe("2026-11-12T00:00:00.000Z");
    expect(utcDayStart(new Date("2026-11-11T23:59:59.999Z")).toISOString()).toBe("2026-11-11T00:00:00.000Z");
    expect(utcDayStart(new Date("2026-12-31T23:59:59.999Z")).toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });
});

describe("fetch guard main, failure paths", () => {
  it("refuses with exit 2 when FETCHER_DATABASE_URL is missing", async () => {
    const lines: string[] = [];
    expect(await main({}, (l) => lines.push(l))).toBe(2);
    expect(lines.join()).toMatch(/FETCHER_DATABASE_URL is not set/);
  });
  it("fails closed (exit 1, no skip output) and never prints the connection string when the database is unreachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-"));
    const out = join(dir, "out");
    const lines: string[] = [];
    const url = "postgres://app_fetcher:hunter2secret@127.0.0.1:1/postgres";
    expect(await main({ FETCHER_DATABASE_URL: url, DATABASE_SSL: "disable", GITHUB_OUTPUT: out }, (l) => lines.push(l))).toBe(1);
    expect(lines.join()).toMatch(/could not tell.*not fetching/);
    expect(lines.join()).not.toMatch(/hunter2secret|127\.0\.0\.1|app_fetcher/);
    expect(existsSync(out)).toBe(false);
  });
  it("fails closed on a malformed URL without echoing it", async () => {
    const lines: string[] = [];
    expect(await main({ FETCHER_DATABASE_URL: "not a url hunter2secret" }, (l) => lines.push(l))).toBe(1);
    expect(lines.join()).not.toMatch(/hunter2secret/);
    expect(readFileSync(new URL("./fetch-guard-cli.ts", import.meta.url), "utf8")).not.toMatch(/log\(.*\burl\b/);
  });
});
