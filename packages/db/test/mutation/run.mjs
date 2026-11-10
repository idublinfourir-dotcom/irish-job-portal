// Mutation run: removes one database rule at a time from a freshly built test database, runs the database
// tests, and records whether any test noticed. One JSON line per mutation, written as it goes, so a stopped run
// resumes where it left off.
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:54331/postgres node run.mjs [--class A,B] [--limit N]
// Results go to MUTATION_RESULTS (default results.jsonl next to this file). Print the table: node summary.mjs FILE
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const root = here("../../../../");
const resultsFile = process.env.MUTATION_RESULTS ?? here("results.jsonl");
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const only = process.argv.includes("--class") ? arg("--class").split(",") : ["A", "B", "C", "D"];
// --shard I/N: this process takes every Nth mutation, so several processes, each with its own database server, share one list and one results file
const [shard, shards] = process.argv.includes("--shard") ? arg("--shard").split("/").map(Number) : [0, 1];
const limit = process.argv.includes("--limit") ? Number(arg("--limit")) : Infinity;
const WORKERS = process.env.MUTATION_WORKERS ?? "6"; // about 6 of the 12 cores

// Never default to the shared test database on 54329: a long run there would slow every other agent.
if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to your own database server (not the shared one).");
const url = (db) => { const u = new URL(process.env.TEST_DATABASE_URL); u.pathname = `/${db}`; return u.href; };

// ---- 1. the list of mutations, read from the catalog of a freshly built database ----
const CATALOG = "portal_mutation_catalog";
const OWNER = "set role portal_owner; ";
const q = (s) => s.replaceAll('"', '""');
const rel = (schema, name) => `"${q(schema)}"."${q(name)}"`;
const RIGHTS = ["select", "insert", "update", "delete", "truncate", "references", "trigger"];
const ROLES_D = ["app_candidate", "app_portal", "app_fetcher"];

async function buildCatalog() {
  const admin = new pg.Client({ connectionString: url("postgres") });
  await admin.connect();
  await admin.query(`drop database if exists ${CATALOG} with (force)`);
  await admin.query(`create database ${CATALOG}`);
  const pool = new pg.Pool({ connectionString: url(CATALOG), max: 1 });
  // Same prelude as global-setup.ts: Supabase's default privileges, then the migrations.
  await pool.query(`
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`);
  await migrate(drizzle(pool), { migrationsFolder: here("../../migrations") });
  const rows = async (sql) => (await pool.query(sql)).rows;

  const muts = [];
  const add = (cls, object, sql, skip) => muts.push({ class: cls, id: `${cls}:${object}`, object, sql: skip ? "" : OWNER + sql, ...(skip && { skip }) });

  for (const r of await rows(`select t.tgname, n.nspname, c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname = 'public' order by 2, 3, 1`))
    add("A", `trigger ${r.tgname} on ${r.relname}`, `drop trigger "${q(r.tgname)}" on ${rel(r.nspname, r.relname)};`);

  for (const r of await rows(`select k.conname, n.nspname, c.relname from pg_constraint k join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace where k.contype = 'c' and n.nspname = 'public' order by 2, 3, 1`))
    add("B", `check ${r.conname} on ${r.relname}`, `alter table ${rel(r.nspname, r.relname)} drop constraint "${q(r.conname)}";`);

  for (const r of await rows(`select ic.relname as idx, c.relname, n.nspname,
        (select k.conname from pg_constraint k where k.conindid = i.indexrelid and k.contype = 'u') as uq,
        exists (select 1 from pg_constraint k where k.conindid = i.indexrelid and k.contype = 'f') as fk_needs_it
      from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class c on c.oid = i.indrelid
      join pg_namespace n on n.oid = c.relnamespace
      where i.indisunique and not i.indisprimary and n.nspname = 'public' order by 3, 2, 1`)) {
    const object = `unique ${r.idx} on ${r.relname}`;
    if (r.fk_needs_it) add("C", object, "", "a foreign key depends on it");
    else if (r.uq) add("C", object, `alter table ${rel(r.nspname, r.relname)} drop constraint "${q(r.uq)}";`);
    else add("C", object, `drop index ${rel(r.nspname, r.idx)};`);
  }

  // D: only where the role does not already hold every right on the table or view.
  const checks = (role) => RIGHTS.map((p) => `has_table_privilege('${role}', c.oid, '${p}')`).join(" and ");
  for (const role of ROLES_D)
    for (const r of await rows(`select c.relname, n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'v', 'p') and not (${checks(role)}) order by 1`))
      add("D", `grant all on ${r.relname} to ${role}`, `grant all on table ${rel(r.nspname, r.relname)} to ${role};`);

  await pool.end();
  await admin.query(`drop database ${CATALOG} with (force)`);
  await admin.end();
  return muts;
}

