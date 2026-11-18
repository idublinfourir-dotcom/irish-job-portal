// Trust and safety (#44, #91, #104, #133 to #137, #213 to #215): the reports queue, strike and ban cases with the fair process and the two-person rule,
// appeals and ban lifts. Run as app_admin, mirroring account-review.ts: every action takes the acting staff member's id and, in its first statement,
// checks the person is active staff WITH the trust_and_safety role (no other role stands in, #137 b) and sets app.staff_user_id for the transaction.
// The database stays the guard (strike_guard, approval_check, approval_request_guard, organisation_guard, ban_matches_case); the checks here only give
// short refusal codes before it would refuse. Audit rows hold codes only, never free text (#182). Notices are email_outbox rows; nothing sends them until 8.1b.
import type pg from "pg";
import { FREE_EMAIL_DOMAINS, decodeReviewCursor } from "./account-review";
import { QueueRefused } from "./admin-queue";
import { PAGE_SIZE, validId } from "./search";
import { decodeIdCursor, encodeIdCursor } from "./wire";

type Db = Pick<pg.Pool, "query" | "connect">;
type Q = Pick<pg.Pool, "query">;

// ===== the pure rules (unit tested) =====
export const CASE_KINDS: Record<string, readonly string[]> = {
  false_claim: ["false_sponsorship"], false_pay_floor: ["false_pay_floor"], instant_ban: ["asks_for_money", "fake_company", "fake_job"],
};

/** The level of a new strike (#44, #214 a): 1 plus the strikes decided in the 12 months before `now` (overturned ones are left out by the caller), at most 3. */
export function levelFor(prior: Date[], now: Date): 1 | 2 | 3 {
  const from = new Date(now);
  from.setUTCMonth(from.getUTCMonth() - 12);
  return Math.min(3, prior.filter((d) => d > from).length + 1) as 1 | 2 | 3;
}

/**
 * Whether a case may be decided now, as a refusal code or null (#44 fair process, #213). Clearing is always allowed. A strike waits for the employer:
 * notified, and either a reply is in or the 7 days have passed. A ban waits for the 7 days to pass even after a reply, unless staff mark the evidence
 * conclusive, when it applies at once and the 7 days become the appeal window.
 */
export function decideTiming(o: { outcome: string; replyDueAt: Date | null; replied: boolean; conclusive: boolean; now: Date }): string | null {
  if (o.outcome === "cleared") return null;
  if (o.outcome === "ban" && o.conclusive) return null;
  if (o.replyDueAt === null) return "not_notified";
  if (o.outcome === "strike" && o.replied) return null;
  return o.now > o.replyDueAt ? null : "reply_window_open";
}

// ===== the role check =====
export const TS_ACT =
  "select set_config('app.staff_user_id', $1, true), exists (select 1 from staff_user where id = $1 and status = 'active') as active, " +
  "exists (select 1 from staff_user u join staff_role r on r.staff_user_id = u.id where u.id = $1 and u.status = 'active' and r.role = 'trust_and_safety') as ts";

async function checkTs(db: Q, staff: string): Promise<void> {
  if (typeof staff !== "string" || staff.length === 0 || staff.length > 200) throw new QueueRefused("not_active_staff");
  const r = (await db.query<{ active: boolean; ts: boolean }>(TS_ACT, [staff])).rows[0]!;
  if (!r.active) throw new QueueRefused("not_active_staff");
  if (!r.ts) throw new QueueRefused("not_trust_and_safety");
}

// The database's own refusals that a request can still meet, as codes; anything else stays an error (a 500).
function mapped(e: unknown): unknown {
  const { code, message = "" } = (e ?? {}) as { code?: string; message?: string };
  if (code !== "P0001") return e;
  if (message.includes("window is closed or not open")) return new QueueRefused("window_closed");
  if (message.includes("the case is decided, no reply")) return new QueueRefused("already_decided");
  return e;
}

async function acting<T>(db: Db, staff: string, id: string | number | null, fn: (c: pg.PoolClient, id: string) => Promise<T>): Promise<T> {
  if (typeof staff !== "string" || staff.length === 0 || staff.length > 200) throw new QueueRefused("not_active_staff");
  const key = id === null ? "" : String(id);
  if (id !== null && !validId(key)) throw new QueueRefused("not_found");
  const c = await db.connect();
  try {
    await c.query("begin");
    await checkTs(c, staff);
    const out = await fn(c, key);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw mapped(e);
  } finally {
    c.release();
  }
}

export const AUDIT =
  "insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, after, reason_code, second_staff_user_id, related_case, source) " +
  "values ('admin_action', $1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'panel')";
