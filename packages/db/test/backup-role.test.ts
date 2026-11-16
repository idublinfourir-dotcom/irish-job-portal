// Security: app_backup (0026) reads everything and writes nothing, runs no private function, and cannot become another role. The tests try each
// refusal for real, then sweep every table, sequence and function in the three schemas so a new one cannot slip through. Fake data only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDb, rule, urlFor, type TestDb } from "./db";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());
// One short connection per call, no pool: app_backup allows 3 connections for the whole server, and the backup tests running beside this file need 2.
const login = async () => { const c = new pg.Client({ connectionString: urlFor(db.name, "app_backup") }); await c.connect(); return c; };
const q = async (sql: string, params?: unknown[]) => { const c = await login(); try { return await c.query(sql, params); } finally { await c.end(); } };
const su = (sql: string, params?: unknown[]) => db.query("postgres", sql, params);

describe("app_backup", () => {
  test("can log in, with a small connection limit, no special powers, and no role except the read-all one", async () => {
    const { rows } = await su("select rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, rolconnlimit from pg_roles where rolname = 'app_backup'");
    expect(rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolreplication: false, rolconnlimit: 3 });
    const member = await su("select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid where m.member = 'app_backup'::regrole");
    expect(member.rows.map((r) => r.rolname)).toEqual(["pg_read_all_data"]);
    expect((await q("select current_user u")).rows[0].u).toBe("app_backup");
  });

  test("reads tables in all three schemas, the migration record and the catalog pg_dump needs", async () => {
    for (const t of ["public.job", "public.cro_company", "drizzle.__drizzle_migrations", "public.audit_event"]) await q(`select count(*) from ${t}`);
    expect((await q("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n).toBeGreaterThanOrEqual(27);
    expect((await q("select pg_export_snapshot() s")).rows).toHaveLength(1);
  });

  test.each(["public.job", "public.candidate_user", "public.audit_event", "public.cro_company", "drizzle.__drizzle_migrations"])("is refused insert, update, delete and truncate on %s", async (table) => {
    const col = (await su("select column_name from information_schema.columns where table_schema || '.' || table_name = $1 and is_identity = 'NO' and is_generated = 'NEVER' order by ordinal_position limit 1", [table])).rows[0].column_name;
    await rule({ refuse: () => q(`insert into ${table} default values`), expect: "permission denied" });
    await rule({ refuse: () => q(`update ${table} set ${col} = ${col}`), expect: "permission denied" });
    await rule({ refuse: () => q(`delete from ${table}`), expect: "permission denied" });
    await rule({ refuse: () => q(`truncate ${table}`), expect: "permission denied" });
  });

  test("is refused creating a table, a function or a schema, and altering or dropping what exists", async () => {
    await rule({ refuse: () => q("create table public.x (id int)"), expect: "permission denied" });
    await rule({ refuse: () => q("create function public.x() returns int language sql as 'select 1'"), expect: "permission denied" });
    await rule({ refuse: () => q("create table private.x (id int)"), expect: "permission denied" });
    await rule({ refuse: () => q("create table drizzle.x (id int)"), expect: "permission denied" });
    await rule({ refuse: () => q("create schema x"), expect: "permission denied" });
    await rule({ refuse: () => q("alter table public.job add column x int"), expect: "must be owner" });
    await rule({ refuse: () => q("drop table public.job"), expect: "must be owner" });
  });

  test("is refused every private function, with a real call and by a sweep of all of them", async () => {
    const fns = (await su("select p.oid::regprocedure::text f, p.oid from pg_proc p where p.pronamespace = 'private'::regnamespace")).rows;
    expect(fns.length).toBeGreaterThan(5);
    for (const f of fns) expect((await su("select has_function_privilege('app_backup', $1::oid, 'execute') x", [f.oid])).rows[0].x, f.f).toBe(false);
    await rule({ refuse: () => q("select private.run_retention(1)"), expect: "permission denied" });
  });

  test("has no write right and no function right in any schema it reads (sweep)", async () => {
    const t = await su(`select c.oid::regclass::text t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'private', 'drizzle') and c.relkind in ('r', 'p', 'v', 'm', 'f')
          and has_table_privilege('app_backup', c.oid, 'insert, update, delete, truncate, references, trigger')`);
    expect(t.rows).toEqual([]);
    const s = await su(`select c.oid::regclass::text t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'private', 'drizzle') and c.relkind = 'S' and case when c.relkind = 'S' then has_sequence_privilege('app_backup', c.oid, 'update') end`);
    expect(s.rows).toEqual([]);
    const f = await su(`select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private', 'drizzle') and has_function_privilege('app_backup', p.oid, 'execute')
          and not exists (select from pg_depend d where d.objid = p.oid and d.deptype = 'e')`);
    expect(f.rows.map((r) => r.f)).toEqual([]);
    for (const schema of ["public", "private", "drizzle"]) expect((await su("select has_schema_privilege('app_backup', $1, 'create') x", [schema])).rows[0].x, schema).toBe(false);
    expect((await su("select has_database_privilege('app_backup', current_database(), 'create') x")).rows[0].x).toBe(false);
  });

  test.each(["app_candidate", "app_portal", "app_admin", "app_fetcher", "portal_owner", "postgres", "anon", "authenticated", "pg_write_all_data"])("cannot become %s", async (role) => {
    await rule({ refuse: () => q(`set role ${role}`), expect: "permission denied" });
    await rule({ refuse: () => q(`set session authorization ${role}`), expect: "permission denied" });
  });

  test("cannot make itself powerful: no grant, no role change, no copy to a file or program", async () => {
    await rule({ refuse: () => q("grant pg_write_all_data to app_backup"), expect: "permission" });
    await rule({ refuse: () => q("alter role app_backup superuser"), expect: "permission" });
    await rule({ refuse: () => q("alter role app_backup connection limit -1"), expect: "permission" });
    await rule({ refuse: () => q("copy public.job to program 'true'"), expect: "permission" });
    await rule({ refuse: () => q("copy public.job to '/tmp/x'"), expect: "permission" });
  });

  test("its snapshot transaction is read only: even a temp table is refused", async () => {
    const c = await login();
    try {
      await c.query("begin isolation level repeatable read, read only");
      await rule({ refuse: () => c.query("create temp table t (id int)"), expect: "read-only" });
    } finally { await c.end(); }
  });
});
