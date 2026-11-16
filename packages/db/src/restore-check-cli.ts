// The restore check (step 15, decisions #115 and #126): proves a backup can really be restored. Run from the repo root against an EMPTY throwaway
// server (a fresh container of the Supabase image, never a real database), by .github/workflows/restore-check.yml or by hand:
//   RESTORE_ADMIN_URL=postgres://postgres:...@127.0.0.1:5432/postgres node packages/db/src/restore-check-cli.ts --dump db-X.dump --manifest db-X.json [--any-age] [--keep]
// It checks the manifest and the dump's size and SHA-256, creates the roles and a fresh database, runs pg_restore --exit-on-error, then compares
// every table's row count with the manifest (cro_company: 0, its rows are not in the dump) and the recorded migrations with the repo's files.
// One line per check, then "restore check passed" (exit 0) or the first failure (exit 1). --any-age skips the 48 hour rule (a first proof against an
// older file); --keep leaves the restored database in place. Calls no AWS: the workflow downloads the files. PG_TOOLS_PREFIX as in backup-cli.ts.
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { basename } from "node:path";
import pg from "pg";
import { connOf, conninfo, countTables, FORMAT, NO_DATA, type Manifest, tool } from "./backup-cli.ts";
import { sslOptions } from "./ssl.ts";

export const MAX_AGE_HOURS = 48;
export const APP_ROLES = ["portal_owner", "app_candidate", "app_portal", "app_admin", "app_fetcher", "app_backup"];
const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isHash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

// The manifest as a typed value, or an Error saying what is wrong. Nothing in it is ever run as SQL or used as a path: names are only compared.
export function parseManifest(text: string): Manifest {
  let m: Manifest;
  try { m = JSON.parse(text); } catch { throw new Error("the manifest is not valid JSON"); }
  if (!m || typeof m !== "object") throw new Error("the manifest is not an object");
  if (m.format !== FORMAT) throw new Error(`the manifest format is ${JSON.stringify(m.format)}, this tool reads ${FORMAT}`);
  if (typeof m.createdAt !== "string" || Number.isNaN(Date.parse(m.createdAt))) throw new Error("the manifest has no valid createdAt");
  if (!Array.isArray(m.tables) || !m.tables.every((t) => t && typeof t.name === "string" && isInt(t.rows) && typeof t.data === "boolean")) throw new Error("the manifest tables are malformed");
  if (!Array.isArray(m.migrations) || !m.migrations.every(isHash)) throw new Error("the manifest migrations are malformed");
  const d = m.dump;
  if (!d || !/^db-\d{8}T\d{4}Z\.dump$/.test(d.file) || !isInt(d.bytes) || !isHash(d.sha256)) throw new Error("the manifest dump entry is malformed");
  return m;
}

// Each returns a list of problems, empty when fine.
export function ageProblems(m: Manifest, now: Date, maxHours: number | null): string[] {
  if (maxHours === null) return [];
  const hours = (now.getTime() - Date.parse(m.createdAt)) / 36e5;
  return hours >= maxHours || hours < -0.1 ? [`the backup is ${hours.toFixed(1)} hours old, the limit is ${maxHours}`] : [];
}
export function fileProblems(m: Manifest, name: string, bytes: number, sha256: string): string[] {
  const p: string[] = [];
  if (name !== m.dump.file) p.push(`the dump is named ${JSON.stringify(name)}, the manifest names ${JSON.stringify(m.dump.file)}`);
  if (bytes !== m.dump.bytes) p.push(`size ${bytes}, the manifest says ${m.dump.bytes}`);
  if (sha256 !== m.dump.sha256) p.push("SHA-256 differs from the manifest");
  return p;
}
export function countProblems(m: Manifest, restored: { name: string; rows: number }[]): string[] {
  const have = new Map(restored.map((t) => [t.name, t.rows]));
  const p: string[] = [];
  for (const t of m.tables) {
    const want = t.data ? t.rows : 0; // rows left out of the dump come back empty
    if (!have.has(t.name)) p.push(`table ${JSON.stringify(t.name)} is missing after the restore`);
    else if (have.get(t.name) !== want) p.push(`table ${JSON.stringify(t.name)}: ${have.get(t.name)} rows, the manifest says ${want}`);
    have.delete(t.name);
  }
  for (const name of have.keys()) p.push(`table ${JSON.stringify(name)} is not in the manifest`);
  for (const name of NO_DATA) if (m.tables.some((t) => t.name === name && t.data)) p.push(`${name} must be marked as data not included`);
  return p;
}
// The restored migrations must be what the manifest recorded, and the manifest's must be the repo's first ones (the live database may be a few migrations behind the repo, never ahead or different).
export function migrationProblems(m: Manifest, restored: string[], repo: string[]): string[] {
  const p: string[] = [];
  if (restored.join() !== m.migrations.join()) p.push(`${restored.length} migrations restored, ${m.migrations.length} in the manifest, or their hashes differ`);
  const bad = m.migrations.findIndex((h, i) => h !== repo[i]);
  if (m.migrations.length > repo.length) p.push(`the backup has ${m.migrations.length} migrations, the repo only ${repo.length}`);
  else if (bad >= 0) p.push(`migration ${bad} differs from the repo's file`);
  return p;
}

// drizzle records the SHA-256 of each migration file's text.
export function repoMigrationHashes(dir = new URL("../migrations/", import.meta.url)): string[] {
  const entries: { tag: string }[] = JSON.parse(readFileSync(new URL("meta/_journal.json", dir), "utf8")).entries;
  return entries.map((e) => createHash("sha256").update(readFileSync(new URL(`${e.tag}.sql`, dir), "utf8")).digest("hex"));
}

