// The daily retention run: applies the periods in `setting` by calling private.run_retention (0002_functions.sql), which does ONE rule per call
// and says `rule: null` when nothing is due. Run from the repo root with the app_admin login, as the last step of .github/workflows/daily-fetch.yml:
//   RETENTION_ADMIN_DATABASE_URL=... node packages/db/src/retention-cli.ts
// One line per call and a total. Exit 1 (red run) when: any call returned storage_keys (no file storage exists yet, so those files are
// deleted by hand: every key is printed), the call cap was reached, a rule made no progress (it would repeat for ever), or the database refused.
import pg from "pg";
import { sslOptions } from "./ssl.ts";

export const BATCH = 1000;
export const MAX_CALLS = 200;

type Step = { rule: string | null; target?: string | null; done: number; left: number; skipped: unknown[]; storage_keys: string[] };

export async function drain(db: Pick<pg.ClientBase, "query">, log: (line: string) => void, batch = BATCH, maxCalls = MAX_CALLS): Promise<number> {
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
  if (keys.length) log(`${keys.length} stored files must be deleted by hand: ${keys.map((k) => JSON.stringify(k)).join(" ")}`);
  if (problem) log(problem);
  return keys.length || problem ? 1 : 0;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  if (argv.length) return log("usage: retention-cli.ts (no arguments)"), 2;
  const url = env.RETENTION_ADMIN_DATABASE_URL;
  if (!url) return log("RETENTION_ADMIN_DATABASE_URL is not set (the app_admin login)"), 2;
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  try {
    await client.connect();
    return await drain(client, log);
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
