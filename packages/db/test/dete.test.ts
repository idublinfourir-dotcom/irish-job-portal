// Integration: DETE permit counts against the real test database. Fake names only. See src/dete.ts and src/dete-cli.ts.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { importPermits, LAST_5_YEARS, linkNames, parseLinks, parsePermits, permitsLast5Years, type PermitRow } from "../src/dete";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { measurePages } from "./perf/pages";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb;
// fixtures.ts is untyped, so its three helpers are typed here.
let id: (prefix: string) => string;
let F: { org: () => Promise<number> };
let su: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
beforeAll(async () => {
  db = await createTestDb();
  ({ id, F, su } = fixtures(db) as unknown as { id: typeof id; F: typeof F; su: typeof su });
});
afterAll(() => db.drop());

const NOW = new Date("2026-11-11T12:00:00Z"); // the 5 years are 2022 to 2026
const admin = () => db.pool("app_admin");
const row = (deteName: string, year: number, permits: number, sourceFile: string | null = "f.xlsx"): PermitRow => ({ deteName, year, permits, sourceFile });
/** An organisation with `n` names; returns the organisation id and the name ids. */
async function orgWithNames(n: number) {
  const org = await F.org();
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const tag = id("n");
    names.push((await su("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, $2, 'alias', 'admin') returning id::text", [org, tag])).rows[0].id);
  }
  return { org: String(org), names };
}
const dump = async (prefix: string) => (await su("select * from dete_permit_count where dete_name like $1 order by id", [`${prefix}%`])).rows;

describe("import", () => {
  it("loads yearly totals with no month, and running it again changes nothing at all", async () => {
    const p = id("imp");
    const rows = [row(`${p} A`, 2024, 5), row(`${p} A`, 2025, 6), row(`${p} B`, 2025, 7, null)];
    expect(await importPermits(admin(), rows)).toEqual({ inserted: 3, updated: 0, unchanged: 0, labelsChanged: 0 });
    const first = await dump(p);
    expect(first.map((r) => [r.dete_name, r.year, r.month, r.permits, r.source_file, r.organisation_name_id])).toEqual([
      [`${p} A`, 2024, null, 5, "f.xlsx", null], [`${p} A`, 2025, null, 6, "f.xlsx", null], [`${p} B`, 2025, null, 7, null, null],
    ]);
    expect(await importPermits(admin(), rows)).toEqual({ inserted: 0, updated: 0, unchanged: 3, labelsChanged: 0 });
    expect(await dump(p)).toEqual(first); // same ids, same imported_at, same everything
    // xmin is the writing transaction: still the first one, so no row was even rewritten
    const x = (await su("select xmin::text from dete_permit_count where dete_name like $1 order by id", [`${p}%`])).rows;
    expect(new Set(x.map((r) => r.xmin)).size).toBe(1);
  });

  it("a changed figure updates only that row, and keeps the link", async () => {
    const p = id("chg");
    const { names, org } = await orgWithNames(1);
    await importPermits(admin(), [row(`${p} A`, 2025, 5), row(`${p} A`, 2026, 9)]);
    await linkNames(admin(), [{ organisationNameId: names[0]!, deteName: `${p} A` }]);
    const before = await dump(p);
    expect(await importPermits(admin(), [row(`${p} A`, 2025, 5), row(`${p} A`, 2026, 11, "new.xlsx")])).toEqual({ inserted: 0, updated: 1, unchanged: 1, labelsChanged: 1 }); // same label, the sponsor key moved (0008)
    const after = await dump(p);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toMatchObject({ permits: 11, source_file: "new.xlsx", organisation_name_id: before[1].organisation_name_id });
    expect(after[1].organisation_name_id).toBe(String(names[0]));
    expect(await permitsLast5Years(admin(), org, NOW)).toEqual({ permits: 16, firstYear: 2025 });
  });

  it("is all or nothing: a bad row in the second chunk leaves no row from the first", async () => {
    const p = id("atomic");
    const rows = Array.from({ length: 10_001 }, (_, i) => row(`${p} ${i}`, 2025, 1));
    rows[10_000] = row(`${p} bad`, 2025, 5_000_000_000); // over the integer column: only the database refuses it
    await expect(importPermits(admin(), rows)).rejects.toThrow();
    expect(await dump(p)).toEqual([]);
  });
});