const audit = (c: pg.PoolClient, staff: string, action: string, type: "report" | "strike", id: string, after: object, o: { reason?: string; second?: string; caseId?: string } = {}) =>
  c.query(AUDIT, [staff, `trust_safety.${action}`, type, id, JSON.stringify(after), o.reason ?? null, o.second ?? null, o.caseId ? `strike:${o.caseId}` : null]);

const camel = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase()), v]));

// ===== reports: list and look =====
const REPORT_COLS =
  "r.id, r.status, r.target_kind, r.reason, r.created_at::text as created_text, r.target_job_id, j.title as job_title, j.status as job_status, " +
  "j.organisation_id, o.display_name from report r left join job j on j.id = r.target_job_id left join organisation o on o.id = j.organisation_id";
// Oldest first on report_inbox_idx (status, created_at, id) where status in ('open','job_hidden').
const INBOX = "r.status in ('open','job_hidden')";
export const REPORTS_FIRST = `select ${REPORT_COLS} where ${INBOX} order by r.created_at, r.id limit ${PAGE_SIZE + 1}`;
export const REPORTS_AFTER = `select ${REPORT_COLS} where ${INBOX} and (r.created_at, r.id) > ($1::timestamptz, $2::bigint) order by r.created_at, r.id limit ${PAGE_SIZE + 1}`;
export const REPORT_ITEM =
  `select ${REPORT_COLS.replace(" from ", ", r.evidence_text, r.target_snapshot, r.reporter_candidate_user_id, r.reporter_portal_user_id, r.decided_by_staff_user_id, r.decided_at, " +
    "(select min(s.id) from strike s where s.report_id = r.id) as case_id from ")} where r.id = $1::bigint`;

type ReportRow = Record<string, unknown> & { id: string; created_text: string };
const encode = (r: ReportRow) => Buffer.from(JSON.stringify({ t: r.created_text, i: r.id })).toString("base64url");

/** Open and job_hidden reports, oldest first, a page at a time. The list shows no evidence text and no reporter. */
export async function listReports(db: Q, staff: string, opts: { after?: string } = {}) {
  const cursor = opts.after === undefined ? undefined : decodeReviewCursor(opts.after);
  await checkTs(db, staff);
  const all = (cursor ? await db.query<ReportRow>(REPORTS_AFTER, cursor) : await db.query<ReportRow>(REPORTS_FIRST)).rows;
  const rows = all.slice(0, PAGE_SIZE);
  return { items: rows.map(camel), next: all.length > PAGE_SIZE ? encode(rows.at(-1)!) : null };
}

/** One report with its evidence, the job as reported and, for staff only, who reported it (until the report is decided, when the database drops the reporter). */
export async function getReport(db: Q, staff: string, id: string | number) {
  await checkTs(db, staff);
  const key = String(id);
  if (!validId(key)) return null;
  const r = (await db.query<ReportRow>(REPORT_ITEM, [key])).rows[0];
  return r ? camel(r) : null;
}

// ===== reports: hide, clear, uphold =====
// Only job reports are handled here (the one kind the report routes make); any other kind is not_found.
export const REPORT_LOCK =
  "select r.status, r.target_job_id, j.status as job_status, j.organisation_id from report r join job j on j.id = r.target_job_id where r.id = $1::bigint for update of r, j";
type ReportLock = { status: string; target_job_id: string; job_status: string; organisation_id: string };
async function lockReport(c: pg.PoolClient, id: string): Promise<ReportLock> {
  const r = (await c.query<ReportLock>(REPORT_LOCK, [id])).rows[0];
  if (!r) throw new QueueRefused("not_found");
  if (r.status === "cleared" || r.status === "upheld") throw new QueueRefused("already_decided");
  return r;
}
const HIDE_JOB = "update job set status = 'hidden', hidden_reason = 'report', hidden_report_id = $1::bigint where id = $2::bigint and status = 'live'";
// The job comes back when its company may show jobs; otherwise it stays hidden under the company's suspension.
const UNHIDE_JOB =
  "update job set status = case when o.status in ('suspended','banned','closed') then 'hidden' else 'live' end, " +
  "hidden_reason = case when o.status in ('suspended','banned','closed') then 'organisation_suspended' end, hidden_report_id = null " +
  "from organisation o where o.id = job.organisation_id and job.hidden_report_id = $1::bigint and job.status = 'hidden'";
// The database requires the reporter to be gone once a report is cleared or upheld (report_check3), so the decision drops it.
const DECIDE_REPORT =
  "update report set status = $2, reporter_candidate_user_id = null, reporter_portal_user_id = null, decided_by_staff_user_id = $3, decided_at = now() where id = $1::bigint";

