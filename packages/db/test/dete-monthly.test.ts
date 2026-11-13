// Integration: the monthly DETE import against the real test database, with DETE's site always a fake. Fake names only.
// Each test uses its own year (2041 and up), so the year totals never mix. See src/dete-monthly-cli.ts and importPermits' replaceYears.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { importPermits, type PermitRow } from "../src/dete";
import { main } from "../src/dete-monthly-cli";
import { companiesXlsx, makeXlsx } from "../src/xlsx-fixture";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb;
let id: (prefix: string) => string;
let F: { org: () => Promise<number> };
let su: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
beforeAll(async () => {
  db = await createTestDb();
  ({ id, F, su } = fixtures(db) as unknown as { id: typeof id; F: typeof F; su: typeof su });
});
afterAll(() => db.drop());

const admin = () => db.pool("app_admin");
const row = (deteName: string, year: number, permits: number): PermitRow => ({ deteName, year, permits, sourceFile: `companies-${year}.xlsx` });
const stored = async (year: number) => (await su("select dete_name, permits, source_file, organisation_name_id from dete_permit_count where year = $1 order by dete_name", [year])).rows;
const total = async (year: number) => Number((await su("select coalesce(sum(permits), 0) as t from dete_permit_count where year = $1", [year])).rows[0].t);
const ENV = (role = "app_admin") => ({ DETE_ADMIN_DATABASE_URL: urlFor(db.name, role), DATABASE_SSL: "disable" });
const at = (iso: string) => new Date(`${iso}T07:17:00Z`);

