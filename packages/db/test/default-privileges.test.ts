// The trial's worst case for default privileges (schema-trial-2/00-roles.sql lines 20-22, revoked in 04-grants.sql lines 10-13):
// Supabase-style defaults on everything portal_owner creates in public, in place BEFORE the migrations run. The shared template
// only has the defaults for postgres (4a open item 4), so this file builds its own database with the stricter case, runs all
// migrations, and checks that what portal_owner creates afterwards is reachable by anon, authenticated and service_role not at all.
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { RUN, urlFor } from "./db";

const name = `portal_test_${RUN}_dp_${randomBytes(4).toString("hex")}`;
const supa = ["anon", "authenticated", "service_role"];
let owner: pg.Pool, boss: pg.Pool;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  boss = new pg.Pool({ connectionString: urlFor(name), max: 2 });
  // portal_owner is server-wide and already exists (the global setup made it), so its defaults can be set before the migrations.
  await boss.query(`
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges for role portal_owner in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges for role portal_owner in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role portal_owner in schema public grant all on sequences to anon, authenticated, service_role;`);
  await migrate(drizzle(boss), { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  owner = new pg.Pool({ connectionString: urlFor(name, "portal_owner"), max: 2 });
});
afterAll(async () => {
  await owner?.end();
  await boss?.end();
});

it("worst case: a table, sequence and function that portal_owner creates later are reachable by none of anon, authenticated, service_role", async () => {
  await owner.query(`create table public.late_table(id serial primary key);
    create function public.late_fn() returns int language sql as 'select 1';`);
  const bad: string[] = [];
  for (const r of supa) {
    const q = async (sql: string) => (await boss.query(`select * from (${sql}) t(h)`, [r])).rows[0].h as boolean;
    if (await q("select has_table_privilege($1, 'public.late_table', 'select,insert,update,delete')")) bad.push(`${r}: table`);
    if (await q("select has_any_column_privilege($1, 'public.late_table', 'select,insert,update')")) bad.push(`${r}: column`);
    if (await q("select has_sequence_privilege($1, 'public.late_table_id_seq', 'usage,select,update')")) bad.push(`${r}: sequence`);
    if (await q("select has_function_privilege($1, 'public.late_fn()', 'execute')")) bad.push(`${r}: function`);
  }
  expect(bad.join(", ") || "nothing").toBe("nothing");
});

it("worst case: the objects the migrations made are still unreachable by anon, authenticated and service_role", async () => {
  const r = await boss.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace, unnest($1::text[]) role
     where n.nspname in ('public','private') and c.relkind in ('r','v','m','p') and c.relname <> 'late_table'
       and has_any_column_privilege(role, c.oid, 'select,insert,update,references') limit 5`,
    [supa],
  );
  expect(r.rows.map((x) => x.relname).join(", ") || "nothing").toBe("nothing");
});