/** A trust and safety officer judges the evidence plausible (#214 c): the live job is hidden at once. Hiding is not a strike (#91). */
export async function hideReportedJob(db: Db, staff: string, reportId: string | number): Promise<void> {
  await acting(db, staff, reportId, async (c, id) => {
    const r = await lockReport(c, id);
    if (r.status === "job_hidden") throw new QueueRefused("already_hidden");
    if ((await c.query(HIDE_JOB, [id, r.target_job_id])).rowCount !== 1) throw new QueueRefused("job_not_live");
    await c.query("update report set status = 'job_hidden' where id = $1::bigint", [id]);
    await audit(c, staff, "report_hide", "report", id, { status: "job_hidden" });
  });
}

/** Not upheld: the report is cleared and a job it hid comes back. */
export async function clearReport(db: Db, staff: string, reportId: string | number): Promise<void> {
  await acting(db, staff, reportId, async (c, id) => {
    await lockReport(c, id);
    await c.query(UNHIDE_JOB, [id]);
    await c.query(DECIDE_REPORT, [id, "cleared", staff]);
    await audit(c, staff, "report_clear", "report", id, { status: "cleared" });
  });
}

export type CaseInput = { caseKind: string; reasonCode: string; noticeSummary?: string };
/** Upheld: the database closes a job the report hid (report_upheld) and a case opens on the job's company. Returns the case id. */
export async function upholdReport(db: Db, staff: string, reportId: string | number, input: CaseInput): Promise<{ caseId: string }> {
  checkCase(input);
  return acting(db, staff, reportId, async (c, id) => {
    const r = await lockReport(c, id);
    await c.query(DECIDE_REPORT, [id, "upheld", staff]);
    await audit(c, staff, "report_uphold", "report", id, { status: "upheld" });
    await c.query("select id from organisation where id = $1::bigint for update", [r.organisation_id]);
    return { caseId: await openIn(c, staff, r.organisation_id, r.target_job_id, id, input) };
  });
}

// ===== cases: open =====
function checkCase(i: CaseInput) {
  if (!CASE_KINDS[i.caseKind]?.includes(i.reasonCode)) throw new QueueRefused("bad_reason");
}
const OPEN_CASE =
  "insert into strike(organisation_id, case_kind, job_id, report_id, reason_code, notice_summary) values ($1::bigint, $2, $3::bigint, $4::bigint, $5, $6) returning id";
// An instant-ban case (#213): the company's live jobs are hidden and a verified company suspended at once; the ban itself waits for the decision.
const SUSPEND = "update organisation set status = 'suspended' where id = $1::bigint and status in ('verified','verified_restricted')";
const HIDE_ALL = "update job set status = 'hidden', hidden_reason = 'organisation_suspended' where organisation_id = $1::bigint and status = 'live'";
const UNSUSPEND = "update organisation set status = 'verified' where id = $1::bigint and status = 'suspended'";
const UNHIDE_ALL = "update job set status = 'live', hidden_reason = null where organisation_id = $1::bigint and status = 'hidden' and hidden_reason = 'organisation_suspended'";

async function openIn(c: pg.PoolClient, staff: string, org: string, job: string | null, report: string | null, i: CaseInput): Promise<string> {
  const id = (await c.query<{ id: string }>(OPEN_CASE, [org, i.caseKind, job, report, i.reasonCode, i.noticeSummary ?? null])).rows[0]!.id;
  if (i.caseKind === "instant_ban") {
    await c.query(SUSPEND, [org]);
    await c.query(HIDE_ALL, [org]);
  }
  await audit(c, staff, "case_open", "strike", id, { case_kind: i.caseKind, stage: "case_open" }, { reason: i.reasonCode, caseId: id });
  return id;
}

/** A case opened by hand on a company, optionally about one of its jobs. */
export async function openCase(db: Db, staff: string, input: CaseInput & { organisationId: string; jobId?: string }): Promise<{ caseId: string }> {
  checkCase(input);
  if (!validId(input.organisationId) || (input.jobId !== undefined && !validId(input.jobId))) throw new QueueRefused("not_found");
  return acting(db, staff, null, async (c) => {
    if ((await c.query("select id from organisation where id = $1::bigint for update", [input.organisationId])).rowCount !== 1) throw new QueueRefused("not_found");
    if (input.jobId !== undefined && (await c.query("select 1 from job where id = $1::bigint and organisation_id = $2::bigint", [input.jobId, input.organisationId])).rowCount !== 1)
      throw new QueueRefused("job_not_in_organisation");
    return { caseId: await openIn(c, staff, input.organisationId, input.jobId ?? null, null, input) };
  });
}

