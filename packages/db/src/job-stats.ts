// Job stats (#56, #227 D6): one view counted for a job today, and the company's own jobs' views and apply clicks by day.
// Days are Dublin days. Apply clicks are written by the candidate side (Part 10); this file only reads them.
import type pg from "pg";
import { validId } from "./search";

type Q = Pick<pg.Pool, "query">;
export const STATS_TZ = "Europe/Dublin";
const TODAY = `(now() at time zone '${STATS_TZ}')::date`;

// One statement, one row per job per day (unique job_id + day). Only a live job that has not passed closes_at counts, so a closed, hidden or
// unknown job writes nothing. Run as app_candidate (the job page), which may insert and update job_daily_stat and read the job's id, status and closes_at.
// ponytail: a busy job updates one row, so concurrent views queue on its row lock (about 0.1 ms each); fine into the thousands per second.
// If a job ever gets more, count in a few shard rows per day and sum them on read.
export const COUNT_VIEW =
  `insert into job_daily_stat(job_id, day, views) select j.id, ${TODAY}, 1 from job j where j.id = $1::bigint and j.status = 'live' and j.closes_at > now() ` +
  "on conflict (job_id, day) do update set views = job_daily_stat.views + 1";

/** Counts one view of a job today. true when it was counted; false for a bad id, an unknown job or one that is not live. */
export async function countJobView(db: Q, jobId: string | number): Promise<boolean> {
  const id = String(jobId);
  if (!validId(id)) return false;
  return (await db.query(COUNT_VIEW, [id])).rowCount === 1;
}

export const MAX_DAYS = 90;
export const MAX_ROWS = 5000;
// The company's jobs by organisation_id (job_organisation_idx), then their stat rows by (job_id, day). Another company's jobs never match $1.
export const STATS_READ =
  "select s.job_id::text as job_id, j.title, j.source, j.status, s.day::text as day, s.views, s.apply_clicks " +
  `from job j join job_daily_stat s on s.job_id = j.id where j.organisation_id = $1::bigint and s.day >= ${TODAY} - $2::int ` +
  "and ($3::bigint is null or j.id = $3::bigint) order by s.day desc, s.job_id limit " + MAX_ROWS;

export type JobStatDay = { jobId: string; title: string; source: string; status: string; day: string; views: number; applyClicks: number };

/**
 * The views and apply clicks, by day, of one company's jobs over the last `days` days (1 to 90, today included), newest day first. Optional `jobId`
 * narrows it to one job (still only if it is the company's). At most 5,000 rows. The caller passes the organisation of the signed-in member, never a body value.
 */
export async function jobStats(db: Q, organisationId: string | number, opts: { days?: number; jobId?: string } = {}): Promise<JobStatDay[]> {
  const org = String(organisationId), days = opts.days ?? 30;
  if (!validId(org) || !Number.isInteger(days) || days < 1 || days > MAX_DAYS || (opts.jobId !== undefined && !validId(opts.jobId))) throw new RangeError("bad_input");
  const rows = (await db.query<{ job_id: string; title: string; source: string; status: string; day: string; views: number; apply_clicks: number }>(STATS_READ, [org, days - 1, opts.jobId ?? null])).rows;
  return rows.map((r) => ({ jobId: r.job_id, title: r.title, source: r.source, status: r.status, day: r.day, views: r.views, applyClicks: r.apply_clicks }));
}
