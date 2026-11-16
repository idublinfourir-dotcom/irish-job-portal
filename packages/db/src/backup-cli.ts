// The daily backup (step 15, decisions #115 and #126). Run from the repo root with the app_backup login, by .github/workflows/backup.yml:
//   BACKUP_DATABASE_URL=... DATABASE_CA_CERT=... node packages/db/src/backup-cli.ts OUT_DIR
// It exports one snapshot, counts every table of public, private and drizzle inside it, and keeps that transaction open while pg_dump dumps the
// same snapshot, so the counts in the manifest and the dump are the same moment. The rows of public.cro_company are left out (88 MB, re-imported
// weekly from the register; its table definition stays). It writes OUT_DIR/db-<UTC yyyymmddThhmmZ>.dump and the .json manifest, and calls no AWS:
// the workflow uploads. Prints only file names, counts and sizes, never the address. Exit 1 on any failure.
// PG_TOOLS_PREFIX / PG_TOOLS_ADDR: run pg_dump somewhere else (the tests run it inside the database container: the prefix is the command
// that does it, it must pass PGPASSWORD through, and the address is where the server is seen from there).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { sslOptions } from "./ssl.ts";

export const FORMAT = 1;
export const SCHEMAS = ["public", "private", "drizzle"];
export const NO_DATA = ["public.cro_company"];

export type Count = { name: string; rows: number; data: boolean };
export type Manifest = {
  format: number; createdAt: string; serverVersion: string; pgDumpVersion: string; schemas: string[];
  tables: Count[]; migrations: string[]; dump: { file: string; bytes: number; sha256: string };
};

// 20261116T1230Z: sorts in time order, so the newest backup is the last name.
export const stamp = (d: Date) => `${d.toISOString().slice(0, 16).replace(/[-:]/g, "")}Z`;

// One statement: the row count of every table, in the transaction's snapshot. query_to_xml runs the count inside the database.
export async function countTables(db: Pick<pg.ClientBase, "query">): Promise<{ name: string; rows: number }[]> {
  const { rows } = await db.query(
    `select n.nspname || '.' || c.relname as name,
            (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint as rows
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and c.relkind in ('r', 'p') and not c.relispartition
      order by 1`,
    [SCHEMAS],
  );
  return rows.map((r) => ({ name: r.name, rows: Number(r.rows) }));
}

export type Conn = { host: string; port: string; user: string; password: string; database: string; sslmode: string; sslrootcert?: string };

// Where pg_dump and pg_restore connect: the URL's server (or PG_TOOLS_ADDR), TLS verified unless a local database opts out.
export function connOf(url: string, env: NodeJS.ProcessEnv, database?: string, certFile?: string): Conn {
  const u = new URL(url);
  const [host, port] = env.PG_TOOLS_ADDR ? env.PG_TOOLS_ADDR.split(":") : [u.hostname, u.port || "5432"];
  const off = env.DATABASE_SSL === "disable";
  return {
    host: host!, port: port!, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: database ?? decodeURIComponent(u.pathname.slice(1)), sslmode: off ? "disable" : "verify-full", sslrootcert: off ? undefined : certFile,
  };
}
const quote = (v: string) => `'${v.replace(/[\\']/g, "\\$&")}'`;
// The password is not in it: it goes through PGPASSWORD, never on a command line.
export const conninfo = (c: Conn) =>
  Object.entries({ host: c.host, port: c.port, user: c.user, dbname: c.database, sslmode: c.sslmode, sslrootcert: c.sslrootcert })
    .filter(([, v]) => v).map(([k, v]) => `${k}=${quote(v!)}`).join(" ");