// ===== cases: list and look =====
export const NEEDS_ACTION =
  "(s.outcome is null or (s.appealed_at is not null and s.appeal_decided_at is null) or exists (select 1 from ban b join approval_request a " +
  "on a.target_table = 'ban' and a.target_id = b.id::text and a.status = 'pending' where b.strike_id = s.id))";
export const CASES =
  "select s.id, s.organisation_id, o.display_name, s.case_kind, s.reason_code, s.stage, s.outcome, s.level, s.reply_due_at, s.appeal_due_at, s.created_at " +
  `from strike s join organisation o on o.id = s.organisation_id where ${NEEDS_ACTION} and s.id > $1::bigint order by s.id limit ${PAGE_SIZE + 1}`;
export const CASE_ITEM =
  "select s.id, s.organisation_id, s.case_kind, s.job_id, s.report_id, s.reason_code, s.notice_summary, s.level, s.stage, s.outcome, s.reply_due_at, s.employer_reply, " +
  "s.replied_at, s.reply_received_at, s.reply_entered_by_staff_user_id, s.decided_by_staff_user_id, s.decided_at, s.approval_request_id, s.appeal_due_at, s.appeal_text, " +
  "s.appealed_at, s.appeal_received_at, s.appeal_entered_by_staff_user_id, s.appeal_decided_by_staff_user_id, s.appeal_decided_at, s.ban_lifted_at, s.created_at, " +
  "o.display_name, o.kind as organisation_kind, o.status as organisation_status, o.restricted_until, o.claims_removed_at, " +
  "(select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'change', a.change, 'proposedBy', a.proposed_by_staff_user_id) order by a.id), '[]') " +
  " from approval_request a where a.status = 'pending' and ((a.target_table = 'strike' and a.target_id = s.id::text) " +
  " or (a.target_table = 'ban' and a.target_id in (select b.id::text from ban b where b.strike_id = s.id)))) as pending, " +
  "(select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'croNumber', b.cro_number, 'emailDomain', b.email_domain, 'emailAddress', b.email_address) order by b.id), '[]') " +
  " from ban b where b.strike_id = s.id) as bans, " +
  "exists (select 1 from audit_event e where e.object_id = s.id::text and e.object_type = 'strike' and e.action = 'trust_safety.wrc_reported') as wrc_reported " +
  "from strike s join organisation o on o.id = s.organisation_id where s.id = $1::bigint";

/** Cases that need a step: undecided, an appeal waiting, or a ban lift waiting for its second person. Oldest first; `after` is the `next` of the page before. */
export async function listCases(db: Q, staff: string, opts: { after?: string } = {}) {
  const after = opts.after === undefined ? "0" : decodeIdCursor("cases", opts.after);
  await checkTs(db, staff);
  const all = (await db.query<Record<string, unknown> & { id: string }>(CASES, [after])).rows;
  const rows = all.slice(0, PAGE_SIZE);
  return { items: rows.map(camel), next: all.length > PAGE_SIZE ? encodeIdCursor("cases", rows.at(-1)!.id) : null };
}

/** One case with its company, pending two-person requests, ban rows and whether the WRC report is ticked off. */
export async function getCase(db: Q, staff: string, id: string | number) {
  await checkTs(db, staff);
  const key = String(id);
  if (!validId(key)) return null;
  const r = (await db.query(CASE_ITEM, [key])).rows[0];
  return r ? camel(r) : null;
}

// ===== cases: the steps =====
export const CASE_LOCK =
  "select s.id, s.organisation_id, s.case_kind, s.reason_code, s.level, s.stage, s.outcome, s.reply_due_at, s.replied_at, s.reply_entered_by_staff_user_id, " +
  "s.decided_by_staff_user_id, s.approval_request_id, s.appeal_due_at, s.appealed_at, s.appeal_entered_by_staff_user_id, s.appeal_decided_at, o.kind as organisation_kind " +
  "from strike s join organisation o on o.id = s.organisation_id where s.id = $1::bigint for update of s, o";
type Case = {
  id: string; organisation_id: string; case_kind: string; reason_code: string; level: number | null; stage: string; outcome: string | null;
  reply_due_at: Date | null; replied_at: Date | null; reply_entered_by_staff_user_id: string | null; decided_by_staff_user_id: string | null;
  approval_request_id: string | null; appeal_due_at: Date | null; appealed_at: Date | null; appeal_entered_by_staff_user_id: string | null;
  appeal_decided_at: Date | null; organisation_kind: string;
};
async function lockCase(c: pg.PoolClient, id: string): Promise<Case> {
  const r = (await c.query<Case>(CASE_LOCK, [id])).rows[0];
  if (!r) throw new QueueRefused("not_found");
  return r;
}

