// The audit log viewer (#234 D2, 20c section 6): an administrator reads every audit_event row, a staff member of any other role only the rows where they are the actor.
// Newest first, 50 a page by keyset on (at, id); filters for the acting staff member, action, object type and id, and a date range. Nobody edits or deletes:
// app_admin holds select and insert on audit_event and nothing else (0003), and the database rejects an insert for another side's actor (0004).
import type pg from "pg";
import { QueueRefused } from "./admin-queue";
import { isTime, validId } from "./search";
import { staffRoles, validStaffId } from "./staff-admin";

export const AUDIT_PAGE = 50;
const ACTION = /^[a-z][a-z0-9_.]{0,80}$/;
const TYPE = /^[a-z][a-z0-9_]{0,40}$/;
const OBJECT_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const DAY = /^\d{4}-\d\d-\d\d$/;

export type AuditFilter = { staff?: string; action?: string; objectType?: string; objectId?: string; from?: string; to?: string; after?: string };
export type AuditRow = {
  id: string; at: string; kind: string; actor: { staff: string | null; candidate: string | null; portal: string | null; system: string | null };
  roleInForce: string | null; action: string; objectType: string | null; objectId: string | null; changedColumns: string[] | null; before: unknown; after: unknown;
  reasonCode: string | null; secondStaff: string | null; relatedCase: string | null; source: string | null;
};

// One constant statement: every filter is "null means off". The statement is planned with the real values (an unnamed statement), so an off filter costs nothing.
// $1 staff, $2 action, $3 type, $4 object id, $5 from (day), $6 to (day, inclusive), $7 and $8 the cursor. Dates are read as UTC days.
const WHERE =
  "($1::text is null or actor_staff_user_id = $1) and ($2::text is null or action = $2) and ($3::text is null or object_type = $3) and ($4::text is null or object_id = $4) " +
  "and ($5::date is null or at >= ($5::date::timestamp at time zone 'UTC')) and ($6::date is null or at < (($6::date + 1)::timestamp at time zone 'UTC')) " +
  "and ($7::timestamptz is null or (at, id) < ($7::timestamptz, $8::bigint))";
export const AUDIT_PAGE_SQL =
  "select id::text as id, at::text as at_text, kind, actor_staff_user_id, actor_candidate_user_id, actor_portal_user_id, actor_system, role_in_force, action, object_type, object_id, " +
  "changed_columns, before, after, reason_code, second_staff_user_id, related_case, source from audit_event " +
  `where ${WHERE} order by at desc, id desc limit ${AUDIT_PAGE + 1}`;

type Row = {
  id: string; at_text: string; kind: string; actor_staff_user_id: string | null; actor_candidate_user_id: string | null; actor_portal_user_id: string | null; actor_system: string | null;
  role_in_force: string | null; action: string; object_type: string | null; object_id: string | null; changed_columns: string[] | null; before: unknown; after: unknown;
  reason_code: string | null; second_staff_user_id: string | null; related_case: string | null; source: string | null;
};
const view = (r: Row): AuditRow => ({
  id: r.id, at: r.at_text, kind: r.kind, actor: { staff: r.actor_staff_user_id, candidate: r.actor_candidate_user_id, portal: r.actor_portal_user_id, system: r.actor_system },
  roleInForce: r.role_in_force, action: r.action, objectType: r.object_type, objectId: r.object_id, changedColumns: r.changed_columns, before: r.before, after: r.after,
  reasonCode: r.reason_code, secondStaff: r.second_staff_user_id, relatedCase: r.related_case, source: r.source,
});

const encode = (r: Row) => Buffer.from(JSON.stringify({ t: r.at_text, i: r.id })).toString("base64url");
function decode(token: string): [string, string] {
  const bad = new QueueRefused("bad_cursor");
  if (token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) throw bad;
  let o: { t?: unknown; i?: unknown };
  try {
    o = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw bad;
  }
  if (o === null || typeof o !== "object" || typeof o.t !== "string" || !isTime(o.t) || !validId(o.i)) throw bad;
  return [o.t, o.i];
}
const day = (v: string, why: string) => {
  if (!DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new QueueRefused(why);
  return v;
};
const text = (v: string | undefined, re: RegExp, why: string) => {
  if (v === undefined) return null;
  if (typeof v !== "string" || !re.test(v)) throw new QueueRefused(why);
  return v;
};

/** One page of the log, newest first. An administrator may filter by any staff member; anyone else is held to their own rows and refused another member's id. */
export async function listAudit(db: Pick<pg.Pool, "query">, staff: string, f: AuditFilter = {}): Promise<{ events: AuditRow[]; next: string | null }> {
  const actor = text(f.staff, /^[A-Za-z0-9_-]{1,64}$/, "bad_staff_id");
  const action = text(f.action, ACTION, "bad_action");
  const type = text(f.objectType, TYPE, "bad_object_type");
  const object = text(f.objectId, OBJECT_ID, "bad_object_id");
  const from = f.from === undefined ? null : day(f.from, "bad_from");
  const to = f.to === undefined ? null : day(f.to, "bad_to");
  if (from !== null && to !== null && from > to) throw new QueueRefused("bad_range");
  const cursor = f.after === undefined ? [null, null] : decode(f.after);
  if (!validStaffId(staff)) throw new QueueRefused("not_active_staff");
  const roles = await staffRoles(db, staff);
  const isAdmin = roles.includes("administrator");
  if (!isAdmin && actor !== null && actor !== staff) throw new QueueRefused("not_administrator");
  const all = (await db.query<Row>(AUDIT_PAGE_SQL, [isAdmin ? actor : staff, action, type, object, from, to, cursor[0], cursor[1]])).rows;
  const rows = all.slice(0, AUDIT_PAGE);
  return { events: rows.map(view), next: all.length > AUDIT_PAGE ? encode(rows.at(-1)!) : null };
}
