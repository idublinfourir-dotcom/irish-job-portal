// The on-time trigger for the backup and the email outbox (audit of 27 Nov 2026, DEP-3). GitHub's scheduler starts runs hours late and skips some,
// so the database keeps the clock: pg_cron runs a statement on time, and pg_net calls GitHub's "run this workflow" address. GitHub still does the work.
// Run once by the engineer, with the database's own `postgres` login (the one migrations use), in their own terminal:
//   SCHEDULER_DATABASE_URL=... DATABASE_CA_CERT="$(cat .../supabase-ca.crt)" node packages/db/src/scheduler-setup-cli.ts
// It asks for the GitHub token with a hidden prompt (or reads it from a pipe), never from an argument, and never prints it. The token is a
// fine-grained one of the repository's owner, for this repository only, with "Actions: read and write"; it is kept in Supabase Vault and the
// scheduled statements read it from there by name, so no table, log line or job text holds it. Safe to run again (a new token replaces the old one).
//   ... node packages/db/src/scheduler-setup-cli.ts --status   prints the jobs and the last answers GitHub gave, and asks for nothing.
// The jobs and the Vault are outside the backup (it dumps public, private and drizzle), so after a restore into a new project this is run again.
import pg from "pg";
import { DAILY_CAP, DUE, SENT_TODAY } from "./outbox-cli.ts";
import { sslOptions } from "./ssl.ts";

export const REPO = "idublinfourir-dotcom/irish-job-portal";
export const SECRET_NAME = "github_actions_dispatch";
/** A fine-grained GitHub token. A classic one (ghp_) reaches every repository of its account, so it is refused. */
export const TOKEN_SHAPE = /^github_pat_[A-Za-z0-9_]{30,255}$/;
const APP_ROLES = ["app_backup", "app_candidate", "app_portal", "app_admin", "app_fetcher"];

/** What the database starts, and when. `when` is a SQL condition: the statement calls GitHub only while it holds. */
export const JOBS = [
  // The backup's own four slots (backup.yml): 00:47, 06:47, 12:47 and 18:47 UTC.
  { name: "portal-backup", schedule: "47 */6 * * *", workflow: "backup.yml", when: "true" },
  // Every 15 minutes, but only when a row is due and the day's limit has room: an idle site starts no run at all.
  { name: "portal-outbox", schedule: "*/15 * * * *", workflow: "outbox.yml", when: `exists (select 1 from email_outbox where ${DUE}) and (${SENT_TODAY}) < ${DAILY_CAP}` },
] as const;

/** The statement a job runs. Built from the constants above only; the token is read from the Vault when it runs, so this text never holds it. */
export const dispatchSql = (workflow: string, when: string) =>
  `select net.http_post(url := 'https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches', body := '{"ref":"main"}'::jsonb, ` +
  `headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = '${SECRET_NAME}'), ` +
  `'Accept', 'application/vnd.github+json', 'User-Agent', 'irish-job-portal-scheduler', 'Content-Type', 'application/json'), timeout_milliseconds := 10000) where ${when}`;

const CAN_DECRYPT =
  "select coalesce(bool_or(has_function_privilege(r.oid, p.oid, 'execute')), false) as can from pg_roles r, pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
  "where r.rolname = any($1::text[]) and n.nspname = 'vault' and p.proname = '_crypto_aead_det_decrypt'";
const STATUS_JOBS = "select jobname, schedule, active from cron.job where jobname = any($1::text[]) order by jobname";
const STATUS_ANSWERS = "select to_char(created at time zone 'utc', 'YYYY-MM-DD HH24:MI') as at, status_code, timed_out, left(coalesce(error_msg, ''), 80) as error from net._http_response order by created desc limit 8";

type Db = { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; end: () => Promise<void> };
export type Deps = { connect: (url: string, env: NodeJS.ProcessEnv) => Promise<Db>; readToken: () => Promise<string>; sleep: (ms: number) => Promise<void> };

/** The token from the terminal with nothing shown, or from a pipe. */
async function readToken(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) { let all = ""; for await (const c of input) all += c; return all.trim(); }
  process.stderr.write("Paste the GitHub token (nothing is shown), then press Enter: ");
  input.setRawMode(true);
  let typed = "";
  try {
    for await (const c of input) {
      const text = String(c);
      if (text.includes("\u0003")) throw new Error("cancelled");
      typed += text;
      if (/[\r\n]/.test(text)) break;
    }
  } finally {
    input.setRawMode(false);
    input.pause();
    process.stderr.write("\n");
  }
  return typed.trim();
}

