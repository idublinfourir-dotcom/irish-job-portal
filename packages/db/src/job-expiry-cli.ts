// The daily job expiry (D7, #48): closes employer and agency jobs past their 30 days and queues one reminder 3 days before the end
// (private.expire_employer_jobs, migration 0019), and does the same for pay floors past their 12 months (P7, #82: FLOORS_END, FLOORS_REMIND). Run from the repo root with the app_admin login, daily from .github/workflows/daily-fetch.yml:
//   EXPIRY_ADMIN_DATABASE_URL=... node packages/db/src/job-expiry-cli.ts
import pg from "pg";
import { sslOptions } from "./ssl.ts";

// #93: an employer or agency job that has been under review for 30 days closes as 'under_review_expired' (job.under_review_since, migration 0027).
// One statement; a job under review for less, a restored job and a fetched job are not touched. The closed_at trigger is not needed: it is set here.
export const CLOSE_UNDER_REVIEW =
  "update job set status = 'closed', closed_at = now(), close_reason = 'under_review_expired' " +
  "where source in ('employer','agency') and status = 'under_review' and under_review_since <= now() - interval '30 days'";

// P7 (#82): an active pay floor whose valid_until has passed ends as 'expired' (the pay_floor_guard trigger stamps ended_at), and in the same statement the
// company's active owner gets one portal notice and one queued email per floor, like the rules run's END_FLOORS (rules-run-cli.ts) but with its own wording
// (pay_floor_lapsed: the 12 months ran out, not the rules). Ids only. A floor already ended is not active, so a second run writes nothing.
export const FLOORS_END =
  "with f as (update pay_floor set status = 'expired' where status = 'active' and valid_until <= now() returning id, organisation_id), " +
  "t as (select m.portal_user_id as p, f.organisation_id as org, f.id as floor, jsonb_build_object('organisationId', f.organisation_id, 'floorId', f.id) as params " +
  "from f join membership m on m.organisation_id = f.organisation_id and m.role = 'account_owner' and m.status = 'active'), " +
  "n as (insert into notification(portal_user_id, organisation_id, category, template_key, params, dedupe_key) " +
  "select p, org, 'account', 'pay_floor_lapsed', params, 'pay_floor_lapsed:' || floor from t on conflict (dedupe_key) do nothing), " +
  "e as (insert into email_outbox(template, portal_user_id, params, dedupe_key) select 'pay_floor_lapsed', p, params, 'pay_floor_lapsed:' || floor from t on conflict (dedupe_key) do nothing) " +
  "select count(*)::int as n from f";

// P7: one re-sign notice and email to the active owner when an active floor has REMIND_DAYS or fewer left, once per floor (the notice's dedupe key, stored as role:key by
// dedupe_key_per_role, 0004; the not exists skips a floor already told, so a daily run on a floor in its last 30 days writes nothing more). No decision sets the number; 30 is the brief's default.
export const REMIND_DAYS = 30;
export const FLOORS_REMIND =
  "with t as (select m.portal_user_id as p, f.organisation_id as org, f.id as floor, jsonb_build_object('organisationId', f.organisation_id, 'floorId', f.id) as params " +
  "from pay_floor f join membership m on m.organisation_id = f.organisation_id and m.role = 'account_owner' and m.status = 'active' " +
  "where f.status = 'active' and f.valid_until > now() and f.valid_until <= now() + make_interval(days => $1::int) " +
  "and not exists (select 1 from notification x where x.dedupe_key = current_user || ':pay_floor_expiring:' || f.id)), " +
  "n as (insert into notification(portal_user_id, organisation_id, category, template_key, params, dedupe_key) " +
  "select p, org, 'account', 'pay_floor_expiring', params, 'pay_floor_expiring:' || floor from t on conflict (dedupe_key) do nothing returning 1), " +
  "e as (insert into email_outbox(template, portal_user_id, params, dedupe_key) select 'pay_floor_expiring', p, params, 'pay_floor_expiring:' || floor from t on conflict (dedupe_key) do nothing) " +
  "select count(*)::int as n from n";

type Expiry = { closed: number; reminded: number; underReviewClosed: number; floorsEnded: number; floorsReminded: number };
export async function expireJobs(db: Pick<pg.ClientBase, "query">): Promise<Expiry> {
  const r = (await db.query("select private.expire_employer_jobs() r")).rows[0].r;
  const underReviewClosed = (await db.query(CLOSE_UNDER_REVIEW)).rowCount ?? 0;
  const floorsEnded = (await db.query<{ n: number }>(FLOORS_END)).rows[0]!.n;
  const floorsReminded = (await db.query<{ n: number }>(FLOORS_REMIND, [REMIND_DAYS])).rows[0]!.n;
  return { ...r, underReviewClosed, floorsEnded, floorsReminded };
}

export const expiryLine = (r: Expiry) =>
  `${r.closed} employer jobs closed as expired, ${r.reminded} expiry reminders queued, ${r.underReviewClosed} jobs closed after 30 days under review, ` +
  `${r.floorsEnded} pay floors ended, ${r.floorsReminded} pay floor reminders queued`;

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  if (argv.length) return log("usage: job-expiry-cli.ts (no arguments)"), 2;
  const url = env.EXPIRY_ADMIN_DATABASE_URL;
  if (!url) return log("EXPIRY_ADMIN_DATABASE_URL is not set (the app_admin login)"), 2;
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  try {
    await client.connect();
    const r = await expireJobs(client);
    log(expiryLine(r));
    return 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