// A notice to the company's account owner and the job's poster (#44, 20b section 4), one row each, deduplicated. Params are ids, codes and dates only.
export const NOTICE =
  "insert into email_outbox(template, portal_user_id, params, dedupe_key) " +
  "select $2, u.pid, jsonb_build_object('strike_id', s.id, 'case_kind', s.case_kind, 'stage', s.stage, 'outcome', s.outcome, 'level', s.level, " +
  "'reply_due_at', s.reply_due_at, 'appeal_due_at', s.appeal_due_at), 'strike:' || s.id || ':' || $2 || ':' || u.pid " +
  "from strike s cross join lateral (select m.portal_user_id as pid from membership m where m.organisation_id = s.organisation_id and m.role = 'account_owner' " +
  "and m.status = 'active' and m.portal_user_id is not null union select m.portal_user_id from job j join membership m on m.id = j.posted_by_membership_id " +
  "where j.id = s.job_id and m.status = 'active' and m.portal_user_id is not null) u where s.id = $1::bigint on conflict (dedupe_key) do nothing";
const notice = async (c: pg.PoolClient, id: string, template: string) => (await c.query(NOTICE, [id, template])).rowCount ?? 0;

/** Tell the employer: the 7-day reply window starts now. Returns how many notices were queued (0 when the company has no owner or poster). */
export async function notifyEmployer(db: Db, staff: string, caseId: string | number): Promise<{ notices: number }> {
  return acting(db, staff, caseId, async (c, id) => {
    const k = await lockCase(c, id);
    if (k.reply_due_at !== null || k.stage !== "case_open") throw new QueueRefused("already_notified");
    await c.query("update strike set reply_due_at = now() + interval '7 days', stage = 'employer_notified' where id = $1::bigint", [id]);
    const n = await notice(c, id, "strike_case_opened");
    await audit(c, staff, "case_notify", "strike", id, { stage: "employer_notified", notices: n }, { caseId: id });
    return { notices: n };
  });
}

/** A reply that came by email or post (#136 b), with the date it arrived. The database checks the window and stamps who entered it; that person may not decide the case. */
export async function recordReply(db: Db, staff: string, caseId: string | number, text: string, receivedAt: string): Promise<void> {
  await acting(db, staff, caseId, async (c, id) => {
    const k = await lockCase(c, id);
    if (k.outcome !== null) throw new QueueRefused("already_decided");
    if (k.reply_due_at === null) throw new QueueRefused("not_notified");
    await c.query("update strike set employer_reply = $2, reply_received_at = $3::timestamptz where id = $1::bigint", [id, text, receivedAt]);
    await audit(c, staff, "reply_entered", "strike", id, { replied: true }, { caseId: id });
  });
}

const DECISION_KINDS = "('strike_2','strike_3','ban')";
const PENDING_DECISION =
  `select id, kind, change, proposed_by_staff_user_id from approval_request where kind in ${DECISION_KINDS} and target_table = 'strike' and target_id = $1 and status = 'pending' for update`;
const ORG_PENDING =
  `select exists (select 1 from approval_request a where a.kind in ${DECISION_KINDS} and a.target_table = 'strike' and a.status = 'pending' ` +
  "and a.target_id in (select id::text from strike where organisation_id = $1::bigint)) as pending";
const PRIOR = "select decided_at from strike where organisation_id = $1::bigint and id <> $2::bigint and outcome = 'strike' and stage <> 'overturned' and decided_at is not null";
const PROPOSE = "insert into approval_request(kind, target_table, target_id, change, reason) values ($1, 'strike', $2, $3::jsonb, $4) returning id";
const APPLY =
  "update strike set outcome = $2, level = $3, approval_request_id = $4::bigint, stage = 'applied', appeal_due_at = now() + interval '7 days' where id = $1::bigint";

export type Decision = { outcome: string; level?: number; applied: boolean; requestId?: string };

/**
 * Decide a case: cleared, a strike (its level counted from the last 12 months), or a ban (instant-ban cases only). Clearing and strike 1 apply at
 * once (one person). Strike 2, strike 3 and a ban are proposed here and wait for a second trust and safety officer (confirmDecision).
 */
