// npm run db:pull: rebuilds src/schema from the migrations. Needs the test database (npm run db:test:up).
// Builds a scratch database from the migrations, runs drizzle-kit pull on it, and makes the two changes
// drizzle-kit 0.31 cannot make itself. If its output changes shape, this stops with a message instead of guessing.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const url = (db) => { const u = new URL(process.env.TEST_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:54329/postgres"); u.pathname = `/${db}`; return u.href; };
const name = `portal_pull_${process.pid}`;
const out = mkdtempSync(join(tmpdir(), "portal-pull-"));
const admin = new pg.Client({ connectionString: url("postgres") });
await admin.connect();
try {
  // Same lock as global-setup.ts: the migrations create server-wide roles, so one build at a time.
  await admin.query("select pg_advisory_lock(4242)");
  await admin.query(`create database ${name}`);
  const pool = new pg.Pool({ connectionString: url(name), max: 1 });
  await migrate(drizzle(pool), { migrationsFolder: here("../migrations") });
  await pool.end();
  await admin.query("select pg_advisory_unlock(4242)");
  execFileSync("npx", ["drizzle-kit", "pull", "--dialect", "postgresql", "--url", url(name), "--out", out, "--schemaFilters", "public"], { cwd: here(".."), stdio: "inherit" });

  let s = readFileSync(join(out, "schema.ts"), "utf8");
  const fix = (from, to) => {
    if (s.split(from).length !== 2) throw new Error(`pull-schema: expected "${from.trim().slice(0, 70)}" exactly once; drizzle-kit output changed, update test/pull-schema.mjs`);
    s = s.replace(from, to);
  };
  // 1. drizzle-kit cannot read tsvector, so the type is declared here.
  fix("import { pgTable,", "import { customType, pgTable,");
  fix('import { sql } from "drizzle-orm"\n', 'import { sql } from "drizzle-orm"\n\n// drizzle-kit cannot read tsvector, so it is declared here\nconst tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });\n');
  fix("\t// TODO: failed to parse database type 'tsvector'\n", "");
  fix('unknown("search_vector")', 'tsvector("search_vector")');
  // 2. job and report point at each other; the pulled foreignKey makes a type cycle, a typed lazy reference does not.
  fix('\tforeignKey({\n\t\t\tcolumns: [table.hiddenReportId],\n\t\t\tforeignColumns: [report.id],\n\t\t\tname: "job_hidden_report_fkey"\n\t\t}).onDelete("set null"),\n', "");
  fix('\thiddenReportId: bigint("hidden_report_id", { mode: "number" }),\n', '\t// job and report point at each other; a typed lazy reference here (instead of the pulled foreignKey) breaks the type cycle\n\thiddenReportId: bigint("hidden_report_id", { mode: "number" }).references((): AnyPgColumn => report.id, { onDelete: "set null" }),\n');

  const header = "// Made by npm run db:pull (packages/db/test/pull-schema.mjs) from a database built by packages/db/migrations.\n// Do not edit by hand: change a migration, then run npm run db:pull. schema.test.ts fails until the two match.\n";
  writeFileSync(here("../src/schema/schema.ts"), `${header}${s.trimEnd()}\n`);
  writeFileSync(here("../src/schema/relations.ts"), `${header}${readFileSync(join(out, "relations.ts"), "utf8").trimEnd()}\n`);
  console.log("src/schema/schema.ts and relations.ts written");
} finally {
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
  rmSync(out, { recursive: true, force: true });
}
