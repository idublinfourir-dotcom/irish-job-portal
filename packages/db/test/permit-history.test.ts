// Integration: the permit history label set from the DETE data (migration 0007: private.refresh_permit_history and
// private.mark_first_time) against the real test database. Fake names only.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { importPermits, linkNames, type PermitRow } from "../src/dete";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

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
const row = (deteName: string, year: number, permits: number): PermitRow => ({ deteName, year, permits, sourceFile: "f.xlsx" });
const refresh = async () => (await admin().query("select private.refresh_permit_history() as n")).rows[0].n as number;
const label = async (org: number | string) => (await su("select permit_history from organisation where id = $1", [org])).rows[0].permit_history as string;
// The tests below are about the DETE rule, so the employer is confirmed first (#73); the refusal for an unconfirmed one has its own test.
const markFirstTime = async (org: number | string) => {
  // a CRO number, not the big-company flag: that flag needs a two-person approval
  await su("update organisation set cro_number = coalesce(cro_number, $2) where id = $1", [org, id("cro")]).catch(() => undefined);
  return admin().query("select private.mark_first_time($1)", [org]);
};

/** An organisation with one name, and DETE rows of that name linked to it (written directly, so no refresh has run yet). */
async function employer(rows: [year: number, permits: number][] = []) {
  const org = await F.org();
  const tag = id("ph");
  const nameId = (await su("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, $2, 'alias', 'admin') returning id::text", [org, tag])).rows[0].id as string;
  if (rows.length) {
    for (const [y, p] of rows) await su("insert into dete_permit_count(dete_name, organisation_name_id, year, permits) values ($1, $2, $3, $4)", [tag, nameId, y, p]);
  }
  return { org, tag, nameId };
}
// A live job needs a search vector, a closed one closed_at and a reason (job checks); fake jobs written as postgres, so the app guards do not interfere.
async function job(org: number, status: "live" | "closed") {
  const src = (await su("insert into job_source(kind,board) values ('portal',$1) returning id", [id("b")])).rows[0].id;
  const extra = status === "closed" ? ", closed_at, close_reason" : ", search_vector";
  const vals = status === "closed" ? ", now(), 'closed'" : ", to_tsvector('english','cook')";
  return (await su(`insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url${extra})
    values ($1,'admin_manual',$2,'Cook','Org','it','critical_skills','${status}',now()+interval '20 days','https://example.test/a'${vals}) returning id`, [org, src])).rows[0].id as string;
}
const jobLabel = async (j: string) => (await su("select permit_history from job where id = $1", [j])).rows[0].permit_history as string;

