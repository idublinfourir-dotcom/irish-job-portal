// The daily staff digest (step 15 Q11): one email row (template staff_digest) for each active staff member with a role and at least one count above
// zero, holding only those numbers (staff-counts.ts digestParams); the outbox command sends it later the same run. The key names the Irish date,
// so a second run on the same day writes nothing. Run from the repo root with the app_admin login, daily from .github/workflows/daily-fetch.yml:
//   DIGEST_ADMIN_DATABASE_URL=... node packages/db/src/staff-digest-cli.ts
import pg from "pg";
import { sslOptions } from "./ssl.ts";
import { digestParams, staffCounts } from "./staff-counts.ts";

export const DIGEST_STAFF =
  "select u.id, array_agg(r.role) as roles from staff_user u join staff_role r on r.staff_user_id = u.id where u.status = 'active' group by u.id order by u.id";
export const WRITE_DIGEST =
  "insert into email_outbox(template, staff_user_id, params, dedupe_key) select 'staff_digest', d->>'id', d->'counts', " +
  "'staff_digest:' || (d->>'id') || ':' || (now() at time zone 'Europe/Dublin')::date from jsonb_array_elements($1::jsonb) d on conflict (dedupe_key) do nothing";
// #275: administrators also get the email limit numbers: the last outbox run's rows left unsent and alerts dropped as too old (its audit row,
// at most 2 days old: the digest is queued before that day's send step, so these are the previous run's), and the active alert subscribers. Counts only.
export const EMAIL_LIMIT =
  "select (select after from audit_event where action = 'email_outbox.run' and at > now() - interval '2 days' order by at desc, id desc limit 1) as run, " +
  // distinct in a subquery: a hash over one pass of alert (perf/weekly-alerts.perf.ts), where count(distinct) walked alert_candidate_idx with a heap visit per row
  "(select count(*)::int from (select distinct candidate_user_id from alert where status = 'active') s) as subscribers";
/** The administrators' email limit numbers from EMAIL_LIMIT's row (keys of outbox-cli.ts DIGEST_LABELS). Pure. */
export function emailLimit(r: { run: { left?: unknown; old?: unknown } | null; subscribers: number }): Record<string, number> {
  const n = (x: unknown) => (Number.isSafeInteger(x) ? (x as number) : 0);
  return { emailsLeft: n(r.run?.left), alertsTooOld: n(r.run?.old), alertSubscribers: r.subscribers };
}

// ponytail: one counts statement per staff member (the team is a few dozen); one statement for all of them if it ever grows past a few hundred.
export async function writeDigest(db: Pick<pg.ClientBase, "query">): Promise<{ staff: number; written: number }> {
  const people = (await db.query<{ id: string; roles: string[] }>(DIGEST_STAFF)).rows;
  const rows = [];
  const limit = people.some((p) => p.roles.includes("administrator")) ? emailLimit((await db.query(EMAIL_LIMIT)).rows[0]) : {};
  for (const p of people) {
    const counts = digestParams(await staffCounts(db, p.id, p.roles));
    if (p.roles.includes("administrator")) for (const [k, v] of Object.entries(limit)) if (v > 0) counts[k] = v;
    if (Object.keys(counts).length) rows.push({ id: p.id, counts });
  }
  return { staff: people.length, written: rows.length ? ((await db.query(WRITE_DIGEST, [JSON.stringify(rows)])).rowCount ?? 0) : 0 };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  if (argv.length) return log("usage: staff-digest-cli.ts (no arguments)"), 2;
  const url = env.DIGEST_ADMIN_DATABASE_URL;
  if (!url) return log("DIGEST_ADMIN_DATABASE_URL is not set (the app_admin login)"), 2;
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  try {
    await client.connect();
    const r = await writeDigest(client);
    log(`staff digest: ${r.staff} staff, ${r.written} new`);
    return 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