// ---- 2. one run of the database tests ----
// A failure that is only a timeout or a lost connection does not count as a test noticing the missing rule.
const INFRA = /timed? ?out|ECONNRESET|ECONNREFUSED|terminating connection|too many clients|Connection terminated|EPIPE/i;

function runTests(mutationSql) {
  const out = join(tmpdir(), `mutation-vitest-${process.pid}.json`);
  rmSync(out, { force: true });
  // rules-snapshot.test.ts is left out too: it notices every removal, so with it in the run every rule would count as caught
  // and the script could no longer show which rules lack a behaviour test.
  const args = ["vitest", "run", "--project", "db", "--exclude", "**/schema.test.ts", "--exclude", "**/rules-snapshot.test.ts", "--exclude", "**/mutation/**",
    `--maxWorkers=${WORKERS}`, "--reporter=json", `--outputFile=${out}`];
  if (mutationSql) args.push("--bail=1"); // a caught mutation is known at the first failing test, so `failed` is a floor, not a count
  const env = { ...process.env };
  delete env.PORTAL_TEST_RUN;
  if (mutationSql) env.PORTAL_TEST_MUTATION = mutationSql; else delete env.PORTAL_TEST_MUTATION;
  return new Promise((resolve) => {
    execFile("npx", args, { cwd: root, env, timeout: 600_000, maxBuffer: 1 << 26 }, () => {
      try {
        const j = JSON.parse(readFileSync(out, "utf8"));
        const failures = [];
        for (const f of j.testResults) {
          if (f.assertionResults.length === 0 && f.status === "failed") failures.push({ name: `(file) ${f.name.split("/").pop()}`, msg: f.message ?? "" });
          for (const t of f.assertionResults)
            if (t.status === "failed") failures.push({ name: t.fullName, msg: (t.failureMessages ?? []).join("\n") });
        }
        resolve({ total: j.numTotalTests, passed: j.numPassedTests, failures });
      } catch {
        resolve({ total: 0, passed: 0, failures: [] }); // no readable report: the run did not happen
      }
    });
  });
}

async function cleanLeftovers() { // a killed run cannot drop its own databases; this server is ours alone
  const admin = new pg.Client({ connectionString: url("postgres") });
  await admin.connect();
  const { rows } = await admin.query("select datname from pg_database where datname like 'portal\\_test\\_%' or datname like 'portal\\_template\\_%'");
  for (const { datname } of rows) await admin.query(`drop database "${datname}" with (force)`);
  await admin.end();
}

let baseline = 0;
async function measure(sql) {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const r = await runTests(sql);
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    // only the error line itself: every assertion's stack trace has a vitest frame named runWithTimeout
    const real = r.failures.filter((f) => !INFRA.test(f.msg.split("\n")[0]));
    const healthy = r.total === baseline && r.failures.length === r.total - r.passed; // every test ran
    const out = { failed: r.failures.length, tests: real.slice(0, 3).map((f) => f.name), seconds, attempts: attempt + 1 };
    if (real.length > 0) return { result: "caught", ...out };
    if (r.failures.length === 0 && healthy) return { result: "survived", ...out };
    await cleanLeftovers();
    if (attempt === 1) return { result: "error", ...out, reason: r.total === 0 ? "no report" : `total ${r.total} of ${baseline}, ${r.failures.length} infra failures` };
  }
}

// ---- 3. main ----
const done = new Set(existsSync(resultsFile) ? readFileSync(resultsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => r.id ?? r.kind) : []);
const save = (row) => appendFileSync(resultsFile, JSON.stringify(row) + "\n");

await cleanLeftovers();
const t0 = Date.now();
const base = await runTests(null);
if (base.failures.length > 0 || base.total === 0) throw new Error(`Baseline is not clean: ${base.failures.length} failed of ${base.total}`);
baseline = base.total;
console.log(`baseline: ${base.passed} tests passed`);
if (!done.has("baseline")) save({ kind: "baseline", result: "passed", tests: base.total });

const list = (await buildCatalog()).filter((m) => only.includes(m.class)).filter((_, i) => i % shards === shard);
console.log(`${list.length} mutations in the list, ${done.size} already done`);
let n = 0;
for (const m of list) {
  if (done.has(m.id)) continue;
  if (n++ >= limit) break;
  const row = m.skip ? { ...m, result: "skipped", failed: 0, tests: [], seconds: 0 } : { ...m, ...(await measure(m.sql)) };
  save(row);
  console.log(`${m.id} -> ${row.result}${row.failed ? ` (${row.failed} failed)` : ""} ${row.seconds}s`);
}
console.log(`wall time ${Math.round((Date.now() - t0) / 1000)}s`);