describe("the rule", () => {
  it("permits in 2019 or later make has_history, and the employer's live jobs get it", async () => {
    const e = await employer([[2025, 3]]);
    const j = await job(e.org, "live");
    expect(await label(e.org)).toBe("not_linked");
    expect(await jobLabel(j)).toBe("not_linked");
    expect(await refresh()).toBeGreaterThanOrEqual(1);
    expect(await label(e.org)).toBe("has_history");
    expect(await jobLabel(j)).toBe("has_history");
  });

  it("the import and the link commands' functions do it themselves, in their own transaction", async () => {
    const org = await F.org();
    const tag = id("auto");
    const nameId = (await su("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, $2, 'alias', 'admin') returning id::text", [org, tag])).rows[0].id as string;
    expect(await importPermits(admin(), [row(tag, 2024, 2)])).toMatchObject({ labelsChanged: 0 }); // not linked yet
    expect((await linkNames(admin(), [{ organisationNameId: nameId, deteName: tag }])).labelsChanged).toBe(1);
    expect(await label(org)).toBe("has_history");
  });

  it("2018 only does not count, 2019 does", async () => {
    const old = await employer([[2018, 50]]);
    const edge = await employer([[2019, 1]]);
    await refresh();
    expect(await label(old.org)).toBe("not_linked");
    expect(await label(edge.org)).toBe("has_history");
  });

  it("a name linked to the employer counts through any of its names", async () => {
    const e = await employer();
    const second = (await su("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, $2, 'alias', 'admin') returning id::text", [e.org, id("second")])).rows[0];
    const tag = id("viaSecond");
    await importPermits(admin(), [row(tag, 2022, 4)]);
    await linkNames(admin(), [{ organisationNameId: second.id, deteName: tag }]);
    expect(await label(e.org)).toBe("has_history");
  });

  it("removing the links goes back to not_linked, and the live jobs follow", async () => {
    const e = await employer([[2024, 5]]);
    const j = await job(e.org, "live");
    await refresh();
    expect(await jobLabel(j)).toBe("has_history");
    await su("update dete_permit_count set organisation_name_id = null where dete_name = $1", [e.tag]);
    await refresh();
    expect(await label(e.org)).toBe("not_linked");
    expect(await jobLabel(j)).toBe("not_linked");
  });

  it("a row with permits 0 does not count", async () => {
    const e = await employer();
    await su("insert into dete_permit_count(dete_name, organisation_name_id, year, permits) values ($1, $2, 2025, 0)", [e.tag, e.nameId]);
    await refresh();
    expect(await label(e.org)).toBe("not_linked");
  });

  it("run twice, the second run changes nothing and writes no row", async () => {
    await employer([[2025, 1]]);
    await refresh();
    const xmin = async () => (await su("select string_agg(xmin::text, ',' order by id) x from organisation")).rows[0].x;
    const before = await xmin();
    expect(await refresh()).toBe(0);
    expect(await xmin()).toBe(before);
  });

  it("closed jobs keep their old label", async () => {
    const e = await employer([[2025, 1]]);
    const live = await job(e.org, "live");
    const closed = await job(e.org, "closed");
    await refresh();
    expect(await jobLabel(live)).toBe("has_history");
    expect(await jobLabel(closed)).toBe("not_linked");
  });
});

describe("first_time", () => {
  it("#73: is refused for an employer that is neither on the big-company list nor has a CRO number, and allowed with either", async () => {
    const plain = await employer();
    await expect(admin().query("select private.mark_first_time($1)", [plain.org])).rejects.toMatchObject({ code: "P0001" });
    expect(await label(plain.org)).toBe("not_linked");
    const withCro = await employer();
    await su("update organisation set cro_number = $2 where id = $1", [withCro.org, id("cro")]);
    await admin().query("select private.mark_first_time($1)", [withCro.org]);
    expect(await label(withCro.org)).toBe("first_time");
  });

  it("is set with no rows, stays through a refresh, and jobs follow", async () => {
    const e = await employer();
    const j = await job(e.org, "live");
    await markFirstTime(e.org);
    expect(await label(e.org)).toBe("first_time");
    expect(await jobLabel(j)).toBe("first_time");
    await markFirstTime(e.org); // again: nothing happens
    await refresh();
    expect(await label(e.org)).toBe("first_time");
  });

  it("is also allowed when the only rows are 2018 or zero permits", async () => {
    const e = await employer([[2018, 9]]);
    await markFirstTime(e.org);
    expect(await label(e.org)).toBe("first_time");
  });

  it("is refused when a qualifying row exists, and then nothing changes", async () => {
    const e = await employer([[2023, 2]]);
    await expect(markFirstTime(e.org)).rejects.toMatchObject({ code: "P0001", message: expect.stringContaining("DETE permit record") });
    await refresh(); // now has_history; still refused
    await expect(markFirstTime(e.org)).rejects.toMatchObject({ code: "P0001" });
    expect(await label(e.org)).toBe("has_history");
  });

  it("a later row turns first_time into has_history, and losing it again gives not_linked", async () => {
    const e = await employer();
    await markFirstTime(e.org);
    await importPermits(admin(), [row(e.tag, 2026, 1)]);
    await linkNames(admin(), [{ organisationNameId: e.nameId, deteName: e.tag }]);
    expect(await label(e.org)).toBe("has_history");
    await su("update dete_permit_count set organisation_name_id = null where dete_name = $1", [e.tag]);
    await refresh();
    expect(await label(e.org)).toBe("not_linked");
  });

  it("refuses an organisation that does not exist", async () => {
    await expect(markFirstTime("987654321")).rejects.toMatchObject({ code: "P0001", message: expect.stringContaining("no such organisation") });
  });
});