export async function decideCase(db: Db, staff: string, caseId: string | number, d: { outcome: string; conclusive?: boolean }): Promise<Decision> {
  const conclusive = d.conclusive === true;
  if (d.conclusive !== undefined && (typeof d.conclusive !== "boolean" || d.outcome !== "ban")) throw new QueueRefused("bad_input");
  return acting(db, staff, caseId, async (c, id) => {
    const k = await lockCase(c, id);
    if (k.outcome !== null) throw new QueueRefused("already_decided");
    if ((await c.query(PENDING_DECISION, [id])).rowCount) throw new QueueRefused("decision_pending");
    const allowed = k.case_kind === "instant_ban" ? ["cleared", "ban"] : ["cleared", "strike"];
    if (!allowed.includes(d.outcome)) throw new QueueRefused("bad_outcome");
    if (staff === k.reply_entered_by_staff_user_id) throw new QueueRefused("entered_reply"); // #136 b
    const late = decideTiming({ outcome: d.outcome, replyDueAt: k.reply_due_at, replied: k.replied_at !== null, conclusive, now: new Date() });
    if (late) throw new QueueRefused(late);
    if (d.outcome === "cleared") {
      await c.query("update strike set outcome = 'cleared', stage = 'decided' where id = $1::bigint", [id]);
      if (k.case_kind === "instant_ban") {
        await c.query(UNSUSPEND, [k.organisation_id]);
        await c.query(UNHIDE_ALL, [k.organisation_id]);
      }
      await notice(c, id, "strike_case_cleared");
      await audit(c, staff, "case_decide", "strike", id, { outcome: "cleared" }, { caseId: id });
      return { outcome: "cleared", applied: true };
    }
    if ((await c.query<{ pending: boolean }>(ORG_PENDING, [k.organisation_id])).rows[0]!.pending) throw new QueueRefused("other_case_pending");
    const level = d.outcome === "ban" ? undefined : levelFor((await c.query<{ decided_at: Date }>(PRIOR, [k.organisation_id, id])).rows.map((r) => r.decided_at), new Date());
    if (level === 1) {
      await c.query(APPLY, [id, "strike", 1, null]);
      await notice(c, id, "strike_decided");
      await audit(c, staff, "case_decide", "strike", id, { outcome: "strike", level: 1, stage: "applied" }, { caseId: id });
      return { outcome: "strike", level: 1, applied: true };
    }
    const kind = d.outcome === "ban" ? "ban" : `strike_${level}`;
    const change = d.outcome === "ban" ? { outcome: "ban", conclusive } : { outcome: "strike", level };
    const req = (await c.query<{ id: string }>(PROPOSE, [kind, id, JSON.stringify(change), k.reason_code])).rows[0]!.id;
    await audit(c, staff, "case_propose", "strike", id, { ...change, request_id: req }, { caseId: id });
    return { outcome: d.outcome, ...(level ? { level } : {}), applied: false, requestId: req };
  });
}

// Ban rows (#44, #137 a, #215): the company's CRO number, its domains from before the case opened (never a free provider's), and the exact addresses of
// its people who joined before the case opened and whose domain no ban covers. A row another case already holds is skipped.
const BAN_CRO =
  "insert into ban(cro_number, reason_code, strike_id, approval_request_id) select o.cro_number, $2, s.id, s.approval_request_id " +
  "from strike s join organisation o on o.id = s.organisation_id where s.id = $1::bigint and o.cro_number is not null on conflict do nothing";
const BAN_DOMAINS =
  "insert into ban(email_domain, reason_code, strike_id, approval_request_id) select d.domain, $2, s.id, s.approval_request_id " +
  "from strike s join organisation_domain d on d.organisation_id = s.organisation_id where s.id = $1::bigint and d.created_at < s.created_at " +
  "and d.domain <> all($3::text[]) on conflict do nothing";
const BAN_ADDRESSES =
  "insert into ban(email_address, reason_code, strike_id, approval_request_id) select distinct lower(u.email), $2, s.id, s.approval_request_id " +
  "from strike s join membership m on m.organisation_id = s.organisation_id join portal_user u on u.id = m.portal_user_id " +
  "where s.id = $1::bigint and m.status = 'active' and m.joined_at < s.created_at " +
  "and not exists (select 1 from ban b where b.email_domain = lower(split_part(u.email, '@', 2))) on conflict do nothing";
const FREE = [...FREE_EMAIL_DOMAINS];

async function applyBan(c: pg.PoolClient, k: Case, reason: string): Promise<void> {
  await c.query(BAN_CRO, [k.id, reason]);
  await c.query(BAN_DOMAINS, [k.id, reason, FREE]);
  await c.query(BAN_ADDRESSES, [k.id, reason]);
  if ((await c.query("select 1 from ban where strike_id = $1::bigint limit 1", [k.id])).rowCount !== 1) throw new QueueRefused("nothing_to_ban");
  await c.query("update organisation set status = 'banned' where id = $1::bigint", [k.organisation_id]);
}