describe("links", () => {
  it("sets the link on those rows only, twice the same, and reports names and ids it does not know", async () => {
    const p = id("lnk");
    const { names } = await orgWithNames(2);
    await importPermits(admin(), [row(`${p} A`, 2025, 1), row(`${p} A`, 2026, 2), row(`${p} B`, 2026, 4), row(`${p} C`, 2026, 8)]);
    const links = [
      { organisationNameId: names[0]!, deteName: `${p} A` },
      { organisationNameId: names[1]!, deteName: `${p} B` },
      { organisationNameId: names[1]!, deteName: `${p} a` }, // different case: not guessed
      { organisationNameId: "999999999", deteName: `${p} C` }, // no such organisation name
    ];
    const r = await linkNames(admin(), links);
    expect(r.rowsChanged).toBe(3);
    expect(r.skipped).toEqual([`DETE name not found: ${p} a`, `organisation_name_id 999999999 does not exist (${p} C)`]);
    const got = await dump(p);
    expect(got.map((x) => [x.dete_name, x.organisation_name_id])).toEqual([[`${p} A`, names[0]], [`${p} A`, names[0]], [`${p} B`, names[1]], [`${p} C`, null]]);
    expect(await linkNames(admin(), links)).toMatchObject({ rowsChanged: 0 });
    expect(await dump(p)).toEqual(got);
  });

  it("an empty list does nothing", async () => {
    expect(await linkNames(admin(), [])).toEqual({ rowsChanged: 0, skipped: [], labelsChanged: 0 });
  });

  it("moves a link when an admin names another employer name for the same DETE name", async () => {
    const p = id("mv");
    const { names } = await orgWithNames(2);
    await importPermits(admin(), [row(`${p} A`, 2026, 3)]);
    await linkNames(admin(), [{ organisationNameId: names[0]!, deteName: `${p} A` }]);
    expect(await linkNames(admin(), [{ organisationNameId: names[1]!, deteName: `${p} A` }])).toMatchObject({ rowsChanged: 1 });
    expect((await dump(p))[0]!.organisation_name_id).toBe(names[1]);
  });
});

