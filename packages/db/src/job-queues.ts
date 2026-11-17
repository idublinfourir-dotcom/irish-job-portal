// The staff queues for held employer and agency jobs (step 15 Q1, #244): scam_flag, post_strike_job_review and agency_client_check, the review_item
// rows that private.job_queue_review writes. List, look at, claim, release, approve and reject, run as app_admin, mirroring admin-queue.ts.
// Roles (#244 b, the staff matrix): scam_flag is decided by trust_and_safety, the other two by account_reviewer, and an administrator may act on
// all three. Unlike the fetched queue (where no role implies another), administrator is accepted here by the engineer's choice. The role check is
// inside every call, reads included. Only the claimer decides, under row locks on the item and its job.
import type pg from "pg";
import { readQueueCursor, queueCursor, QueueRefused, RELEASE, STALE_AFTER, TAKE_OVER } from "./admin-queue";
import { PAGE_SIZE, validId } from "./search";

type Db = Pick<pg.Pool, "query" | "connect">;

/** Each queue and the role that decides it. */
export const JOB_QUEUES = { scam_flag: "trust_and_safety", post_strike_job_review: "account_reviewer", agency_client_check: "account_reviewer" } as const;
export type JobQueue = keyof typeof JOB_QUEUES;
export const isJobQueue = (q: unknown): q is JobQueue => typeof q === "string" && Object.hasOwn(JOB_QUEUES, q);
/** May a staff member holding these roles read and decide this queue? Its own role, or administrator. Pure. */
export const mayAct = (roles: readonly string[], q: JobQueue): boolean => roles.includes(JOB_QUEUES[q]) || roles.includes("administrator");
const anyQueue = (roles: readonly string[]) => (Object.keys(JOB_QUEUES) as JobQueue[]).some((q) => mayAct(roles, q));

const Q = "('scam_flag','post_strike_job_review','agency_client_check')";
// Only employer and agency jobs: the fetcher may write scam_flag items on fetched jobs, which this queue never releases.
const JOINS = "from review_item r join job j on j.id = r.job_id join organisation o on o.id = j.organisation_id";
const COLS =
  "r.id, r.queue, r.status, r.claimed_by_staff_user_id, r.reason, r.created_at::text as created_text, j.id as job_id, j.status as job_status, j.source, j.title, " +
  "j.employer_name, j.county, j.occupation_code, j.permit_type, j.salary_low, j.salary_high, j.pay_grade, j.badge, j.closes_at, " +
  "j.permit_employer_name as client_name, j.permit_employer_check as client_check, o.id as organisation_id, o.display_name as company, o.status as company_status, " +
  "o.restricted_until > now() as restricted";
const OPEN = "r.queue = $1 and r.status in ('open','claimed') and j.source in ('employer','agency')";
// Oldest first on review_item_queue_idx (queue, created_at, id) where status in ('open','claimed').
export const JOBQ_FIRST = `select ${COLS} ${JOINS} where ${OPEN} order by r.created_at, r.id limit ${PAGE_SIZE + 1}`;
export const JOBQ_AFTER = `select ${COLS} ${JOINS} where ${OPEN} and (r.created_at, r.id) > ($2::timestamptz, $3::bigint) order by r.created_at, r.id limit ${PAGE_SIZE + 1}`;
export const JOBQ_ITEM = `select ${COLS}, t.advert_text ${JOINS} left join job_text t on t.job_id = j.id where r.id = $1::bigint and r.queue in ${Q} and j.source in ('employer','agency')`;

type Row = {
  id: string; queue: JobQueue; status: string; claimed_by_staff_user_id: string | null; reason: string | null; created_text: string; job_id: string; job_status: string;
  source: string; title: string; employer_name: string; county: string | null; occupation_code: string | null; permit_type: string; salary_low: number | null;
  salary_high: number | null; pay_grade: string | null; badge: string | null; closes_at: Date; client_name: string | null; client_check: string;
  organisation_id: string; company: string; company_status: string; restricted: boolean | null;
};
export type JobQueueItem = {
  id: string; queue: JobQueue; status: string; claimedBy: string | null; reason: string | null; jobId: string; jobStatus: string; source: string; title: string;
  employerName: string; county: string | null; occupationCode: string | null; permitType: string; salaryLow: number | null; salaryHigh: number | null;
  payGrade: string | null; badge: string | null; closesAt: Date; organisationId: string; company: string; companyStatus: string;
  /** The company is under a strike 2 restriction now. */
  restricted: boolean;
  /** The agency's client as posted, and whether it was found in the DETE names ('client' jobs; null and 'pending' for an employer's own job). */
  clientName: string | null; clientCheck: string;
};
const item = (r: Row): JobQueueItem => ({
  id: r.id, queue: r.queue, status: r.status, claimedBy: r.claimed_by_staff_user_id, reason: r.reason, jobId: r.job_id, jobStatus: r.job_status, source: r.source,
  title: r.title, employerName: r.employer_name, county: r.county, occupationCode: r.occupation_code, permitType: r.permit_type, salaryLow: r.salary_low,
  salaryHigh: r.salary_high, payGrade: r.pay_grade, badge: r.badge, closesAt: r.closes_at, organisationId: r.organisation_id, company: r.company,
  companyStatus: r.company_status, restricted: r.restricted === true, clientName: r.client_name, clientCheck: r.client_check,
});

