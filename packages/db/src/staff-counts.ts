// Staff notices (step 15 Q11): the open work a staff member may do, counted from their roles. Read at /api/staff/me/counts and by the daily digest
// (staff-digest-cli.ts). No relative imports, so the digest command can load this file with node. The caller reads the roles (staffRoles, or the
// digest's own query); a count the roles do not cover is null, never run.
import type pg from "pg";

/** Each review queue and the roles that work it (20c section 5 and the queue code: admin-queue, account-review, pay-floors, job-queues). */
export const QUEUE_ROLES: Record<string, readonly string[]> = {
  fetched_job: ["fetched_job_reviewer"],
  account_review: ["account_reviewer"],
  pay_floor_check: ["rules_data_editor", "administrator"],
  post_strike_job_review: ["account_reviewer", "administrator"],
  scam_flag: ["trust_and_safety", "administrator"],
  agency_client_check: ["account_reviewer", "administrator"],
  licence_lapse_job: ["account_reviewer", "administrator"],
  data_request: ["administrator"],
  scheduled_check: ["rules_data_editor", "fetched_job_reviewer", "administrator"], // by detail.role; an administrator sees them all (staff-tools.ts)
};
const has = (roles: readonly string[], any: readonly string[]) => any.some((r) => roles.includes(r));

// One statement. Uncorrelated subqueries run only when their CASE picks them (Postgres evaluates an InitPlan on first use). Each count is on an index:
// review_item_queue_idx, report_inbox_idx, strike_clock_idx, contact_message_inbox_idx, approval_request_pending_idx.
export const STAFF_COUNTS =
  "select (select coalesce(jsonb_object_agg(queue, n), '{}') from (select queue, count(*)::int n from review_item where status in ('open','claimed') and queue = any($1::text[]) " +
  "and (queue <> 'scheduled_check' or detail->>'role' = any($2::text[])) group by queue) q) as queues, " +
  "case when $3 then (select count(*)::int from report where status in ('open','job_hidden')) end as reports_open, " +
  "case when $3 then (select count(*)::int from report where status in ('open','job_hidden') and created_at > now() - interval '24 hours') end as reports_new, " +
  "case when $4 then (select count(*)::int from strike where stage = 'appealed') end as appeals, " +
  "case when $5 then (select count(*)::int from contact_message where status in ('new','claimed')) end as contact, " +
  "case when $6 then (select count(*)::int from approval_request where status = 'pending' and proposed_by_staff_user_id <> $7) end as approvals, " +
  // SV-B2: open services cases for handlers, unassigned (services_case_board_idx) and assigned to me (services_case_staff_idx)
  "case when $8 then (select count(*)::int from services_case where status <> 'closed' and assigned_staff_user_id is null) end as cases_unassigned, " +
  "case when $8 then (select count(*)::int from services_case where assigned_staff_user_id = $7 and status <> 'closed') end as cases_mine";

export type StaffCounts = {
  /** Open and claimed items per queue the member may work (a queue with none is left out). */
  queues: Record<string, number>;
  reportsOpen: number | null; reportsNew: number | null; appeals: number | null; contact: number | null;
  /** Two-person requests someone else proposed, waiting for a second person (administrators). */
  approvals: number | null;
  /** Open services cases nobody holds, and those assigned to this member (services case handlers). */
  casesUnassigned: number | null; casesMine: number | null;
};

/** The counts for one staff member with these roles. One statement. */
export async function staffCounts(db: Pick<pg.ClientBase, "query">, staff: string, roles: readonly string[]): Promise<StaffCounts> {
  const admin = roles.includes("administrator");
  const queues = Object.keys(QUEUE_ROLES).filter((q) => has(roles, QUEUE_ROLES[q]!));
  const r = (await db.query(STAFF_COUNTS, [queues, admin ? QUEUE_ROLES.scheduled_check : roles, has(roles, ["trust_and_safety"]), has(roles, ["trust_and_safety", "administrator"]),
    has(roles, ["services_case_handler", "content_editor", "administrator"]), admin, staff, roles.includes("services_case_handler")])).rows[0]!;
  return { queues: r.queues, reportsOpen: r.reports_open, reportsNew: r.reports_new, appeals: r.appeals, contact: r.contact, approvals: r.approvals,
    casesUnassigned: r.cases_unassigned, casesMine: r.cases_mine };
}

/** The digest's numbers: every count above zero, flat (queue names and the other keys). Pure. */
export function digestParams(c: StaffCounts): Record<string, number> {
  const flat: Record<string, number | null> = { ...c.queues, reportsOpen: c.reportsOpen, reportsNew: c.reportsNew, appeals: c.appeals, contact: c.contact, approvals: c.approvals,
    casesUnassigned: c.casesUnassigned, casesMine: c.casesMine };
  return Object.fromEntries(Object.entries(flat).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0));
}