describe("permitsLast5Years", () => {
  it("sums the last 5 calendar years over two linked names and gives the first year", async () => {
    const p = id("sum");
    const { org, names } = await orgWithNames(2);
    await importPermits(admin(), [
      row(`${p} Legal`, 2021, 100), row(`${p} Legal`, 2022, 1), row(`${p} Legal`, 2026, 2), row(`${p} Legal`, 2027, 1000),
      row(`${p} Old`, 2019, 50), row(`${p} Old`, 2023, 4), row(`${p} Old`, 2024, 8),
      row(`${p} Unlinked`, 2025, 500),
    ]);
    await linkNames(admin(), [{ organisationNameId: names[0]!, deteName: `${p} Legal` }, { organisationNameId: names[1]!, deteName: `${p} Old` }]);
    // 2022 to 2026: 1 + 2 + 4 + 8 = 15. 2021, 2027 and 2019 are outside, the unlinked name is not counted. First year is over all linked rows.
    expect(await permitsLast5Years(admin(), org, NOW)).toEqual({ permits: 15, firstYear: 2019 });
    expect(await permitsLast5Years(admin(), Number(org), new Date("2027-03-01T00:00:00Z"))).toEqual({ permits: 15 - 1 + 1000, firstYear: 2019 }); // 2023 to 2027
  });

  it("uses the UTC year, so New Year's Eve in Dublin and Dhaka agree", async () => {
    const p = id("utc");
    const { org, names } = await orgWithNames(1);
    await importPermits(admin(), [row(`${p} A`, 2021, 3), row(`${p} A`, 2026, 5)]);
    await linkNames(admin(), [{ organisationNameId: names[0]!, deteName: `${p} A` }]);
    expect(await permitsLast5Years(admin(), org, new Date("2025-12-31T23:59:59Z"))).toEqual({ permits: 3, firstYear: 2021 }); // 2021 to 2025
    expect(await permitsLast5Years(admin(), org, new Date("2026-01-01T00:00:00Z"))).toEqual({ permits: 5, firstYear: 2021 }); // 2022 to 2026
  });

  it("not linked is null, linked with nothing in the window is zero", async () => {
    const p = id("nl");
    const none = await orgWithNames(1);
    const old = await orgWithNames(1);
    await importPermits(admin(), [row(`${p} Old`, 2019, 9), row(`${p} Loose`, 2025, 9)]);
    await linkNames(admin(), [{ organisationNameId: old.names[0]!, deteName: `${p} Old` }]);
    expect(await permitsLast5Years(admin(), none.org, NOW)).toBeNull(); // has a name, no DETE link
    expect(await permitsLast5Years(admin(), old.org, NOW)).toEqual({ permits: 0, firstYear: 2019 });
    expect(await permitsLast5Years(admin(), "987654321", NOW)).toBeNull(); // no such organisation
  });

  it("every app role can read it", async () => {
    const p = id("ro");
    const { org, names } = await orgWithNames(1);
    await importPermits(admin(), [row(`${p} A`, 2026, 6)]);
    await linkNames(admin(), [{ organisationNameId: names[0]!, deteName: `${p} A` }]);
    for (const role of ["app_candidate", "app_portal", "app_fetcher", "app_admin"] as const)
      expect(await permitsLast5Years(db.pool(role), org, NOW), role).toEqual({ permits: 6, firstYear: 2026 });
  });
});

