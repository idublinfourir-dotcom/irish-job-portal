import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDb, ROLES, rule, scratch, type Role, type TestDb } from "./db";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.drop());

// Everything the role can reach in public and private: tables and views (any column), sequences, functions.
async function reach(role: Role, from: Pick<pg.Pool, "query"> = db.pool("postgres")): Promise<string[]> {
  const { rows } = await from.query(
    `select c.oid::regclass::text as thing
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
        and case when c.relkind = 'S'
              then has_sequence_privilege($1, c.oid, 'usage, select, update')
              else has_table_privilege($1, c.oid, 'select, insert, update, delete, truncate, references, trigger')
                or has_any_column_privilege($1, c.oid, 'select, insert, update, references') end
      union all
     select p.oid::regprocedure::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and has_function_privilege($1, p.oid, 'execute')`,
    [role],
  );
  return rows.map((r) => r.thing);
}

describe("roles migration", () => {
  test("the owner and the app roles exist, can log in, and have no special powers", async () => {
    const { rows } = await db.query(
      "postgres",
      "select rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls from pg_roles where rolname = any($1) order by rolname",
      [[...ROLES]],
    );
    expect(rows.map((r) => r.rolname)).toEqual([...ROLES].sort());
    for (const r of rows) {
      expect(r, r.rolname).toMatchObject({ rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
    }
  });

  test("the migrating user can build things as portal_owner, in public and in private", async () => {
    await scratch(db.pool("postgres"), async (c) => {
      await c.query("set local role portal_owner");
      await c.query("create table public.owner_probe (id int)");
      await c.query("create function private.owner_probe() returns int language sql as 'select 1'");
      const { rows } = await c.query("select tableowner from pg_tables where tablename = 'owner_probe'");
      expect(rows).toEqual([{ tableowner: "portal_owner" }]);
    });
  });

  test.each(["anon", "authenticated"] as const)("%s reaches nothing in public or private", async (role) => {
    expect(await db.query("postgres", "select to_regnamespace('private') is not null as there")).toMatchObject({ rows: [{ there: true }] });
    expect(await reach(role)).toEqual([]);
    // The private schema is closed to them completely.
    await rule({ refuse: () => db.query(role, "create table private.x (id int)"), expect: "permission denied" });
  });

  test("the reach check does catch a leak (Supabase gives anon every new table made by postgres)", async () => {
    await scratch(db.pool("postgres"), async (c) => {
      await c.query("create table public.leak_probe (id int)");
      expect(await reach("anon", c)).toContain("leak_probe");
    });
  });

  test("the owner and the app roles can use schema extensions, and pg_trgm lives there", async () => {
    const { rows } = await db.query(
      "postgres",
      "select r as role, has_schema_privilege(r, 'extensions', 'usage') as usage from unnest($1::text[]) r",
      [[...ROLES]],
    );
    for (const r of rows) expect(r.usage, r.role).toBe(true);
    const ext = await db.query("postgres", "select extnamespace::regnamespace::text as schema from pg_extension where extname = 'pg_trgm'");
    expect(ext.rows).toEqual([{ schema: "extensions" }]);
    // An app role can really call a trigram function.
    const sim = await db.query("app_portal", "select extensions.similarity('dublin', 'dublin') as s");
    expect(sim.rows[0].s).toBe(1);
  });

  test("each app role has its own timeouts (taken on connect)", async () => {
    const want = {
      app_candidate: ["5s", "3s", "10s"],
      app_portal: ["5s", "3s", "10s"],
      app_fetcher: ["30s", "5s", "30s"],
      app_admin: ["1min", "10s", "1min"],
      app_backup: ["10min", "1min", "0"], // no idle limit: the backup holds its snapshot transaction open while pg_dump runs
    } as const;
    for (const [role, [statement, lock, idle]] of Object.entries(want)) {
      const { rows } = await db.query(
        role as Role,
        "select current_setting('statement_timeout') s, current_setting('lock_timeout') l, current_setting('idle_in_transaction_session_timeout') i",
      );
      expect(rows[0], role).toEqual({ s: statement, l: lock, i: idle });
    }
  });
});
