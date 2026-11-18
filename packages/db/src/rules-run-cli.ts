// The daily rules run (#93, #234 D9): on the first run on or after the day a confirmed minimums version comes into force, every live employer or
// agency job whose stated pay is now below the minimum goes "under review" with the reason 'pay_check' (job.under_review_reason, 0045), and
// every active pay floor ends as 'expired' (#82), its company's owner told (N5). One transaction; the version's run_at records that it was applied, so a second run does nothing.
// Run from the repo root with the app_admin login, daily from .github/workflows/daily-fetch.yml after the job expiry step:
//   RULES_ADMIN_DATABASE_URL=... node packages/db/src/rules-run-cli.ts
import pg from "pg";
import { minimumForHours } from "../../rules/src/thresholds.ts";
import { loadRules, type Minimums } from "./rules-data.ts";
import { sslOptions } from "./ssl.ts";

// The minimums version in force today, locked so two runs cannot both apply it.
export const PICK =
  "select id::text as id, run_at is not null as done, current_date::text as today from rules_version where kind = 'minimums' and effective_from <= current_date " +
  "order by effective_from desc, id desc limit 1 for update";
// Portal posts that passed on their stated pay (public_pay posts pass on the employer's pay scale and are left alone).
export const LIVE_STATED =
  "select id::text as id, permit_type, occupation_code, salary_low, salary_high, health_insurance_eur, weekly_hours from job " +
  "where source in ('employer','agency') and status = 'live' and pass_route = 'stated_pay' for update";
type Job = { id: string; permit_type?: string; occupation_code: string | null; salary_low: number | null; salary_high: number | null; health_insurance_eur: number | null; weekly_hours: number | null };

/** The posting check's pay rule (apps/portal/lib/jobs.ts): the top of the range plus employer-paid health insurance, >= the minimum for the stated hours. */
export function belowMinimum(j: Job, m: Minimums, criticalSkills: ReadonlySet<string>): boolean {
  if (j.permit_type === "general") { // the General minimum (a lower rate for some codes); with no General figures in force there is nothing to compare with, so it stays live
    if (m.general === undefined || m.generalLower === undefined || !m.generalLowerCodes) return false;
    if (j.salary_low === null) return true;
    const base = j.occupation_code !== null && m.generalLowerCodes.includes(j.occupation_code) ? m.generalLower : m.general;
    return (j.salary_high ?? j.salary_low) + (j.health_insurance_eur ?? 0) < minimumForHours(base, j.weekly_hours ?? undefined, m.standardWeekHours);
  }
  const onList = j.occupation_code !== null && criticalSkills.has(j.occupation_code);
  if (!onList && !m.nonListRoute) return true;
  if (j.salary_low === null) return true;
  const pay = (j.salary_high ?? j.salary_low) + (j.health_insurance_eur ?? 0);
  return pay < minimumForHours(onList ? m.criticalSkills : m.nonList, j.weekly_hours ?? undefined, m.standardWeekHours);
}

// #93: the jobs go under review and, in the same statement, each company's account owner gets one email and one portal notice naming them (the first 20
// by id, with the count) and saying they close after 30 days unless the pay is edited. A company with no active owner gets none; a second run cannot repeat it (dedupe key).
export const UNDER_REVIEW =
  "with u as (update job set status = 'under_review', under_review_reason = 'pay_check' where id = any($1::bigint[]) and status = 'live' returning id, organisation_id, title), " +
  "t as (select m.portal_user_id as p, g.org, g.n, g.jobs from (select organisation_id as org, count(*)::int as n, " +
  "(array_agg(jsonb_build_object('id', id, 'title', title) order by id))[1:20] as jobs from u group by organisation_id) g " +
  "join membership m on m.organisation_id = g.org and m.role = 'account_owner' and m.status = 'active'), " +
  "e as (insert into email_outbox(template, portal_user_id, params, dedupe_key) " +
  "select 'rules_jobs_under_review', p, jsonb_build_object('organisationId', org, 'versionId', $2::bigint, 'count', n, 'jobs', jobs, 'closeAfterDays', 30), 'rules_jobs_under_review:' || $2 || ':' || org from t " +
  "on conflict (dedupe_key) do nothing returning 1), " +
  "n as (insert into notification(portal_user_id, category, template_key, params, dedupe_key) " +
  "select p, 'rules', 'rules_jobs_under_review', jsonb_build_object('organisationId', org, 'versionId', $2::bigint, 'count', n, 'jobs', jobs, 'closeAfterDays', 30), 'rules_jobs_under_review:' || $2 || ':' || org from t " +
  "on conflict (dedupe_key) do nothing returning 1) " +
  "select (select count(*) from u)::int as jobs";