export function tool(env: NodeJS.ProcessEnv, c: Conn, name: string, args: string[]) {
  const [cmd, ...rest] = [...(env.PG_TOOLS_PREFIX ?? "").split(/\s+/).filter(Boolean), name, ...args];
  const p = spawn(cmd!, rest, { env: { ...env, PGPASSWORD: c.password }, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  p.stdin.on("error", () => {}); // the tool may quit before it reads everything: its exit code says why
  const done = new Promise<number>((res, rej) => (p.on("error", rej), p.on("close", (code) => res(code ?? 1))));
  return { p, done, err: () => err };
}

// An error text with the server's address and password taken out, safe for a run log.
export const scrub = (text: string, ...secrets: (string | undefined)[]) =>
  secrets.filter((s): s is string => !!s).reduce((t, s) => t.split(s).join("***"), text);

export async function runBackup(o: { url: string; env: NodeJS.ProcessEnv; out: string; now?: Date; afterSnapshot?: () => Promise<void> }) {
  const now = o.now ?? new Date();
  const base = `db-${stamp(now)}`;
  const dumpPath = join(o.out, `${base}.dump`);
  const work = await mkdtemp(join(tmpdir(), "backup-"));
  const client = new pg.Client({ connectionString: o.url, ssl: sslOptions(o.env) });
  try {
    let cert: string | undefined;
    if (o.env.DATABASE_SSL !== "disable" && o.env.DATABASE_CA_CERT) {
      cert = join(work, "ca.crt");
      await writeFile(cert, o.env.DATABASE_CA_CERT.replace(/\\n/g, "\n"));
    }
    const conn = connOf(o.url, o.env, undefined, cert);
    const ver = tool(o.env, conn, "pg_dump", ["--version"]);
    let pgDumpVersion = "";
    ver.p.stdout.on("data", (d) => (pgDumpVersion += d));
    if ((await ver.done) !== 0) throw new Error("pg_dump is not available");

    await client.connect();
    await client.query("begin isolation level repeatable read, read only");
    const snapshot = (await client.query("select pg_export_snapshot() as id")).rows[0].id as string;
    const serverVersion = (await client.query("show server_version")).rows[0].server_version as string;
    const counts = await countTables(client);
    const migrations = (await client.query("select hash from drizzle.__drizzle_migrations order by id")).rows.map((r) => r.hash as string);
    await o.afterSnapshot?.();

    const dump = tool(o.env, conn, "pg_dump", [
      `--snapshot=${snapshot}`, "--format=custom", ...SCHEMAS.flatMap((s) => ["-n", s]), ...NO_DATA.map((t) => `--exclude-table-data=${t}`), "--dbname", conninfo(conn),
    ]);
    const hash = createHash("sha256");
    let bytes = 0;
    dump.p.stdout.on("data", (d: Buffer) => (hash.update(d), (bytes += d.length)));
    const written = pipeline(dump.p.stdout, createWriteStream(dumpPath));
    const [code] = await Promise.all([dump.done, written]);
    if (code !== 0) throw new Error(`pg_dump failed (exit ${code}): ${dump.err().trim().slice(0, 500)}`);
    await client.query("commit");

    const manifest: Manifest = {
      format: FORMAT, createdAt: now.toISOString(), serverVersion, pgDumpVersion: pgDumpVersion.trim(), schemas: SCHEMAS,
      tables: counts.map((c) => ({ ...c, data: !NO_DATA.includes(c.name) })), migrations,
      dump: { file: `${base}.dump`, bytes, sha256: hash.digest("hex") },
    };
    const manifestPath = join(o.out, `${base}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return { dumpPath, manifestPath, manifest };
  } catch (e) {
    await unlink(dumpPath).catch(() => {});
    throw e;
  } finally {
    await client.end().catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  const url = env.BACKUP_DATABASE_URL;
  if (argv.length !== 1) return log("usage: backup-cli.ts OUT_DIR"), 2;
  if (!url) return log("BACKUP_DATABASE_URL is not set (the app_backup login)"), 2;
  try {
    const r = await runBackup({ url, env, out: argv[0]! });
    const m = r.manifest;
    log(`${m.dump.file}: ${m.dump.bytes} bytes, sha256 ${m.dump.sha256.slice(0, 12)}`);
    log(`${m.tables.length} tables, ${m.tables.reduce((n, t) => n + t.rows, 0)} rows counted, ${m.migrations.length} migrations, server ${m.serverVersion}, ${m.pgDumpVersion}`);
    log(`manifest ${r.manifestPath.split("/").pop()}`);
    return 0;
  } catch (e) {
    const u = URL.canParse(url) ? new URL(url) : undefined;
    log(`backup failed: ${scrub((e as Error).message, u?.hostname, u && decodeURIComponent(u.password), u?.password, u?.username)}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
