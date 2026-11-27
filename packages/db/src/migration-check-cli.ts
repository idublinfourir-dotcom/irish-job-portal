// Deploy check (audit DEP-5): the live schema must be the one the code being deployed expects. Compares every journal entry (its file's SHA-256 and
// time) with drizzle.__drizzle_migrations and fails on a missing, extra, changed or out-of-order one. drizzle's migrator never notices an edited
// applied file or a file dated before the newest applied one. Run from the repo root with the app_backup login (read only), by .github/workflows/deploy.yml:
//   BACKUP_DATABASE_URL=... node packages/db/src/migration-check-cli.ts
import { readFileSync } from "node:fs";
import pg from "pg";
import { repoMigrationHashes } from "./restore-check-cli.ts";
import { sslOptions } from "./ssl.ts";

export type Row = { hash: string; created_at: string | number };
export type Entry = { tag: string; when: number };

/**
 * What differs between the journal (repo order) and the applied rows (id order). Pure.
 * The deploy runs before the engineer applies a new migration, so entries at the END with no applied row are `pending` (a warning, not a failure).
 * Applied rows are matched to the journal by position, so a gap (an entry missing in the middle) shows as a changed file and fails.
 */
export function migrationDrift(entries: Entry[], hashes: string[], rows: Row[]): { problems: string[]; pending: string[] } {
  const p: string[] = [];
  const pending = entries.slice(rows.length).map((e) => e.tag);
  entries.slice(0, rows.length).forEach((e, i) => {
    const r = rows[i]!;
    if (r.hash !== hashes[i]) p.push(`${e.tag}: the file differs from what was applied (edited after it ran, or a different order)`);
    else if (Number(r.created_at) !== e.when) p.push(`${e.tag}: the journal time differs from the applied time`);
  });
  if (rows.length > entries.length) p.push(`${rows.length - entries.length} applied migration(s) are not in the repo`);
  entries.forEach((e, i) => { if (i && e.when <= entries[i - 1]!.when) p.push(`${e.tag}: its journal time is not later than the one before (drizzle would skip it)`); });
  return { problems: p, pending };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  if (argv.length) return log("usage: migration-check-cli.ts (no arguments)"), 2;
  if (!env.BACKUP_DATABASE_URL) return log("BACKUP_DATABASE_URL is not set (the app_backup login)"), 2;
  const entries: Entry[] = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")).entries;
  const client = new pg.Client({ connectionString: env.BACKUP_DATABASE_URL, ssl: sslOptions(env) });
  try {
    await client.connect();
    const rows = (await client.query("select hash, created_at from drizzle.__drizzle_migrations order by id")).rows as Row[];
    const { problems, pending } = migrationDrift(entries, repoMigrationHashes(), rows);
    for (const t of pending) log(`::warning::${t} is not applied yet: apply it after this deploy`);
    if (problems.length) return problems.forEach((x) => log(`FAIL ${x}`)), 1;
    log(`migrations: ${entries.length} in the repo, ${entries.length - pending.length} applied, ${pending.length} pending, hashes and times match`);
    return 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
