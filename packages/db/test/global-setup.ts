// Runs once before the database tests: builds the template database from the migrations.
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { RUN, ROLES, TEMPLATE, testPassword, urlFor } from "./db";

export default async function setup() {
  const admin = new pg.Client({ connectionString: urlFor("postgres") });
  try {
    await admin.connect();
  } catch {
    throw new Error("The test database is not running. Start it with: npm run db:test:up");
  }

  // The migrations create server-wide roles, so only one run builds its template at a time.
  await admin.query("select pg_advisory_lock(4242)");
  await admin.query(`create database ${TEMPLATE}`);

  const pool = new pg.Pool({ connectionString: urlFor(TEMPLATE), max: 1 });
  // The new database starts empty, but Supabase's own database has these defaults: anon, authenticated and
  // service_role get every right on whatever postgres creates in public. Copied here so the tests meet the worst case.
  await pool.query(`
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`);
  await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  // Mutation run (test/mutation/run.mjs): the SQL in this variable removes one rule from the template. Unset in normal runs.
  if (process.env.PORTAL_TEST_MUTATION) await pool.query(process.env.PORTAL_TEST_MUTATION);
  await pool.end(); // a template cannot be copied while anyone is connected

  // Roles belong to the whole server, not one database, so their passwords are set here once.
  // Only roles the migrations made, so a missing role fails its own test, not the whole run.
  const made = await admin.query<{ rolname: string }>("select rolname from pg_roles where rolname = any($1)", [[...ROLES]]);
  for (const { rolname } of made.rows)
    await admin.query(`alter role ${rolname} password ${admin.escapeLiteral(testPassword())}`);
  await admin.query("select pg_advisory_unlock(4242)");
  await admin.end();

  // Teardown: drop only this run's template and copies.
  return async () => {
    const c = new pg.Client({ connectionString: urlFor("postgres") });
    await c.connect();
    const mine = await c.query<{ datname: string }>("select datname from pg_database where datname = $1 or datname like $2", [TEMPLATE, `portal\\_test\\_${RUN}\\_%`]);
    for (const { datname } of mine.rows) await c.query(`drop database "${datname}" with (force)`);
    await c.end();
  };
}