async function sha256Of(file: string) {
  const h = createHash("sha256");
  let bytes = 0;
  for await (const c of createReadStream(file)) { h.update(c); bytes += (c as Buffer).length; }
  return { bytes, sha256: h.digest("hex") };
}
const urlFor = (url: string, database: string) => { const u = new URL(url); u.pathname = `/${database}`; return u.toString(); };

export type CheckOptions = {
  adminUrl: string; dump: string; manifest: string; env: NodeJS.ProcessEnv; log: (line: string) => void;
  now?: Date; maxAgeHours?: number | null; keep?: boolean; repoHashes?: string[];
};

export async function runRestoreCheck(o: CheckOptions): Promise<boolean> {
  const fail = (name: string, problems: string[]) => (o.log(`FAIL ${name}: ${problems.join("; ")}`), false);
  const ok = (name: string, detail: string) => (o.log(`ok   ${name}: ${detail}`), true);

  let m: Manifest;
  try { m = parseManifest(readFileSync(o.manifest, "utf8")); } catch (e) { return fail("manifest", [(e as Error).message]); }
  ok("manifest", `format ${m.format}, ${m.tables.length} tables, ${m.migrations.length} migrations`);
  const age = ageProblems(m, o.now ?? new Date(), o.maxAgeHours === undefined ? MAX_AGE_HOURS : o.maxAgeHours);
  if (age.length) return fail("age", age);
  ok("age", o.maxAgeHours === null ? "not checked" : `under ${o.maxAgeHours ?? MAX_AGE_HOURS} hours`);
  let file: { bytes: number; sha256: string };
  try { file = await sha256Of(o.dump); } catch { return fail("dump file", ["cannot read it"]); }
  const fp = fileProblems(m, basename(o.dump), file.bytes, file.sha256);
  if (fp.length) return fail("dump file", fp);
  ok("dump file", `${file.bytes} bytes, SHA-256 matches`);

  const admin = new pg.Client({ connectionString: o.adminUrl, ssl: sslOptions(o.env) });
  const dbName = `restore_check_${randomBytes(4).toString("hex")}`; // hex only: safe to put in SQL
  let created = false;
  try {
    await admin.connect();
    for (const r of APP_ROLES)
      if (!(await admin.query("select from pg_roles where rolname = $1", [r])).rowCount) await admin.query(`create role ${admin.escapeIdentifier(r)} login`);
    await admin.query(`create database ${dbName}`);
    created = true;
    const target = new pg.Client({ connectionString: urlFor(o.adminUrl, dbName), ssl: sslOptions(o.env) });
    await target.connect();
    // The dump creates public itself, so the new database's empty one goes. It holds only public, private and drizzle; the trigram indexes need
    // the extension, which lives in its own schema (0000_roles.sql).
    await target.query("drop schema public; create schema if not exists extensions; create extension if not exists pg_trgm with schema extensions");
    await target.end();

    const conn = connOf(o.adminUrl, o.env, dbName, undefined);
    const restore = tool(o.env, conn, "pg_restore", ["--exit-on-error", "--no-owner", "--dbname", conninfo(conn)]);
    createReadStream(o.dump).pipe(restore.p.stdin);
    const code = await restore.done;
    if (code !== 0) return fail("restore", [`pg_restore exit ${code}: ${restore.err().trim().slice(0, 500)}`]);
    ok("restore", "pg_restore --exit-on-error finished with no errors");

    const check = new pg.Client({ connectionString: urlFor(o.adminUrl, dbName), ssl: sslOptions(o.env) });
    await check.connect();
    try {
      const cp = countProblems(m, await countTables(check));
      if (cp.length) return fail("row counts", cp.slice(0, 10));
      ok("row counts", `${m.tables.length} tables equal the manifest (${NO_DATA.join(", ")}: 0)`);
      const restored = (await check.query("select hash from drizzle.__drizzle_migrations order by id")).rows.map((r) => r.hash as string);
      const mp = migrationProblems(m, restored, o.repoHashes ?? repoMigrationHashes());
      if (mp.length) return fail("migrations", mp);
      ok("migrations", `${restored.length} recorded, hashes equal the repo's files`);
    } finally {
      await check.end();
    }
    o.log("restore check passed");
    return true;
  } catch (e) {
    return fail("restore", [(e as Error).message.split(o.adminUrl).join("***").slice(0, 300)]);
  } finally {
    if (created && !o.keep) await admin.query(`drop database ${dbName} with (force)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  const a = [...argv];
  const take = (flag: string) => { const i = a.indexOf(flag); if (i < 0) return undefined; const [, v] = a.splice(i, 2); return v; };
  const anyAge = a.includes("--any-age") && !!a.splice(a.indexOf("--any-age"), 1);
  const keep = a.includes("--keep") && !!a.splice(a.indexOf("--keep"), 1);
  const dump = take("--dump");
  const manifest = take("--manifest");
  if (!dump || !manifest || a.length) return log("usage: restore-check-cli.ts --dump FILE --manifest FILE [--any-age] [--keep]"), 2;
  if (!env.RESTORE_ADMIN_URL) return log("RESTORE_ADMIN_URL is not set (postgres on an empty throwaway server)"), 2;
  return (await runRestoreCheck({ adminUrl: env.RESTORE_ADMIN_URL, dump, manifest, env, log, keep, maxAgeHours: anyAge ? null : MAX_AGE_HOURS })) ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