// N5: every active pay floor ends as 'expired' and, in the same statement, the company's active owner gets one portal notice and one queued email per floor
// (ids only). The dedupe key (floor id) keeps it to one even if a later run ever met the same floor again. Returns the floors ended.
export const END_FLOORS =
  "with f as (update pay_floor set status = 'expired' where status = 'active' returning id, organisation_id), " +
  "t as (select m.portal_user_id as p, f.organisation_id as org, f.id as floor, jsonb_build_object('organisationId', f.organisation_id, 'floorId', f.id, 'versionId', $1::bigint) as params " +
  "from f join membership m on m.organisation_id = f.organisation_id and m.role = 'account_owner' and m.status = 'active'), " +
  "n as (insert into notification(portal_user_id, organisation_id, category, template_key, params, dedupe_key) " +
  "select p, org, 'rules', 'pay_floor_expired', params, 'pay_floor_expired:' || floor from t on conflict (dedupe_key) do nothing), " +
  "e as (insert into email_outbox(template, portal_user_id, params, dedupe_key) select 'pay_floor_expired', p, params, 'pay_floor_expired:' || floor from t on conflict (dedupe_key) do nothing) " +
  "select count(*)::int as n from f";

// S8 (#85): the quota notice. Each job write sets the mark from the version in force (trigger job_quota_full, 0045); this step puts every
// existing row right when a new version applies. Every open General job of a code in generalQuotaFullCodes is marked quota_full (the search sorts it last), and one whose code
// left the list is cleared; only rows that change are written. A version with no General figures has no list, so every mark is cleared.
export const QUOTA_FULL =
  "with q as (select id, coalesce(permit_type = 'general' and occupation_code = any($1::text[]), false) as full from job where status <> 'closed') " +
  "update job j set quota_full = q.full from q where j.id = q.id and j.quota_full <> q.full";

export type RunResult = { versionId: string | null; applied: boolean; underReview: number; floorsEnded: number; quotaChanged: number };

export async function runRules(c: pg.ClientBase): Promise<RunResult> {
  await c.query("begin");
  try {
    const v = (await c.query<{ id: string; done: boolean; today: string }>(PICK)).rows[0];
    if (!v || v.done) {
      await c.query("commit");
      return { versionId: v?.id ?? null, applied: false, underReview: 0, floorsEnded: 0, quotaChanged: 0 };
    }
    const rules = await loadRules(c, v.today);
    const cs = new Set(rules.occupationLists.filter((o) => o.list === "critical-skills").map((o) => o.code));
    const ids = (await c.query<Job>(LIVE_STATED)).rows.filter((j) => belowMinimum(j, rules.minimums, cs)).map((j) => j.id);
    const underReview = (await c.query<{ jobs: number }>(UNDER_REVIEW, [ids, v.id])).rows[0]!.jobs;
    const floorsEnded = (await c.query<{ n: number }>(END_FLOORS, [v.id])).rows[0]!.n;
    const quotaChanged = (await c.query(QUOTA_FULL, [rules.minimums.generalQuotaFullCodes ?? []])).rowCount ?? 0;
    await c.query("update rules_version set run_at = now() where id = $1::bigint", [v.id]);
    await c.query(
      "insert into audit_event(kind, actor_system, action, object_type, object_id, after, source) values ('admin_action', 'rules-run-cli', 'rules.minimums_in_force', 'rules_version', $1, $2, 'scheduled_job')",
      [v.id, { under_review: underReview, floors_ended: floorsEnded, quota_changed: quotaChanged }],
    );
    await c.query("commit");
    return { versionId: v.id, applied: true, underReview, floorsEnded, quotaChanged };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  if (argv.length) return log("usage: rules-run-cli.ts (no arguments)"), 2;
  const url = env.RULES_ADMIN_DATABASE_URL;
  if (!url) return log("RULES_ADMIN_DATABASE_URL is not set (the app_admin login)"), 2;
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  try {
    await client.connect();
    const r = await runRules(client);
    log(r.applied ? `minimums version ${r.versionId} applied: ${r.underReview} jobs under review, ${r.floorsEnded} pay floors ended, ${r.quotaChanged} quota marks changed` : "no new minimums today");
    return 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
