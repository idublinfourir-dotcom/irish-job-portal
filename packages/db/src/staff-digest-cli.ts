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

// ponytail: one counts statement per staff member (the team is a few dozen); one statement for all of them if it ever grows past a few hundred.
export async function writeDigest(db: Pick<pg.ClientBase, "query">): Promise<{ staff: number; written: number }> {
  const people = (await db.query<{ id: string; roles: string[] }>(DIGEST_STAFF)).rows;
  const rows = [];
  for (const p of people) {
    const counts = digestParams(await staffCounts(db, p.id, p.roles));
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