describe("roles", () => {
  const writes = [
    ["insert", "insert into dete_permit_count(dete_name, year, permits) values ('role-x', 2026, 1)"],
    ["update", "update dete_permit_count set permits = permits + 1"],
    ["delete", "delete from dete_permit_count"],
    ["link", "update dete_permit_count set organisation_name_id = null"],
  ] as const;
  it.each(["app_candidate", "app_portal", "app_fetcher", "anon", "authenticated"] as const)("%s cannot write, and the import and link refuse for it", async (role) => {
    const p = id("role");
    const { names } = await orgWithNames(1);
    await importPermits(admin(), [row(p, 2026, 1)]);
    for (const [what, sql] of writes) await expect(db.query(role, sql), `${role} ${what}`).rejects.toMatchObject({ code: "42501" });
    await expect(importPermits(db.pool(role), [row(id("role"), 2026, 1)])).rejects.toMatchObject({ code: "42501" });
    await expect(linkNames(db.pool(role), [{ organisationNameId: names[0]!, deteName: p }])).rejects.toMatchObject({ code: "42501" });
  });
  it.each(["app_candidate", "app_portal", "app_fetcher"] as const)("%s can read", async (role) => {
    await expect(db.query(role, "select count(*) from dete_permit_count")).resolves.toBeTruthy();
  });
  it.each(["anon", "authenticated"] as const)("%s cannot read", async (role) => {
    await expect(db.query(role, "select count(*) from dete_permit_count")).rejects.toMatchObject({ code: "42501" });
  });
  it("app_admin can write, and cannot change the table's shape", async () => {
    await expect(db.query("app_admin", "insert into dete_permit_count(dete_name, year, permits) values ($1, 2026, 1)", [id("adm")])).resolves.toBeTruthy();
    await expect(db.query("app_admin", "drop table dete_permit_count")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("hostile content", () => {
  it("SQL-looking names are stored and linked as plain text", async () => {
    const evil = ["x'); drop table dete_permit_count; --", 'a"b', "a\\b", "$1", "%_", "'; update organisation set status='closed'; --", "<script>alert(1)</script>"];
    const { org, names } = await orgWithNames(1);
    const text = "dete_name\tyear\tpermits\tsource_file\n" + evil.map((n) => `${n}\t2026\t2\t${n.slice(0, 20)}`).join("\n") + "\n";
    const parsed = parsePermits(text);
    expect(parsed.errors).toEqual([]);
    await importPermits(admin(), parsed.rows);
    const stored = (await su("select dete_name from dete_permit_count where dete_name = any($1) order by dete_name", [evil])).rows.map((r) => r.dete_name);
    expect(stored.sort()).toEqual([...evil].sort());
    const links = parseLinks("organisation_name_id\tdete_name\n" + evil.map((n) => `${names[0]}\t${n}`).join("\n") + "\n");
    expect(await linkNames(admin(), links.rows)).toMatchObject({ rowsChanged: evil.length, skipped: [] });
    expect(await permitsLast5Years(admin(), org, NOW)).toEqual({ permits: 2 * evil.length, firstYear: 2026 });
    expect(await su("select count(*)::int as n from organisation where status = 'closed' and id = $1", [org])).toMatchObject({ rows: [{ n: 0 }] });
  });

  it("an organisation id that is not a number is a database error, not a guess", async () => {
    await expect(permitsLast5Years(admin(), "1; drop table organisation", NOW)).rejects.toMatchObject({ code: "22P02" });
  });
});

describe("budgets", () => {
  it("imports 38,183 rows twice in 7 statements and 5 seconds each, and reads one employer through indexes in few pages", async () => {
    // Same shape as the real file: ~38k yearly rows, names across 2022 to 2026.
    const rows: PermitRow[] = [];
    for (let i = 0; rows.length < 38_183; i++) for (const y of [2022, 2023, 2024, 2025, 2026]) if (rows.length < 38_183 && (i + y) % 4 !== 0) rows.push(row(`Fake Budget Company ${i} Limited`, y, 1 + ((i + y) % 40), `companies-${y}.xlsx`));

    // Counts every statement sent on the connections the import checks out.
    let statements = 0;
    const counted = {
      query: admin().query.bind(admin()),
      connect: async () => {
        const c = await admin().connect();
        return new Proxy(c, { get: (target, key) => (key === "query" ? (...a: unknown[]) => (statements++, (target.query as (...x: unknown[]) => unknown)(...a)) : Reflect.get(target, key)) });
      },
    } as unknown as Parameters<typeof importPermits>[0];
    let t = performance.now();
    expect((await importPermits(counted, rows)).inserted).toBe(38_183);
    const first = performance.now() - t;
    expect(statements).toBe(7); // begin, 4 chunks of 10,000, the label refresh, commit
    t = performance.now();
    expect((await importPermits(counted, rows)).unchanged).toBe(38_183);
    const second = performance.now() - t;
    console.log(`dete import budget: first ${Math.round(first)} ms, again ${Math.round(second)} ms, ${statements / 2} statements each`);
    expect(first).toBeLessThan(5_000);
    expect(second).toBeLessThan(5_000);

    // 3,000 employers, each with 2 names, every DETE name linked to one of them.
    await su(`insert into organisation(slug, display_name, kind, status) select 'bud-'||g, 'Budget Org '||g, 'employer', 'unclaimed' from generate_series(1, 3000) g`);
    await su(`insert into organisation_name(organisation_id, name, normalised_name, kind, source)
      select o.id, 'Budget Name '||o.id||'-'||k, 'budget name '||o.id||' '||k, 'alias', 'admin' from organisation o cross join generate_series(1, 2) k where o.slug like 'bud-%'`);
    await su(`update dete_permit_count d set organisation_name_id = (select n.id from organisation_name n where n.name like 'Budget Name %' order by n.id offset (substring(d.dete_name from '[0-9]+')::int % 6000) limit 1) where d.dete_name like 'Fake Budget Company %'`);
    await su("analyze dete_permit_count");
    await su("analyze organisation_name");
    const target = (await su("select organisation_id from organisation_name n where n.name like 'Budget Name %' and exists (select 1 from dete_permit_count d where d.organisation_name_id = n.id) order by n.id limit 1")).rows[0].organisation_id;
    expect(await permitsLast5Years(admin(), target, NOW)).not.toBeNull();

    const literal = LAST_5_YEARS.replace("$1::bigint", `${target}::bigint`).replace("$2", "2022").replace("$3", "2026");
    const client = await admin().connect();
    try {
      const [cost] = await measurePages(client, [literal]);
      console.log(`dete read budget: ${cost!.pages} pages, ${cost!.ms} ms, plan ${cost!.scans}`);
      expect(cost!.scans, cost!.scans).not.toContain("Seq Scan");
      expect(cost!.scans).toContain("organisation_name_org_idx");
      expect(cost!.scans).toContain("dete_permit_count_name_idx");
      expect(cost!.pages).toBeLessThanOrEqual(40);
    } finally {
      client.release();
    }
  });
});

describe("the admin commands", () => {
  const run = promisify(execFile);
  const root = new URL("../../..", import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), "dete-cli-"));
  const file = (name: string, text: string) => (writeFileSync(join(dir, name), text), join(dir, name));
  const cli = async (args: string[], env: Record<string, string | undefined> = { DETE_ADMIN_DATABASE_URL: urlFor(db.name, "app_admin") }) => {
    try {
      const r = await run(process.execPath, ["packages/db/src/dete-cli.ts", ...args], { cwd: root, env: { PATH: process.env.PATH, DATABASE_SSL: "disable", ...env } });
      return { code: 0, out: r.stdout };
    } catch (e) {
      const x = e as { code: number; stdout: string; stderr: string };
      return { code: x.code, out: x.stdout + x.stderr };
    }
  };

  it("import loads a file, says what it did, and a second run changes nothing", async () => {
    await admin().query("select private.refresh_permit_history()"); // the budget test above left linked employers unlabelled: start from right labels
    const p = id("cli");
    const f = file("ok.tsv", `dete_name\tyear\tpermits\tsource_file\n${p} A\t2025\t3\tf.xlsx\n${p} B\t2026\t4\tf.xlsx\n`);
    expect(await cli(["import", f])).toEqual({ code: 0, out: "imported 2 new, 0 changed, 0 unchanged, 0 permit history labels changed\n" });
    expect(await cli(["import", f])).toEqual({ code: 0, out: "imported 0 new, 0 changed, 2 unchanged, 0 permit history labels changed\n" });
  });

  it("a bad file is refused before any connection, with its line numbers", async () => {
    const f = file("bad.tsv", "dete_name\tyear\tpermits\tsource_file\nAcme\t2025\t-1\tf\n");
    const r = await cli(["import", f], { DETE_ADMIN_DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("nothing was written");
    expect(r.out).toContain("line 2: permits");
  });

  it("link sets a link and reports what it skipped", async () => {
    const p = id("cli-l");
    const { names } = await orgWithNames(1);
    await importPermits(admin(), [row(`${p} A`, 2026, 5)]);
    const f = file("links.tsv", `organisation_name_id\tdete_name\n${names[0]}\t${p} A\n${names[0]}\t${p} missing\n`);
    const r = await cli(["link", f]);
    expect(r).toEqual({ code: 0, out: `linked 1 DETE rows, skipped 1, 1 permit history labels changed\n  DETE name not found: ${p} missing\n` });
  });

  it("refuses a login that is not allowed to write", async () => {
    const f = file("ok2.tsv", `dete_name\tyear\tpermits\tsource_file\n${id("cli-r")}\t2025\t3\tf\n`);
    const r = await cli(["import", f], { DETE_ADMIN_DATABASE_URL: urlFor(db.name, "app_portal") });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("permission denied");
  });

  it("explains itself when called wrongly", async () => {
    expect((await cli([])).code).toBe(2);
    expect((await cli(["import", "x.tsv"], {})).out).toContain("DETE_ADMIN_DATABASE_URL is not set");
  });
});