// One statement: sets the acting id and returns the roles of an active staff member (null when not active).
export const JOBQ_ACT =
  "select set_config('app.staff_user_id', $1, true), case when u.id is not null then (select coalesce(array_agg(r.role), '{}') from staff_role r where r.staff_user_id = u.id) end as roles " +
  "from (select 1) x left join staff_user u on u.id = $1 and u.status = 'active'";

async function rolesOf(db: Pick<pg.Pool, "query">, staffUserId: string): Promise<string[]> {
  if (typeof staffUserId !== "string" || staffUserId.length === 0 || staffUserId.length > 200) throw new QueueRefused("not_active_staff");
  const roles = (await db.query<{ roles: string[] | null }>(JOBQ_ACT, [staffUserId])).rows[0]!.roles;
  if (roles === null) throw new QueueRefused("not_active_staff");
  if (!anyQueue(roles)) throw new QueueRefused("not_reviewer");
  return roles;
}

/** Open and claimed items of one queue, oldest first, a page at a time. */
export async function listJobQueue(db: Pick<pg.Pool, "query">, staffUserId: string, queue: unknown, opts: { after?: string } = {}): Promise<{ items: JobQueueItem[]; next: string | null }> {
  if (!isJobQueue(queue)) throw new QueueRefused("bad_queue");
  const cursor = opts.after === undefined ? undefined : readQueueCursor(opts.after);
  if (!mayAct(await rolesOf(db, staffUserId), queue)) throw new QueueRefused("not_reviewer");
  const all = (cursor ? await db.query<Row>(JOBQ_AFTER, [queue, ...cursor]) : await db.query<Row>(JOBQ_FIRST, [queue])).rows;
  const rows = all.slice(0, PAGE_SIZE);
  return { items: rows.map(item), next: all.length > PAGE_SIZE ? queueCursor(rows.at(-1)!) : null };
}

/** One item of the three queues, whatever its status, with the advert text. null when the id is not one; refused when its queue is not the caller's. */
export async function getJobQueueItem(db: Pick<pg.Pool, "query">, staffUserId: string, id: string | number): Promise<(JobQueueItem & { advertText: string | null }) | null> {
  const roles = await rolesOf(db, staffUserId);
  const key = String(id);
  if (!validId(key)) return null;
  const r = (await db.query<Row & { advert_text: string | null }>(JOBQ_ITEM, [key])).rows[0];
  if (!r) return null;
  if (!mayAct(roles, r.queue)) throw new QueueRefused("not_reviewer");
  return { ...item(r), advertText: r.advert_text };
}

// ===== the actions =====
// The item and its job, locked, so two staff cannot decide one item (or two items of one job) at once.
export const JOBQ_LOCK =
  "select r.queue, r.status, r.claimed_by_staff_user_id, j.id as job_id, j.status as job_status from review_item r join job j on j.id = r.job_id " +
  `where r.id = $1::bigint and r.queue in ${Q} and j.source in ('employer','agency') for update of r, j`;
type Locked = { queue: JobQueue; status: string; claimed_by_staff_user_id: string | null; job_id: string; job_status: string };