/** A fake DETE site: serves the given reply per year and records every address asked for. */
function site(replies: Record<number, Response | (() => Response)>) {
  const asked: string[] = [];
  const get = (async (url: string, init?: RequestInit) => {
    asked.push(url);
    expect(init?.redirect).toBe("error");
    expect(url).toMatch(/^https:\/\/enterprise\.gov\.ie\/en\/publications\/publication-files\/employment-permits-issued-to-companies-\d{4}\.xlsx$/);
    const r = replies[Number(/(\d{4})\.xlsx$/.exec(url)![1])];
    return r instanceof Response ? r.clone() : r ? r() : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { get, asked };
}
const file = (companies: [string, number | string][]) => new Response(new Uint8Array(companiesXlsx(companies)));
const run = async (env: Record<string, string | undefined>, fake: typeof fetch, now: Date) => {
  const lines: string[] = [];
  const code = await main(env, (l) => lines.push(l), { fetch: fake, now });
  return { code, out: lines.join("\n") };
};

describe("importPermits with replaceYears: the newest file wins", () => {
  it("an older month then a newer one: totals equal the newer file, nothing is counted twice, and the newer file again changes nothing", async () => {
    const p = id("rep"), y = 2041;
    const march = [row(`${p} A`, y, 3), row(`${p} B`, y, 2), row(`${p} C`, y, 1)];
    const april = [row(`${p} A`, y, 5), row(`${p} B`, y, 2), row(`${p} D`, y, 4)]; // A grew, B same, C dropped by DETE, D is new
    expect(await importPermits(admin(), march, { replaceYears: true })).toEqual({ inserted: 3, updated: 0, unchanged: 0, labelsChanged: 0, zeroed: 0 });
    expect(await total(y)).toBe(6);
    expect(await importPermits(admin(), april, { replaceYears: true })).toEqual({ inserted: 1, updated: 1, unchanged: 1, labelsChanged: 0, zeroed: 1 });
    expect(await total(y)).toBe(11); // 5 + 2 + 0 + 4, the newer file's total
    expect((await stored(y)).map((r) => [r.dete_name.slice(-1), r.permits, r.source_file])).toEqual([["A", 5, `companies-${y}.xlsx`], ["B", 2, `companies-${y}.xlsx`], ["C", 0, `companies-${y}.xlsx`], ["D", 4, `companies-${y}.xlsx`]]);
    const before = (await su("select id, xmin::text from dete_permit_count where year = $1 order by id", [y])).rows;
    expect(await importPermits(admin(), april, { replaceYears: true })).toEqual({ inserted: 0, updated: 0, unchanged: 3, labelsChanged: 0, zeroed: 0 });
    expect((await su("select id, xmin::text from dete_permit_count where year = $1 order by id", [y])).rows).toEqual(before); // no row was rewritten
  });

  it("a dropped name keeps its link, and other years and other names are untouched", async () => {
    const p = id("keep"), y = 2042;
    const org = await F.org();
    const nameId = (await su("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, $2, 'alias', 'admin') returning id::text", [org, id("n")])).rows[0].id;
    await importPermits(admin(), [row(`${p} A`, y, 4), row(`${p} A`, y - 1, 9), row(`${p} Other`, y + 100, 7)]);
    await su("update dete_permit_count set organisation_name_id = $1 where dete_name = $2", [nameId, `${p} A`]);
    await importPermits(admin(), [row(`${p} B`, y, 6)], { replaceYears: true });
    expect((await stored(y)).filter((r) => r.dete_name.startsWith(p)).map((r) => [r.dete_name.slice(-1), r.permits, r.organisation_name_id])).toEqual([["A", 0, nameId], ["B", 6, null]]);
    expect((await stored(y - 1)).find((r) => r.dete_name === `${p} A`)!.permits).toBe(9);
    expect((await stored(y + 100)).find((r) => r.dete_name === `${p} Other`)!.permits).toBe(7);
  });

  it("a cut-off file (under half of what is stored) is refused and nothing is written", async () => {
    const p = id("cut"), y = 2043;
    await importPermits(admin(), Array.from({ length: 10 }, (_, i) => row(`${p} ${i}`, y, 10)), { replaceYears: true }); // 100
    const before = await stored(y);
    await expect(importPermits(admin(), [row(`${p} 0`, y, 10)], { replaceYears: true })).rejects.toThrow(/under half of the 100 stored/);
    expect(await stored(y)).toEqual(before);
    await importPermits(admin(), Array.from({ length: 10 }, (_, i) => row(`${p} ${i}`, y, i < 5 ? 10 : 0)).filter((r) => r.permits), { replaceYears: true }); // exactly half is allowed
    expect(await total(y)).toBe(50);
  });

  it("without replaceYears the import is what it was: nothing is zeroed and the result has no zeroed field", async () => {
    const p = id("plain"), y = 2044;
    await importPermits(admin(), [row(`${p} A`, y, 1), row(`${p} B`, y, 2)]);
    const r = await importPermits(admin(), [row(`${p} A`, y, 1)]);
    expect(r).toEqual({ inserted: 0, updated: 0, unchanged: 1, labelsChanged: 0 });
    expect(await total(y)).toBe(3);
  });

  it("a failure half way leaves the old totals (one transaction)", async () => {
    const p = id("tx"), y = 2045;
    await importPermits(admin(), [row(`${p} A`, y, 5), row(`${p} B`, y, 5)], { replaceYears: true });
    // A is changed in the first chunk of 10,000; Postgres refuses the NUL in the second chunk
    const bad = [row(`${p} A`, y, 8), ...Array.from({ length: 10_000 }, (_, i) => row(`${p} n${i}`, y, 1)), { ...row(`${p} X`, y, 8), deteName: "x\u0000y" }];
    await expect(importPermits(admin(), bad, { replaceYears: true })).rejects.toThrow();
    expect(await total(y)).toBe(10);
  });
});

describe("the monthly command", () => {
  it("imports this year's file, says what it did, and the next month's file replaces it", async () => {
    const p = id("cli"), y = 2046;
    const may = site({ [y]: file([[`${p} A Limited`, 3], [`${p} B Limited`, 2]]) });
    const r1 = await run(ENV(), may.get, at(`${y}-05-15`));
    expect(r1).toEqual({ code: 0, out: `${y} (companies-${y}.xlsx): 2 employers, 2 new, 0 changed, 0 unchanged, 0 dropped by DETE and set to 0, 0 permit history labels changed` });
    expect(may.asked).toHaveLength(1);
    const june = site({ [y]: file([[`${p} A Limited`, 4], [`${p} C Limited`, 1]]) });
    expect((await run(ENV(), june.get, at(`${y}-06-15`))).out).toContain("2 employers, 1 new, 1 changed, 0 unchanged, 1 dropped by DETE and set to 0");
    expect(await total(y)).toBe(5);
    expect((await run(ENV(), june.get, at(`${y}-06-16`))).out).toContain("2 employers, 0 new, 0 changed, 2 unchanged, 0 dropped");
    expect(await total(y)).toBe(5);
  });

  it("in January it also loads last year's final file; a 404 for the new year is green and one line", async () => {
    const p = id("jan"), y = 2047;
    const s = site({ [y - 1]: file([[`${p} A Limited`, 9]]) }); // the new year's file is not there: 404
    const r = await run(ENV(), s.get, at(`${y}-01-15`));
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([`DETE has not published the ${y} file yet: nothing to do`, expect.stringContaining(`${y - 1} (companies-${y - 1}.xlsx): 1 employers, 1 new`)]);
    expect(s.asked.map((u) => /(\d{4})\.xlsx$/.exec(u)![1])).toEqual([String(y - 1), String(y)]);
    expect(await total(y - 1)).toBe(9);
    expect(await total(y)).toBe(0);
  });

  it("in January with both files, both are loaded", async () => {
    const p = id("jan2"), y = 2048;
    const s = site({ [y - 1]: file([[`${p} A Limited`, 9]]), [y]: file([[`${p} A Limited`, 1]]) });
    expect((await run(ENV(), s.get, at(`${y}-01-15`))).code).toBe(0);
    expect([await total(y - 1), await total(y)]).toEqual([9, 1]);
  });

  it("outside January a 404 is red, and so is last year's file missing in January", async () => {
    const y = 2049;
    const r = await run(ENV(), site({}).get, at(`${y}-06-15`));
    expect(r.code).toBe(1);
    expect(r.out).toContain("DETE has no 2049 file (HTTP 404)");
    const j = await run(ENV(), site({ [y]: file([["Some Limited", 1]]) }).get, at(`${y}-01-15`));
    expect(j.code).toBe(1);
    expect(j.out).toContain(`DETE has no ${y - 1} file`);
    expect(await total(y)).toBe(0); // nothing was written, not even the new year's file
  });

  it.each([
    ["an HTML page", () => new Response("<html>Sorry, an error</html>", { headers: { "content-type": "text/html" } }), /not an \.xlsx/],
    ["a server error", () => new Response("boom", { status: 502 }), /HTTP 502/],
    ["a zip that is not a workbook", () => new Response(new Uint8Array(makeXlsx([], { "xl/workbook.xml": "<nothing/>" }))), /no first worksheet|no workbook/],
    ["a file with a negative count", () => file([["Fine Limited", 1], ["Bad Limited", -4]]), /whole number from 0/],
    ["a file with a fractional count", () => file([["Bad Limited", 1.5]]), /whole number from 0/],
    ["a file with a huge count", () => file([["Bad Limited", 99_999_999]]), /whole number from 0/],
    ["a file with a control character in a name", () => file([["Fine Limited", 1], ["Bad\u0007 Limited", 1]]), /line \d: the name is empty/],
    ["a file with a format character in a name", () => file([["Fine Limited", 1], ["Evil‮ Limited", 1]]), /line \d: the name is empty/],
    ["a workbook with no Total column", () => new Response(new Uint8Array(makeXlsx([["Employer Name", "Jan"], ["A Limited", 1]]))), /no "Total" column/],
  ])("%s is refused whole and nothing is written", async (_, reply, message) => {
    const y = 2050;
    const before = await total(y);
    const r = await run(ENV(), site({ [y]: reply }).get, at(`${y}-06-15`));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(message);
    expect(await total(y)).toBe(before);
    expect(r.out).not.toContain("postgres://");
  });

  it("in January a bad new-year file stops the run before last year's good file is written", async () => {
    const y = 2051;
    const r = await run(ENV(), site({ [y - 1]: file([["Good Limited", 5]]), [y]: file([["Bad Limited", -1]]) }).get, at(`${y}-01-15`));
    expect(r.code).toBe(1);
    expect([await total(y - 1), await total(y)]).toEqual([0, 0]);
  });

  it.each(["app_fetcher", "app_portal", "app_candidate"])("the %s login is refused and nothing is written", async (role) => {
    const y = 2052;
    const r = await run(ENV(role), site({ [y]: file([["Good Limited", 5]]) }).get, at(`${y}-06-15`));
    expect(r.code).toBe(1);
    expect(r.out).toContain("permission denied");
    expect(await total(y)).toBe(0);
  });

  it("explains itself when the login is missing, without asking DETE", async () => {
    const s = site({});
    expect(await run({}, s.get, at("2053-06-15"))).toEqual({ code: 2, out: "DETE_ADMIN_DATABASE_URL is not set (the app_admin login)" });
    expect(s.asked).toHaveLength(0);
  });
});

describe("budgets", () => {
  it("a replace import of 38,183 rows takes 9 statements and under 5 seconds, then again", async () => {
    const y = 2060;
    const rows = Array.from({ length: 38_183 }, (_, i) => row(`Fake Replace Company ${i} Limited`, y + (i % 4), 1 + (i % 40)));
    let statements = 0;
    const counted = {
      query: admin().query.bind(admin()),
      connect: async () => {
        const c = await admin().connect();
        return new Proxy(c, { get: (target, key) => (key === "query" ? (...a: unknown[]) => (statements++, (target.query as (...x: unknown[]) => unknown)(...a)) : Reflect.get(target, key)) });
      },
    } as unknown as Parameters<typeof importPermits>[0];
    let t = performance.now();
    expect((await importPermits(counted, rows, { replaceYears: true })).inserted).toBe(38_183);
    const first = performance.now() - t;
    expect(statements).toBe(9); // begin, the year totals, 4 chunks of 10,000, the dropped names, the label refresh, commit
    t = performance.now();
    expect(await importPermits(counted, rows, { replaceYears: true })).toMatchObject({ unchanged: 38_183, zeroed: 0 });
    const second = performance.now() - t;
    console.log(`dete replace budget: first ${Math.round(first)} ms, again ${Math.round(second)} ms, ${statements / 2} statements each`);
    expect(first).toBeLessThan(5_000);
    expect(second).toBeLessThan(5_000);
  });
});
