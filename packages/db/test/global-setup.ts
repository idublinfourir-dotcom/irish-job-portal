// Runs once before the database tests: builds the template database from the migrations.
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { ROLES, TEMPLATE, testPassword, urlFor } from "./db";

export default async function setup() {
  const admin = new pg.Client({ connectionString: urlFor("postgres") });
  try {
    await admin.connect();
  } catch {
    throw new Error("The test database is not running. Start it with: npm run db:test:up");
  }

  // Remove the template and any copies left by a crashed run.
  const old = await admin.query<{ datname: string }>(
    "select datname from pg_database where datname = $1 or datname like 'portal\\_test\\_%'",
    [TEMPLATE],
  );
  for (const { datname } of old.rows) await admin.query(`drop database "${datname}" with (force)`);
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
  await pool.end(); // a template cannot be copied while anyone is connected

  // Roles belong to the whole server, not one database, so their passwords are set here once.
  // Only roles the migrations made, so a missing role fails its own test, not the whole run.
  const made = await admin.query<{ rolname: string }>("select rolname from pg_roles where rolname = any($1)", [[...ROLES]]);
  for (const { rolname } of made.rows)
    await admin.query(`alter role ${rolname} password ${admin.escapeLiteral(testPassword())}`);
  await admin.end();
}