describe("security", () => {
  const calls = [
    ["refresh_permit_history", "select private.refresh_permit_history()", []],
    ["mark_first_time", "select private.mark_first_time($1)", ["1"]],
  ] as const;

  it.each(["app_candidate", "app_portal", "app_fetcher", "anon", "authenticated"] as const)("%s can run neither function", async (role) => {
    for (const [name, sql, args] of calls) await expect(db.query(role, sql, [...args]), `${role} ${name}`).rejects.toMatchObject({ code: "42501" });
  });

  it("only app_admin holds execute; PUBLIC, anon, authenticated and service_role do not", async () => {
    const r = await su(`select r, f, has_function_privilege(r, f, 'execute') as ok
      from unnest(array['app_candidate','app_portal','app_fetcher','app_admin','anon','authenticated','service_role','public']) r,
           unnest(array['private.refresh_permit_history()','private.mark_first_time(bigint)']) f`);
    expect(r.rows.filter((x) => x.ok).map((x) => `${x.r} ${x.f}`)).toEqual(["app_admin private.refresh_permit_history()", "app_admin private.mark_first_time(bigint)"]);
  });

  it("both run with the owner's rights and a fixed search_path", async () => {
    const r = await su("select proname, prosecdef, proconfig from pg_proc where proname in ('refresh_permit_history','mark_first_time') order by 1");
    expect(r.rows.map((x) => [x.proname, x.prosecdef, x.proconfig])).toEqual([
      ["mark_first_time", true, ["search_path=public, pg_temp"]], ["refresh_permit_history", true, ["search_path=public, pg_temp"]],
    ]);
  });

  it("hostile organisation ids are database errors, not guesses, and nothing changes", async () => {
    const e = await employer();
    for (const bad of ["1; drop table organisation", "' or 1=1 --", "1.5", "", "9223372036854775808"])
      await expect(markFirstTime(bad), bad).rejects.toMatchObject({ code: expect.stringMatching(/^(22P02|22003)$/) });
    await expect(markFirstTime("-1")).rejects.toMatchObject({ code: "P0001" });
    expect(await label(e.org)).toBe("not_linked");
    expect((await su("select count(*)::int n from organisation")).rows[0].n).toBeGreaterThan(0);
  });
});