const PENDING_LIFTS =
  "select a.id, a.proposed_by_staff_user_id from approval_request a join ban b on a.target_table = 'ban' and a.target_id = b.id::text " +
  "where a.kind = 'ban_lift' and a.status = 'pending' and b.strike_id = $1::bigint for update of a";
const CONFIRM = "update approval_request set status = 'confirmed' where id = any($1::bigint[])";

/**
 * The second trust and safety officer confirms what is waiting on a case (#104, #137 b): a strike 2, strike 3 or ban decision, which is applied at
 * once in the same transaction; or the lift of the case's ban rows. Never the proposer, and never the person who entered the employer's reply.
 */
export async function confirmDecision(db: Db, staff: string, caseId: string | number): Promise<{ applied: string }> {
  return acting(db, staff, caseId, async (c, id) => {
    const k = await lockCase(c, id);
    const req = (await c.query<{ id: string; kind: string; change: { outcome: string; level?: number; conclusive?: boolean }; proposed_by_staff_user_id: string }>(PENDING_DECISION, [id])).rows[0];
    if (req) {
      if (req.proposed_by_staff_user_id === staff) throw new QueueRefused("same_person");
      if (staff === k.reply_entered_by_staff_user_id) throw new QueueRefused("entered_reply");
      const late = decideTiming({ outcome: req.change.outcome, replyDueAt: k.reply_due_at, replied: k.replied_at !== null, conclusive: req.change.conclusive === true, now: new Date() });
      if (late) throw new QueueRefused(late);
      await c.query(CONFIRM, [[req.id]]);
      await c.query(APPLY, [id, req.change.outcome, req.change.level ?? null, req.id]);
      const at = "(select applied_at from approval_request where id = $2::bigint)";
      if (req.kind === "strike_2") await c.query(`update organisation set restricted_until = ${at} + interval '90 days' where id = $1::bigint`, [k.organisation_id, req.id]);
      if (req.kind === "strike_3") {
        await c.query(`update organisation set claims_removed_at = ${at} where id = $1::bigint`, [k.organisation_id, req.id]);
        await applyBan(c, k, "strike_3");
      }
      if (req.kind === "ban") await applyBan(c, k, k.reason_code);
      await notice(c, id, "strike_decided");
      await audit(c, staff, "case_confirm", "strike", id, { ...req.change, stage: "applied", request_id: req.id }, { second: req.proposed_by_staff_user_id, caseId: id });
      return { applied: req.kind };
    }
    const lifts = (await c.query<{ id: string; proposed_by_staff_user_id: string }>(PENDING_LIFTS, [id])).rows;
    if (lifts.length === 0) throw new QueueRefused("nothing_pending");
    if (lifts.some((l) => l.proposed_by_staff_user_id === staff)) throw new QueueRefused("same_person");
    await c.query(CONFIRM, [lifts.map((l) => l.id)]);
    await c.query("delete from ban where strike_id = $1::bigint", [id]); // the database uses each confirmed ban_lift and stamps strike.ban_lifted_at
    // #214 b: "Sponsorship claims removed" ends with the ban; the company leaves banned once no ban row of its own stands
    await c.query(
      "update organisation o set claims_removed_at = null from strike s join approval_request a on a.id = s.approval_request_id " +
      "where s.id = $1::bigint and o.id = s.organisation_id and s.level = 3 and o.claims_removed_at = a.applied_at", [id]);
    await c.query(
      "update organisation o set status = case when exists (select 1 from membership m where m.organisation_id = o.id and m.role = 'account_owner' and m.status = 'active') " +
      "then 'verified' else 'unclaimed' end where o.id = $1::bigint and o.status = 'banned' and not exists (select 1 from ban b join strike s on s.id = b.strike_id where s.organisation_id = o.id)",
      [k.organisation_id]);
    await notice(c, id, "ban_lifted");
    await audit(c, staff, "ban_lift_confirm", "strike", id, { lifted: lifts.length }, { second: lifts[0]!.proposed_by_staff_user_id, caseId: id });
    return { applied: "ban_lift" };
  });
}

/** What is waiting on a case is dropped: refused by another officer, or withdrawn by its proposer. */
export async function refuseDecision(db: Db, staff: string, caseId: string | number): Promise<void> {
  await acting(db, staff, caseId, async (c, id) => {
    await lockCase(c, id);
    const ids = [...(await c.query<{ id: string }>(PENDING_DECISION, [id])).rows, ...(await c.query<{ id: string }>(PENDING_LIFTS, [id])).rows].map((r) => r.id);
    if (ids.length === 0) throw new QueueRefused("nothing_pending");
    await c.query("update approval_request set status = case when proposed_by_staff_user_id = $2 then 'withdrawn' else 'refused' end where id = any($1::bigint[])", [ids, staff]);
    await audit(c, staff, "request_drop", "strike", id, { requests: ids.length }, { caseId: id });
  });
}

