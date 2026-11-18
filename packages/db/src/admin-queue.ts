// The fetched-job admin queue (#166 to #168): list, look at, claim, approve and reject the `fetched_job` review items, run as app_admin.
// Every action takes the acting staff member's id (#167): it must be an active staff_user holding the
// fetched_job_reviewer role (#193), and it is set as app.staff_user_id for the transaction, as the database's guards expect. Every statement is a constant with parameters. Only the claimer decides, under row locks.
import type pg from "pg";
import { assess, type Assessment, type ChainData, type StaffInput } from "@portal/rules";
import { isTime, PAGE_SIZE, validId } from "./search";

type Db = Pick<pg.Pool, "query" | "connect">;

/** A refused action. `why` is a short code a page can map to words; `stage` is the rules stage that failed, for "rules_failed". */
export class QueueRefused extends Error {
  constructor(readonly why: string, readonly stage?: string) {
    super(stage ? `${why}: ${stage}` : why);
  }
}

// ===== the list =====
const COLS =
  "r.id, r.status, r.claimed_by_staff_user_id, r.created_at::text as created_text, j.id as job_id, j.organisation_id, j.title, j.employer_name, " +
  "j.own_page_url, j.occupation_code, j.permit_history, j.sponsor_sort, f.stage, f.reason, coalesce(f.wrc_agency, false) as wrc_agency " +
  "from review_item r join job j on j.id = r.job_id left join fetched_advert f on f.id = j.fetched_advert_id";
// Oldest first on review_item_queue_idx (queue, created_at, id) where status in ('open','claimed').
const OPEN = "r.queue = 'fetched_job' and r.status in ('open','claimed')";
export const QUEUE_FIRST = `select ${COLS} where ${OPEN} order by r.created_at, r.id limit ${PAGE_SIZE + 1}`;
export const QUEUE_AFTER = `select ${COLS} where ${OPEN} and (r.created_at, r.id) > ($1::timestamptz, $2::bigint) order by r.created_at, r.id limit ${PAGE_SIZE + 1}`;

type Row = {
  id: string; status: string; claimed_by_staff_user_id: string | null; created_text: string; job_id: string; organisation_id: string; title: string;
  employer_name: string; own_page_url: string | null; occupation_code: string | null; permit_history: string; sponsor_sort: number; stage: string | null; reason: string | null; wrc_agency: boolean;
};
export type QueueItem = {
  id: string; status: string; claimedBy: string | null; jobId: string; organisationId: string; title: string; employerName: string;
  /** The advert link staff open to read the advert. */
  advertUrl: string | null;
  occupationCode: string | null;
  /** The employer's DETE link as slice 1 shows it: the label, and permits in the last 5 years (null when no DETE name is linked). */
  permitHistory: string; sponsorPermits: number | null;
  /** Why the fetcher queued it: the fetched_advert stage and reason. */
  stage: string | null; reason: string | null;
  /** The employer name is an agency or trading name on the WRC licensed agency list (0042; staff only). A signal, never a verdict. */
  wrcAgency: boolean;
};

const item = (r: Row): QueueItem => ({
  id: r.id, status: r.status, claimedBy: r.claimed_by_staff_user_id, jobId: r.job_id, organisationId: r.organisation_id, title: r.title, employerName: r.employer_name,
  advertUrl: r.own_page_url, occupationCode: r.occupation_code, permitHistory: r.permit_history, sponsorPermits: r.sponsor_sort >= 0 ? r.sponsor_sort : null,
  stage: r.stage, reason: r.reason, wrcAgency: r.wrc_agency,
});

export const queueCursor = (r: { created_text: string; id: string }) => Buffer.from(JSON.stringify({ t: r.created_text, i: r.id })).toString("base64url");
export function readQueueCursor(token: unknown): [string, string] {
  const bad = new QueueRefused("bad_cursor");
  if (typeof token !== "string" || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) throw bad;
  let o: { t?: unknown; i?: unknown };
  try {
    o = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw bad;
  }
  if (o === null || typeof o !== "object" || typeof o.t !== "string" || !isTime(o.t) || !validId(o.i)) throw bad;
  return [o.t, o.i];
}

/** The reads need the same login as the actions: an active staff member holding fetched_job_reviewer (#193, #234 D7). */
async function checkReviewer(db: Pick<pg.Pool, "query">, staffUserId: string): Promise<void> {
  if (typeof staffUserId !== "string" || staffUserId.length === 0 || staffUserId.length > 200) throw new QueueRefused("not_active_staff");
  const r = (await db.query<{ active: boolean; reviewer: boolean }>(QUEUE_ACT, [staffUserId])).rows[0]!;
  if (!r.active) throw new QueueRefused("not_active_staff");
  if (!r.reviewer) throw new QueueRefused("not_reviewer");
}