async function acting<T>(db: Db, staffUserId: string, itemId: string | number, fn: (c: pg.PoolClient, id: string, r: Locked) => Promise<T>): Promise<T> {
  if (typeof staffUserId !== "string" || staffUserId.length === 0 || staffUserId.length > 200) throw new QueueRefused("not_active_staff");
  const key = String(itemId);
  if (!validId(key)) throw new QueueRefused("not_found");
  const c = await db.connect();
  try {
    await c.query("begin");
    const roles = await rolesOf(c, staffUserId);
    const r = (await c.query<Locked>(JOBQ_LOCK, [key])).rows[0];
    if (!r) throw new QueueRefused("not_found");
    if (!mayAct(roles, r.queue)) throw new QueueRefused("not_reviewer");
    const out = await fn(c, key, r);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const CLAIM = "update review_item set status = 'claimed', claimed_by_staff_user_id = $2, claimed_at = now() where id = $1::bigint and status = 'open'";
const TAKE_OVER_JOBQ = TAKE_OVER.replaceAll("queue = 'fetched_job'", `queue in ${Q}`);
const RELEASE_JOBQ = RELEASE.replaceAll("queue = 'fetched_job'", `queue in ${Q}`);

/** Open to claimed by this staff member; a no-op on one's own claim; a stale claim of someone else is taken over (as in the fetched queue). */
export async function claimJobItem(db: Db, staffUserId: string, itemId: string | number): Promise<void> {
  await acting(db, staffUserId, itemId, async (c, id, r) => {
    if (r.status === "open") { await c.query(CLAIM, [id, staffUserId]); return; }
    if (r.status !== "claimed") throw new QueueRefused("already_decided");
    if (r.claimed_by_staff_user_id === staffUserId) return;
    if ((await c.query(TAKE_OVER_JOBQ, [id, staffUserId, `${r.queue}.take_over`, STALE_AFTER])).rowCount === 1) return;
    throw new QueueRefused("claimed_by_other");
  });
}

/** Claimed back to open, by the claimer only. */
export async function releaseJobItem(db: Db, staffUserId: string, itemId: string | number): Promise<void> {
  await acting(db, staffUserId, itemId, async (c, id, r) => {
    if (r.status === "open") throw new QueueRefused("not_claimed");
    if (r.status !== "claimed") throw new QueueRefused("already_decided");
    if (r.claimed_by_staff_user_id !== staffUserId) throw new QueueRefused("not_claimer");
    await c.query(RELEASE_JOBQ, [id, staffUserId, `${r.queue}.release`]);
  });
}

function checkDecider(r: Locked, staffUserId: string): void {
  if (r.status !== "claimed") throw new QueueRefused(r.status === "open" ? "not_claimed" : "already_decided");
  if (r.claimed_by_staff_user_id !== staffUserId) throw new QueueRefused("not_claimer");
  if (r.job_status !== "in_review") throw new QueueRefused("job_not_in_review");
}

// $1 job, $2 item, $3 staff, $4 action. The item is done; the job goes live only when no other open or claimed item of the three queues is left on
// it (the job row is locked, so a second approver waits and then sees this item done). One audit row on the job either way.
export const JOBQ_APPROVE =
  "with r as (update review_item set status = 'done', decided_by_staff_user_id = $3, decided_at = now(), outcome = 'approved' " +
  "where id = $2::bigint and status = 'claimed' and claimed_by_staff_user_id = $3 returning id), " +
  "j as (update job set status = 'live' where id = $1::bigint and status = 'in_review' and exists (select 1 from r) " +
  `and not exists (select 1 from review_item o where o.job_id = $1::bigint and o.id <> $2::bigint and o.queue in ${Q} and o.status in ('open','claimed')) returning id) ` +
  "insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, changed_columns, before, after, reason_code, source) " +
  "select 'admin_action', $3, $4, 'job', $1::text, case when exists (select 1 from j) then '{status}'::text[] else '{}'::text[] end, " +
  "'{\"status\":\"in_review\"}'::jsonb, jsonb_build_object('status', case when exists (select 1 from j) then 'live' else 'in_review' end), 'approved', 'panel' " +
  "from r returning after->>'status' as job_status";

/** Approve: the item is done; the job goes live when it was the last item holding it. The job's own guards apply (the company verified, and so on). */
export async function approveJobItem(db: Db, staffUserId: string, itemId: string | number): Promise<{ jobId: string; jobStatus: string }> {
  return acting(db, staffUserId, itemId, async (c, id, r) => {
    checkDecider(r, staffUserId);
    try {
      const w = await c.query<{ job_status: string }>(JOBQ_APPROVE, [r.job_id, id, staffUserId, `${r.queue}.approve`]);
      return { jobId: r.job_id, jobStatus: w.rows[0]!.job_status };
    } catch (e) {
      // private.job_org_live: a job of a company that is not verified, or is suspended, banned or closed, never goes live
      if ((e as { message?: string }).message?.startsWith("job refused")) throw new QueueRefused("company_not_active");
      throw e;
    }
  });
}

const REASON = /^[a-z][a-z0-9_]{0,62}$/; // a reason code, never free text (the audit log holds no free text)
// $1 job, $2 item, $3 staff, $4 action, $5 reason code. Then the job closes as a staff removal; private.job_queue_review drops its other items.
export const JOBQ_REJECT =
  "with r as (update review_item set status = 'done', decided_by_staff_user_id = $3, decided_at = now(), outcome = 'rejected' " +
  "where id = $2::bigint and status = 'claimed' and claimed_by_staff_user_id = $3 returning id) " +
  "insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, changed_columns, before, after, reason_code, source) " +
  "select 'admin_action', $3, $4, 'job', $1::text, '{status,close_reason}', '{\"status\":\"in_review\",\"close_reason\":null}'::jsonb, " +
  "'{\"status\":\"closed\",\"close_reason\":\"removed\"}'::jsonb, $5, 'panel' from r";
export const JOBQ_CLOSE = "update job set status = 'closed', closed_at = now(), close_reason = 'removed' where id = $1::bigint and status = 'in_review'";

/** Reject: the item is done as rejected, the job closed as removed (it never comes back), every other open item of the job dropped. One transaction. */
export async function rejectJobItem(db: Db, staffUserId: string, itemId: string | number, reason: string): Promise<void> {
  if (typeof reason !== "string" || !REASON.test(reason)) throw new QueueRefused("bad_reason");
  await acting(db, staffUserId, itemId, async (c, id, r) => {
    checkDecider(r, staffUserId);
    await c.query(JOBQ_REJECT, [r.job_id, id, staffUserId, `${r.queue}.reject`, reason]);
    await c.query(JOBQ_CLOSE, [r.job_id]);
  });
}