const PROPOSE_LIFTS =
  "insert into approval_request(kind, target_table, target_id, reason) select 'ban_lift', 'ban', b.id::text, 'case ' || b.strike_id from ban b where b.strike_id = $1::bigint";
async function proposeLifts(c: pg.PoolClient, id: string): Promise<number> {
  try {
    await c.query("savepoint lift");
    const n = (await c.query(PROPOSE_LIFTS, [id])).rowCount ?? 0;
    await c.query("release savepoint lift");
    return n;
  } catch (e) {
    if ((e as { code?: string }).code !== "23505") throw e;
    await c.query("rollback to savepoint lift");
    throw new QueueRefused("decision_pending");
  }
}

/** Propose lifting the case's ban rows (#104: a second officer confirms with confirmDecision). */
export async function proposeBanLift(db: Db, staff: string, caseId: string | number): Promise<{ requests: number }> {
  return acting(db, staff, caseId, async (c, id) => {
    await lockCase(c, id);
    const n = await proposeLifts(c, id);
    if (n === 0) throw new QueueRefused("no_ban");
    await audit(c, staff, "ban_lift_propose", "strike", id, { requests: n }, { caseId: id });
    return { requests: n };
  });
}

/** An appeal that came by email or post (#135, #136 a), with the date it arrived. One appeal per case; the database checks the window. */
export async function recordAppeal(db: Db, staff: string, caseId: string | number, text: string, receivedAt: string): Promise<void> {
  await acting(db, staff, caseId, async (c, id) => {
    const k = await lockCase(c, id);
    if (k.appeal_decided_at !== null) throw new QueueRefused("appeal_decided");
    if (k.appealed_at !== null) throw new QueueRefused("already_appealed");
    if (k.appeal_due_at === null) throw new QueueRefused("no_appeal_window");
    await c.query("update strike set appeal_text = $2, appeal_received_at = $3::timestamptz, stage = 'appealed' where id = $1::bigint", [id, text, receivedAt]);
    await audit(c, staff, "appeal_entered", "strike", id, { stage: "appealed" }, { caseId: id });
  });
}

/**
 * Decide the appeal (#134: one person), never by whoever entered it (#135) or decided or proposed the case. Overturned: the database clears a strike 2
 * restriction or a strike 3 "claims removed"; ban rows need a lift, which is proposed here and confirmed by a second officer (#104).
 */
export async function decideAppeal(db: Db, staff: string, caseId: string | number, result: string): Promise<{ result: string; liftsProposed: number }> {
  if (result !== "upheld" && result !== "overturned") throw new QueueRefused("bad_input");
  return acting(db, staff, caseId, async (c, id) => {
    const k = await lockCase(c, id);
    if (k.appeal_decided_at !== null) throw new QueueRefused("appeal_decided");
    if (k.appealed_at === null) throw new QueueRefused("no_appeal");
    if (staff === k.appeal_entered_by_staff_user_id) throw new QueueRefused("entered_appeal");
    // #217: not the person who decided (for strike 2, 3 and bans, the confirmer); the proposer may decide, so two officers are enough
    if (staff === k.decided_by_staff_user_id) throw new QueueRefused("decided_case");
    await c.query("update strike set stage = $2 where id = $1::bigint", [id, result]);
    const lifts = result === "overturned" ? await proposeLifts(c, id) : 0;
    await notice(c, id, "appeal_decided");
    await audit(c, staff, "appeal_decide", "strike", id, { stage: result, lifts_proposed: lifts }, { caseId: id });
    return { result, liftsProposed: lifts };
  });
}

/** #214 d: staff tick off that an agency's instant-ban case was reported to the WRC. An audit row, once per case. */
export async function markWrcReported(db: Db, staff: string, caseId: string | number): Promise<void> {
  await acting(db, staff, caseId, async (c, id) => {
    const k = await lockCase(c, id);
    if (k.organisation_kind !== "agency" || k.case_kind !== "instant_ban") throw new QueueRefused("not_agency_ban");
    if ((await c.query("select 1 from audit_event where object_id = $1 and object_type = 'strike' and action = 'trust_safety.wrc_reported'", [id])).rowCount)
      throw new QueueRefused("already_marked");
    await audit(c, staff, "wrc_reported", "strike", id, { wrc_reported: true }, { caseId: id });
  });
}