/** Open and claimed fetched_job items, oldest first, a page at a time. ponytail: next page only; add `before` when a page needs to go back. */
export async function listQueue(db: Pick<pg.Pool, "query">, staffUserId: string, opts: { after?: string } = {}): Promise<{ items: QueueItem[]; next: string | null }> {
  const cursor = opts.after === undefined ? undefined : readQueueCursor(opts.after);
  await checkReviewer(db, staffUserId);
  const all = (cursor ? await db.query<Row>(QUEUE_AFTER, cursor) : await db.query<Row>(QUEUE_FIRST)).rows;
  const rows = all.slice(0, PAGE_SIZE);
  return { items: rows.map(item), next: all.length > PAGE_SIZE ? queueCursor(rows.at(-1)!) : null };
}

export const QUEUE_ITEM = `select ${COLS.replace(" from ", ", t.advert_text from ")} left join job_text t on t.job_id = j.id where r.id = $1::bigint and r.queue = 'fetched_job'`;

/** One fetched_job item, whatever its status, with the saved advert text. null when the id is not a fetched_job item. */
export async function getItem(db: Pick<pg.Pool, "query">, staffUserId: string, id: string | number): Promise<(QueueItem & { advertText: string | null }) | null> {
  await checkReviewer(db, staffUserId);
  const key = String(id);
  if (!validId(key)) return null;
  const r = (await db.query<Row & { advert_text: string | null }>(QUEUE_ITEM, [key])).rows[0];
  return r ? { ...item(r), advertText: r.advert_text } : null;
}

// ===== the actions =====
// One statement: sets the acting id and answers two questions. A role is not implied by another (an administrator is not a fetched-job reviewer, #193).
export const QUEUE_ACT =
  "select set_config('app.staff_user_id', $1, true), exists (select 1 from staff_user where id = $1 and status = 'active') as active, " +
  "exists (select 1 from staff_user u join staff_role r on r.staff_user_id = u.id where u.id = $1 and u.status = 'active' and r.role = 'fetched_job_reviewer') as reviewer";