const real: Deps = {
  connect: async (url, env) => { const c = new pg.Client({ connectionString: url, ssl: sslOptions(env) }); await c.connect(); return c as unknown as Db; },
  readToken,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

async function status(db: Db, log: (line: string) => void): Promise<number> {
  const jobs = (await db.query(STATUS_JOBS, [JOBS.map((j) => j.name)])).rows;
  for (const j of jobs) log(`job ${j.jobname}: ${j.schedule}, ${j.active ? "on" : "OFF"}`);
  for (const a of (await db.query(STATUS_ANSWERS)).rows) log(`answer ${a.at} UTC: ${a.timed_out ? "timed out" : a.status_code}${a.error ? ` (${a.error})` : ""}`);
  return jobs.length === JOBS.length && jobs.every((j) => j.active) ? 0 : 1;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void, deps: Deps = real): Promise<number> {
  const statusOnly = argv.length === 1 && argv[0] === "--status";
  if (argv.length && !statusOnly) return log("usage: scheduler-setup-cli.ts [--status]   (the token is asked for, never given as an argument)"), 2;
  if (!env.SCHEDULER_DATABASE_URL) return log("SCHEDULER_DATABASE_URL is not set (the database's postgres login, the one migrations use)"), 2;
  let token = "";
  if (!statusOnly) {
    token = await deps.readToken();
    if (!TOKEN_SHAPE.test(token)) return log("that is not a fine-grained GitHub token (it starts with github_pat_); nothing was changed"), 2;
  }
  let db: Db | undefined;
  try {
    db = await deps.connect(env.SCHEDULER_DATABASE_URL, env);
    if (statusOnly) return await status(db, log);
    await db.query("begin");
    await db.query("create extension if not exists pg_cron");
    await db.query("create extension if not exists pg_net");
    const old = (await db.query("select id from vault.secrets where name = $1", [SECRET_NAME])).rows[0];
    if (old) await db.query("select vault.update_secret($1::uuid, $2)", [old.id, token]);
    else await db.query("select vault.create_secret($1, $2, $3)", [token, SECRET_NAME, "GitHub token that may start this repository's workflows (scheduler-setup-cli.ts)"]);
    for (const j of JOBS) await db.query("select cron.schedule($1, $2, $3)", [j.name, j.schedule, dispatchSql(j.workflow, j.when)]);
    // Security: no app login, the read-only backup login included, may be able to decrypt what the Vault holds.
    if ((await db.query(CAN_DECRYPT, [APP_ROLES])).rows[0]!.can) throw new Error("an app login can decrypt Vault secrets; nothing was changed");
    await db.query("commit");
    log(`stored the token in the Vault as ${SECRET_NAME} and scheduled ${JOBS.map((j) => j.name).join(" and ")}`);
    if ((await db.query("select has_table_privilege('app_backup', 'net.http_request_queue', 'select') as can")).rows[0]!.can)
      log("note: the read-only backup login can read pg_net's request queue, where a call waits (with its token) for the moment before it is sent");
    // Proof: start one backup now and read GitHub's answer. pg_net sends only after the statement commits.
    const id = (await db.query(dispatchSql("backup.yml", "true"))).rows[0]!.http_post;
    for (let i = 0; i < 20; i++) {
      await deps.sleep(1000);
      const a = (await db.query("select status_code, timed_out, left(coalesce(error_msg, ''), 80) as error from net._http_response where id = $1", [id])).rows[0];
      if (!a) continue;
      const code = Number(a.status_code);
      if (code >= 200 && code < 300) return log(`GitHub accepted the test call (${code}): one backup run has started, and the trigger works`), 0;
      return log(`GitHub refused the test call: ${a.timed_out ? "timed out" : code}${a.error ? ` (${a.error})` : ""}. 401 or 403: the token lacks "Actions: read and write" on ${REPO}; 404: it is not the owner's token. Run this again with a new token.`), 1;
    }
    return log("no answer from GitHub within 20 seconds; run again with --status in a minute"), 1;
  } catch (e) {
    await db?.query("rollback").catch(() => {});
    return log(`refused: ${(e as Error).message.replaceAll(token || "\u0000", "[token]")}`), 1;
  } finally {
    await db?.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