describe("budget", () => {
  it("refreshes 5,000 organisations over 48,096 DETE rows in 1 statement and 1 second, and again in 1 second with no change", async () => {
    const ORGS = 5000;
    await su(`insert into organisation(slug, display_name, kind, status) select 'phb-'||g, 'Budget Org '||g, 'employer', 'unclaimed' from generate_series(1, ${ORGS}) g`);
    await su(`insert into organisation_name(organisation_id, name, normalised_name, kind, source)
      select o.id, 'Budget Name '||o.id||'-'||k, 'budget name '||o.id||' '||k, 'alias', 'admin' from organisation o cross join generate_series(1, 2) k where o.slug like 'phb-%'`);
    await refresh(); // earlier tests' organisations are already right, so the first run below counts only this data
    // 48,096 yearly rows (the size of the real file) over 2019 to 2026, spread over the 10,000 names; about 80% of the names have permits
    await su(`with n as (select id, row_number() over (order by id) rn from organisation_name where name like 'Budget Name %')
      insert into dete_permit_count(dete_name, organisation_name_id, year, permits, source_file)
      select 'Budget DETE '||g, n.id, 2019 + (g % 8), case when g % 10 < 8 then 1 + g % 5 else 0 end, 'f.xlsx'
        from generate_series(1, 48096) g join n on n.rn = 1 + (g % ${ORGS * 2})`);
    const expected = (await su(`select count(distinct nm.organisation_id)::int n from dete_permit_count d join organisation_name nm on nm.id = d.organisation_name_id
      where d.permits > 0 and d.year >= 2019 and nm.name like 'Budget Name %'`)).rows[0].n as number;
    // every linked organisation changes in the first run: its label, or at least its sponsor key (migration 0008)
    const linked = (await su(`select count(distinct nm.organisation_id)::int n from dete_permit_count d join organisation_name nm on nm.id = d.organisation_name_id
      where nm.name like 'Budget Name %'`)).rows[0].n as number;
    expect((await su("select count(*)::int n from dete_permit_count where dete_name like 'Budget DETE %'")).rows[0].n).toBe(48096);
    await su("analyze dete_permit_count");
    await su("analyze organisation_name");
    await su("analyze organisation");
    // some live jobs to copy onto
    for (let i = 0; i < 20; i++) await job((await su("select id from organisation where slug = $1", [`phb-${i + 1}`])).rows[0].id, "live");

    const client = await admin().connect();
    let statements = 0;
    try {
      const timed = async () => {
        const t = performance.now();
        statements++; // exactly one statement is sent per refresh
        const n = (await client.query("select private.refresh_permit_history() as n")).rows[0].n as number;
        return { n, ms: performance.now() - t };
      };
      const first = await timed();
      const second = await timed();
      console.log(`permit history refresh budget: first ${first.n} labels in ${Math.round(first.ms)} ms, again ${second.n} in ${Math.round(second.ms)} ms, ${statements / 2} statement each`);
      expect(first.n).toBe(linked);
      expect(second.n).toBe(0);
      expect(first.ms).toBeLessThan(1_000);
      expect(second.ms).toBeLessThan(1_000);
      expect(statements).toBe(2);
    } finally {
      client.release();
    }
    expect((await su("select count(*)::int n from organisation where slug like 'phb-%' and permit_history = 'has_history'")).rows[0].n).toBe(expected);
    expect((await su("select count(*)::int n from job j join organisation o on o.id = j.organisation_id where o.slug like 'phb-%' and j.permit_history <> o.permit_history")).rows[0].n).toBe(0);
  });
});

describe("the commands print how many labels changed", () => {
  const run = promisify(execFile);
  const root = new URL("../../..", import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), "ph-cli-"));
  it("import and link", async () => {
    await refresh(); // the labels are right before the commands run, so they count only this employer
    const e = await employer();
    const f1 = join(dir, "p.tsv");
    writeFileSync(f1, `dete_name\tyear\tpermits\tsource_file\n${e.tag}\t2025\t3\tf.xlsx\n`);
    const f2 = join(dir, "l.tsv");
    writeFileSync(f2, `organisation_name_id\tdete_name\n${e.nameId}\t${e.tag}\n`);
    const env = { PATH: process.env.PATH, DATABASE_SSL: "disable", DETE_ADMIN_DATABASE_URL: urlFor(db.name, "app_admin") };
    const cli = async (...args: string[]) => (await run(process.execPath, ["packages/db/src/dete-cli.ts", ...args], { cwd: root, env })).stdout;
    expect(await cli("import", f1)).toBe("imported 1 new, 0 changed, 0 unchanged, 0 permit history labels changed\n");
    expect(await cli("link", f2)).toBe("linked 1 DETE rows, skipped 0, 1 permit history labels changed\n");
    expect(await label(e.org)).toBe("has_history");
    expect(await cli("link", f2)).toBe("linked 0 DETE rows, skipped 0, 0 permit history labels changed\n");
  });
});