async function acting<T>(db: Db, staffUserId: string, itemId: string | number, fn: (c: pg.PoolClient, item: string) => Promise<T>): Promise<T> {
  if (typeof staffUserId !== "string" || staffUserId.length === 0 || staffUserId.length > 200) throw new QueueRefused("not_active_staff");
  const key = String(itemId);
  if (!validId(key)) throw new QueueRefused("not_found");
  const c = await db.connect();
  try {
    await c.query("begin");
    const r = (await c.query<{ active: boolean; reviewer: boolean }>(QUEUE_ACT, [staffUserId])).rows[0]!;
    if (!r.active) throw new QueueRefused("not_active_staff");
    if (!r.reviewer) throw new QueueRefused("not_reviewer");
    const out = await fn(c, key);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const CLAIM =
  "update review_item set status = 'claimed', claimed_by_staff_user_id = $2, claimed_at = now() " +
  "where id = $1::bigint and queue = 'fetched_job' and status = 'open' returning id";
const STATE = "select status, claimed_by_staff_user_id from review_item where id = $1::bigint and queue = 'fetched_job'";

// A claim goes stale after a working day (the PRD's "admin queue cleared within 1 working day"), or at once when its holder is no longer active,
// so an absent or disabled staff member never blocks an item. Taking over and giving back each write one audit row, in the same statement.
export const STALE_AFTER = "24 hours";
const CLAIM_AUDIT =
  "insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, changed_columns, before, after, source) " +
  "select 'admin_action', $2, $3, 'review_item', $1::text, '{claimed_by_staff_user_id}', jsonb_build_object('claimed_by_staff_user_id', old_by), " +
  "jsonb_build_object('claimed_by_staff_user_id', new_by), 'panel' from w returning id";
// The where clause is checked again under the row lock, so of two staff taking over at once only one matches (the claim is then fresh).
export const TAKE_OVER =
  "with o as (select id, claimed_by_staff_user_id as old_by from review_item where id = $1::bigint and queue = 'fetched_job' and status = 'claimed'), " +
  "w as (update review_item r set claimed_by_staff_user_id = $2, claimed_at = now() from o where r.id = o.id and r.status = 'claimed' " +
  "and r.claimed_by_staff_user_id <> $2 and (r.claimed_at < now() - $4::interval " +
  "or not exists (select 1 from staff_user u where u.id = r.claimed_by_staff_user_id and u.status = 'active')) returning r.id, o.old_by, $2::text as new_by) " +
  CLAIM_AUDIT;
export const RELEASE =
  "with w as (update review_item set status = 'open', claimed_by_staff_user_id = null, claimed_at = null " +
  "where id = $1::bigint and queue = 'fetched_job' and status = 'claimed' and claimed_by_staff_user_id = $2 returning id, $2::text as old_by, null::text as new_by) " +
  CLAIM_AUDIT;

/**
 * Open to claimed by this staff member. Claiming an item one already holds is a no-op. Someone else's claim is taken over when it is stale
 * (older than STALE_AFTER, or its holder is no longer active); otherwise it is refused, as is a decided item.
 */
export async function claim(db: Db, staffUserId: string, itemId: string | number): Promise<void> {
  await acting(db, staffUserId, itemId, async (c, id) => {
    if ((await c.query(CLAIM, [id, staffUserId])).rowCount === 1) return;
    const s = (await c.query<{ status: string; claimed_by_staff_user_id: string | null }>(STATE, [id])).rows[0];
    if (!s) throw new QueueRefused("not_found");
    if (s.status === "claimed" && s.claimed_by_staff_user_id === staffUserId) return;
    if (s.status !== "claimed") throw new QueueRefused("already_decided");
    if ((await c.query(TAKE_OVER, [id, staffUserId, "fetched_job.take_over", STALE_AFTER])).rowCount === 1) return;
    throw new QueueRefused("claimed_by_other");
  });
}

/** Claimed back to open, by the claimer only, so someone else can pick it up. */
export async function release(db: Db, staffUserId: string, itemId: string | number): Promise<void> {
  await acting(db, staffUserId, itemId, async (c, id) => {
    if ((await c.query(RELEASE, [id, staffUserId, "fetched_job.release"])).rowCount === 1) return;
    const s = (await c.query<{ status: string; claimed_by_staff_user_id: string | null }>(STATE, [id])).rows[0];
    if (!s) throw new QueueRefused("not_found");
    throw new QueueRefused(s.status === "open" ? "not_claimed" : s.status === "claimed" ? "not_claimer" : "already_decided");
  });
}

// The item and its job, locked, so two staff cannot decide one item at once. The job's source kind feeds the chain's "known employer" test.
export const LOCK =
  "select r.status, r.claimed_by_staff_user_id, j.id as job_id, j.fetched_advert_id, j.status as job_status, j.title, j.employer_name, j.county, " +
  "j.occupation_code, j.sector, j.salary_low, j.salary_high, j.badge, j.pass_route, s.kind as source, t.advert_text " +
  "from review_item r join job j on j.id = r.job_id join job_source s on s.id = j.job_source_id left join job_text t on t.job_id = j.id " +
  "where r.id = $1::bigint and r.queue = 'fetched_job' for update of r, j";
type Locked = {
  status: string; claimed_by_staff_user_id: string | null; job_id: string; fetched_advert_id: string | null; job_status: string; title: string; employer_name: string;
  county: string | null; occupation_code: string | null; sector: string; salary_low: number | null; salary_high: number | null; badge: string | null;
  pass_route: string | null; source: string; advert_text: string | null;
};

async function lockForDecision(c: pg.PoolClient, id: string, staffUserId: string): Promise<Locked> {
  const r = (await c.query<Locked>(LOCK, [id])).rows[0];
  if (!r) throw new QueueRefused("not_found");
  if (r.status !== "claimed") throw new QueueRefused(r.status === "open" ? "not_claimed" : "already_decided");
  if (r.claimed_by_staff_user_id !== staffUserId) throw new QueueRefused("not_claimer");
  if (r.job_status !== "in_review") throw new QueueRefused("job_not_in_review");
  return r;
}

// One statement for the job, the advert row, the item and its audit row. $1 job, $2 item, $3 staff, $4 job columns (jsonb), $5 advert result,
// $6 outcome, $7 action, $8 reason code, $9 changed columns, $10 before, $11 after. The job keeps the guard rails of the update: still in_review.
export const DECIDE =
  "with j as (update job set status = $4::jsonb->>'status', badge = $4::jsonb->>'badge', pass_route = $4::jsonb->>'pass_route', " +
  "occupation_code = $4::jsonb->>'occupation_code', sector = $4::jsonb->>'sector', salary_low = ($4::jsonb->>'salary_low')::int, " +
  "salary_high = ($4::jsonb->>'salary_high')::int, close_reason = $4::jsonb->>'close_reason', " +
  "closed_at = case when $4::jsonb->>'status' = 'closed' then now() end, " +
  "search_vector = case when $4::jsonb->>'status' = 'live' then to_tsvector('english', title || ' ' || employer_name || ' ' || coalesce((select advert_text from job_text where job_id = $1::bigint), '')) else search_vector end " +
  "where id = $1::bigint and status = 'in_review' returning id, fetched_advert_id), " +
  "f as (update fetched_advert set result = $5 where id = (select fetched_advert_id from j)), " +
  "r as (update review_item set status = 'done', decided_by_staff_user_id = $3, decided_at = now(), outcome = $6 " +
  "where id = $2::bigint and status = 'claimed' and claimed_by_staff_user_id = $3 and exists (select 1 from j) returning id) " +
  "insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, changed_columns, before, after, reason_code, source) " +
  "select 'admin_action', $3, $7, 'job', $1::text, $9::text[], $10::jsonb, $11::jsonb, $8, 'panel' from r returning id";

type JobCols = {
  status: string; badge: string | null; pass_route: string | null; occupation_code: string | null; sector: string; salary_low: number | null;
  salary_high: number | null; close_reason: string | null;
};

async function decide(c: pg.PoolClient, id: string, staffUserId: string, r: Locked, after: JobCols, result: string, outcome: string, action: string, reason: string) {
  const before: JobCols = {
    status: r.job_status, badge: r.badge, pass_route: r.pass_route, occupation_code: r.occupation_code, sector: r.sector, salary_low: r.salary_low,
    salary_high: r.salary_high, close_reason: null,
  };
  const changed = (Object.keys(after) as (keyof JobCols)[]).filter((k) => after[k] !== before[k]);
  const pick = (o: JobCols) => Object.fromEntries(changed.map((k) => [k, o[k]]));
  const w = await c.query(DECIDE, [r.job_id, id, staffUserId, JSON.stringify(after), result, outcome, action, reason, changed, JSON.stringify(pick(before)), JSON.stringify(pick(after))]);
  if (w.rowCount !== 1) throw new Error("the decision did not write exactly one audit row"); // rolls back; the locks above make this unreachable
}

// ===== approve =====
/** The list data the occupation matcher uses: packages/fetcher/data/occupation-lists.json (`ListEntry` in @portal/matcher). */
export type ListEntries = readonly { code: string; list: string }[];
/** What the rules chain needs besides the matcher (the fetcher's `chain`), and the occupation lists. The caller loads them as the fetcher does. */
export type RulesData = { chain: Omit<ChainData, "matcher">; lists: ListEntries };
export type ApproveInput = { occupationCode: string; salaryLow?: number; salaryHigh?: number; contractConfirmed?: boolean };

const MAX_PAY = 1_000_000; // a year, in euro. Over it is a typing mistake.
const pay = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= MAX_PAY;

/** The Critical Skills list answer for a code, from the lists: "yes" when a Critical Skills entry has it, "no" when only an ineligible one does. */
export function listAnswer(lists: ListEntries, code: string): "yes" | "no" | null {
  // ponytail: 2229 is on both lists (orthoptists are Critical Skills, other therapists ineligible). A staff member who picks it is taken to mean
  // the Critical Skills entry; give staff the entry id instead of the code if that is ever in doubt.
  if (lists.some((e) => e.code === code && e.list === "critical-skills")) return "yes";
  return lists.some((e) => e.code === code && e.list === "ineligible") ? "no" : null;
}

/** Checks the staff input (hostile input refused) and turns it into the chain's staff input and the matcher's answer. Pure. */
export function checkApproveInput(input: ApproveInput, lists: ListEntries): { staff: StaffInput; onList: "yes" | "no" } {
  if (input === null || typeof input !== "object") throw new QueueRefused("bad_input");
  const { occupationCode: code, salaryLow: low, salaryHigh: high, contractConfirmed } = input;
  if (typeof code !== "string" || !/^[0-9]{4}$/.test(code)) throw new QueueRefused("bad_occupation_code");
  const onList = listAnswer(lists, code);
  if (onList === null) throw new QueueRefused("bad_occupation_code");
  if (contractConfirmed !== undefined && typeof contractConfirmed !== "boolean") throw new QueueRefused("bad_input");
  if ((low !== undefined && !pay(low)) || (high !== undefined && !pay(high))) throw new QueueRefused("bad_salary");
  if (low === undefined && high !== undefined) throw new QueueRefused("bad_salary"); // a top with no bottom: the chain reads "from" pay only
  if (low !== undefined && high !== undefined && high < low) throw new QueueRefused("bad_salary");
  const staff: StaffInput = { contractConfirmed: contractConfirmed === true };
  if (low !== undefined) staff.salary = { low, high: high ?? low };
  return { staff, onList };
}

/** Runs the rules chain on the saved advert with the staff member's code and input (#166). Returns the assessment and the pass route, or null. */
export async function reassess(r: Pick<Locked, "title" | "employer_name" | "county" | "source" | "advert_text">, code: string, onList: "yes" | "no", staff: StaffInput, chain: RulesData["chain"]) {
  const a: Assessment = await assess(
    {
      source: r.source,
      title: r.title,
      employer: r.employer_name,
      // The advert's own location is not stored, only its county. Every queued job already passed the location test when it was fetched (a fail
      // there is a reject, never a job), so this only costs the Irish-employer check what the location text added (a town, a second place).
      location: r.county ? `${r.county}, Ireland` : "Ireland",
      description: r.advert_text ?? "",
      // The employment type and the salary box are not stored either: staff confirm the contract and type the pay instead.
      employmentType: "",
      salaryBox: "",
    },
    { ...chain, matcher: async () => ({ occupationCode: code, onCriticalSkillsList: onList, confidence: "high" }) },
    staff,
  );
  // The same test as planAdvert (packages/fetcher/src/plan.ts): only these two buckets go live, and never with scam wording.
  const passed = a.bucket === "stated_pay" || a.bucket === "big_company" ? a.bucket : null;
  return { a, route: a.scamFlag ? null : passed, stage: passed && a.scamFlag ? "0 scam wording (admin queue)" : a.stage };
}

/**
 * Approve: the claimer's occupation code (and pay and contract, if given) and the rules re-run on the saved advert. Only a pass the fetcher
 * would make live goes live, with the columns the fetcher writes for a passed job. Otherwise refused ("rules_failed" with the stage) and the
 * item stays claimed, so staff can reject it.
 */
export async function approve(db: Db, staffUserId: string, itemId: string | number, input: ApproveInput, data: RulesData): Promise<{ jobId: string; passRoute: string }> {
  const { staff, onList } = checkApproveInput(input, data.lists);
  return acting(db, staffUserId, itemId, async (c, id) => {
    const r = await lockForDecision(c, id, staffUserId);
    if (r.advert_text === null) throw new QueueRefused("no_advert_text");
    const { a, route, stage } = await reassess(r, input.occupationCode, onList, staff, data.chain);
    if (!route) throw new QueueRefused("rules_failed", stage);
    // planAdvert's `euros`: the reader keeps 15,000 to 400,000 and staff pay is checked above, so every amount fits the integer column.
    const after: JobCols = {
      status: "live", badge: "critical_skills_eligible", pass_route: route, occupation_code: input.occupationCode, sector: a.sector,
      salary_low: a.salaryLow === null ? null : Math.round(a.salaryLow), salary_high: a.salaryHigh === null ? null : Math.round(a.salaryHigh), close_reason: null,
    };
    await decide(c, id, staffUserId, r, after, "passed", "approved", "fetched_job.approve", "approved");
    return { jobId: r.job_id, passRoute: route };
  });
}

// ===== reject =====
const REASON = /^[a-z][a-z0-9_]{0,62}$/; // a reason code, never free text: the audit log holds no free text (design section 6)

/** Reject: the item is done as rejected and the job is closed the way a staff removal closes it (close_job_removed: closed, 'removed'). */
export async function reject(db: Db, staffUserId: string, itemId: string | number, reason: string): Promise<void> {
  if (typeof reason !== "string" || !REASON.test(reason)) throw new QueueRefused("bad_reason");
  await acting(db, staffUserId, itemId, async (c, id) => {
    const r = await lockForDecision(c, id, staffUserId);
    const after: JobCols = {
      status: "closed", badge: r.badge, pass_route: r.pass_route, occupation_code: r.occupation_code, sector: r.sector, salary_low: r.salary_low,
      salary_high: r.salary_high, close_reason: "removed",
    };
    await decide(c, id, staffUserId, r, after, "rejected", "rejected", "fetched_job.reject", reason);
  });
}
