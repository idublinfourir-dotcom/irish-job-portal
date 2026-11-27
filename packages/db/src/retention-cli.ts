// The daily retention run: applies the periods in `setting` by calling private.run_retention (0002_functions.sql), which does ONE rule per call
// and says `rule: null` when nothing is due. Run from the repo root with the app_admin login, as the last step of .github/workflows/daily-fetch.yml:
//   RETENTION_ADMIN_DATABASE_URL=... node packages/db/src/retention-cli.ts
// One line per call and a total. Every stored file a call returns (storage_keys) is removed from the file store (FILES_S3_*, read only when there is
// one to remove) and counted. Exit 1 (red run) when: a removal failed (counts only, never a key: the run log of a public repo is public; the row is
// already gone, so the weekly sweep below removes the file), the call cap was reached, a rule made no progress (it would repeat for ever), or the
// database refused.
//
// The orphan sweep (audit OPS-3), weekly from .github/workflows/weekly-registers.yml, with the read-only app_backup login (it reads every key column,
// application.cv_storage_key included, which app_admin cannot) and the files key (list and delete on the files bucket):
//   SWEEP_BACKUP_DATABASE_URL=... FILES_S3_...=... node packages/db/src/retention-cli.ts sweep
// It lists each prefix, keeps every key written in the last 24 hours (an upload stores the object before its row), asks the database which of the
// older keys a row still names, and removes the rest. A failed listing or query removes nothing. More than SWEEP_MAX orphans, or more than
// SWEEP_FEW that are over half the older files, is refused (a wrong database looks like every file is an orphan; the bucket has no versioning).
// Counts only in the log.
import pg from "pg";
import { fileStore, type FileStore } from "./file-store.ts";
import { sslOptions } from "./ssl.ts";

export const BATCH = 1000;
export const MAX_CALLS = 200;

type Step = { rule: string | null; target?: string | null; done: number; left: number; skipped: unknown[]; storage_keys: string[] };

export async function drain(db: Pick<pg.ClientBase, "query">, log: (line: string) => void, batch = BATCH, maxCalls = MAX_CALLS, store: () => FileStore = fileStore): Promise<number> {
  let total = 0;
  const keys: string[] = [];
  let problem = "";
  for (let call = 1; ; call++) {
    if (call > maxCalls) { problem = `stopped at the cap of ${maxCalls} calls, more is due`; break; }
    const s: Step = (await db.query("select private.run_retention($1::integer) r", [batch])).rows[0].r;
    if (s.rule === null) break;
    log(`${s.rule}${s.target ? ` (${s.target})` : ""}: ${s.done} done, ${s.left} left, ${s.skipped.length} skipped`);
    total += s.done;
    keys.push(...s.storage_keys);
    if (s.done === 0) { problem = `${s.rule} made no progress: stopped`; break; }
  }
  log(`retention: ${total} rows handled`);
  const failed: string[] = [];
  let why = "";
  for (const k of keys) {
    try { await store().remove(k); } catch (e) { failed.push(k); why ||= (e as Error).message; }
  }
  if (keys.length) log(`stored files: ${keys.length - failed.length} removed, ${failed.length} failed`);
  if (failed.length) log(`not removed (${why}): ${failed.length} files, the weekly orphan sweep removes them`);
  if (problem) log(problem);
  return failed.length || problem ? 1 : 0;
}

// ===== the orphan sweep =====
// rules/ is never swept: a rules evidence id lives in the rules data (jsonb), not in a key column.
export const SWEEP_PREFIXES = ["cv/", "case/", "authority/", "logo/", "sponsor/", "evidence/"] as const;
export const SWEEP_AGE_MS = 24 * 60 * 60_000;
export const SWEEP_MAX = 200;
export const SWEEP_FEW = 5;
// Every column that names a stored file. A sponsor confirmation sits in its approval request (change->>'key') while it waits, so every request's key counts.
export const REFERENCED =
  "select k from (select storage_key k from candidate_cv union all select cv_storage_key from application union all select storage_key from case_document " +
  "union all select storage_key from job_authority_document union all select logo_key from organisation union all select confirmation_file_key from sponsorship_statement " +
  "union all select change->>'key' from approval_request union all select evidence_storage_key from report union all select evidence_storage_key from strike) t " +
  "where k = any($1::text[])";

export async function sweep(db: Pick<pg.ClientBase, "query">, log: (line: string) => void, store: () => FileStore = fileStore, now = Date.now(), max = SWEEP_MAX): Promise<number> {
  const old: { prefix: string; key: string }[] = [];
  for (const prefix of SWEEP_PREFIXES) for (const o of await store().list(prefix)) if (now - o.at.getTime() > SWEEP_AGE_MS) old.push({ prefix, key: o.key });
  const named = new Set((await db.query<{ k: string }>(REFERENCED, [old.map((o) => o.key)])).rows.map((r) => r.k));
  const orphans = old.filter((o) => !named.has(o.key));
  // over the cap, or (past a handful) most of the older files: a wrong database looks like that, so nothing is removed
  if (orphans.length > max || (orphans.length > SWEEP_FEW && orphans.length * 2 > old.length))
    return log(`sweep: ${orphans.length} orphans of ${old.length} older files, over the cap (${max}, or half of them past ${SWEEP_FEW}): nothing removed, check the database login`), 1;
  let failed = 0;
  for (const o of orphans) { try { await store().remove(o.key); } catch { failed++; } }
  const per = SWEEP_PREFIXES.map((p) => `${p} ${orphans.filter((o) => o.prefix === p).length}`).join(", ");
  log(`sweep: ${old.length} files older than 24 hours, ${old.length - orphans.length} still named by a row, ${orphans.length - failed} orphans removed (${per}), ${failed} failed`);
  return failed ? 1 : 0;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void, store: () => FileStore = fileStore): Promise<number> {
  const isSweep = argv.length === 1 && argv[0] === "sweep";
  if (argv.length && !isSweep) return log("usage: retention-cli.ts (no arguments), or retention-cli.ts sweep"), 2;
  const [name, login] = isSweep ? ["SWEEP_BACKUP_DATABASE_URL", "app_backup"] : ["RETENTION_ADMIN_DATABASE_URL", "app_admin"];
  const url = env[name];
  if (!url) return log(`${name} is not set (the ${login} login)`), 2;
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  try {
    await client.connect();
    return isSweep ? await sweep(client, log, store) : await drain(client, log);
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
