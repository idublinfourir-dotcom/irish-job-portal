// The audit log viewer (#234 D2, 20c section 6): an administrator reads every audit_event row, a staff member of any other role only the rows where they are the actor.
// Newest first, 50 a page by keyset on (at, id); filters for the acting staff member, action, object type and id, the kind (personal data views are kind data_access), the case and a date range.
// B59: each row carries the staff member's name and a label for the object it names (an organisation, job, strike, report, staff member or content page), and the same filters
// export as a CSV (an administrator every row, anyone else their own, as the list). Nobody edits or deletes:
// app_admin holds select and insert on audit_event and nothing else (0003), and the database rejects an insert for another side's actor (0004).
import type pg from "pg";
import { QueueRefused } from "./admin-queue";
import { isTime, validId } from "./search";
import { staffRoles, validStaffId } from "./staff-admin";
import { AUDIT } from "./trust-safety";

export const AUDIT_PAGE = 50;
const ACTION = /^[a-z][a-z0-9_.]{0,80}$/;
const TYPE = /^[a-z][a-z0-9_]{0,40}$/;
const OBJECT_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const DAY = /^\d{4}-\d\d-\d\d$/;
export const AUDIT_KINDS = ["admin_action", "data_access", "security"] as const; // audit_event_kind_check
export const AUDIT_EXPORT_MAX = 2000; // ponytail: Vercel answers at most 4.5 MB; narrow the filters or add a cursor if an export ever needs more (it says truncated)

export type AuditFilter = { staff?: string; action?: string; objectType?: string; objectId?: string; kind?: string; case?: string; from?: string; to?: string; after?: string };
export type AuditRow = {
  id: string; at: string; kind: string; actor: { staff: string | null; staffName: string | null; candidate: string | null; portal: string | null; system: string | null };
  roleInForce: string | null; action: string; objectType: string | null; objectId: string | null; objectLabel: string | null; changedColumns: string[] | null; before: unknown; after: unknown;
  reasonCode: string | null; secondStaff: string | null; secondStaffName: string | null; relatedCase: string | null; source: string | null;
};

// One constant statement: every filter is "null means off". The statement is planned with the real values (an unnamed statement), so an off filter costs nothing.
// $1 staff, $2 action, $3 type, $4 object id, $5 from (day), $6 to (day, inclusive), $7 and $8 the cursor, $9 kind, $10 case. Dates are read as UTC days.
const WHERE =
  "($1::text is null or actor_staff_user_id = $1) and ($2::text is null or action = $2) and ($3::text is null or object_type = $3) and ($4::text is null or object_id = $4) " +
  "and ($5::date is null or at >= ($5::date::timestamp at time zone 'UTC')) and ($6::date is null or at < (($6::date + 1)::timestamp at time zone 'UTC')) " +
  "and ($7::timestamptz is null or (at, id) < ($7::timestamptz, $8::bigint)) and ($9::text is null or kind = $9) and ($10::text is null or related_case = $10)";
const pageSql = (limit: number) =>
  "select id::text as id, at::text as at_text, kind, actor_staff_user_id, actor_candidate_user_id, actor_portal_user_id, actor_system, role_in_force, action, object_type, object_id, " +
  "changed_columns, before, after, reason_code, second_staff_user_id, related_case, source from audit_event " +
  `where ${WHERE} order by at desc, id desc limit ${limit}`;
export const AUDIT_PAGE_SQL = pageSql(AUDIT_PAGE + 1);
export const AUDIT_EXPORT_SQL = pageSql(AUDIT_EXPORT_MAX + 1);

// The label of each object a page names and the name of each staff member on it, one statement for the whole page (a lookup per row cost 9 times the pages):
// $1 organisation ids, $2 job ids, $3 staff ids (named in the row or as its object), $4 content page ids, $5 strike ids, $6 report ids.
// Only names a staff member already sees on the screens for these objects; a candidate, a services case or a document has no label here.
export const AUDIT_LABELS =
  "select 'organisation' as t, id::text as i, display_name as l from organisation where id = any($1::bigint[]) " +
  "union all select 'job', id::text, title from job where id = any($2::bigint[]) " +
  "union all select 'staff_user', id, name from staff_user where id = any($3::text[]) " +
  "union all select 'content_page', id::text, title from content_page where id = any($4::bigint[]) " +
  "union all select 'strike', s.id::text, o.display_name from strike s join organisation o on o.id = s.organisation_id where s.id = any($5::bigint[]) " +
  "union all select 'report', r.id::text, coalesce(j.title, o.display_name) from report r left join job j on j.id = r.target_job_id left join organisation o on o.id = r.target_organisation_id where r.id = any($6::bigint[])";
const LABELLED = ["organisation", "job", "staff_user", "content_page", "strike", "report"] as const;

type Row = {
  id: string; at_text: string; kind: string; actor_staff_user_id: string | null; actor_candidate_user_id: string | null; actor_portal_user_id: string | null; actor_system: string | null;
  role_in_force: string | null; action: string; object_type: string | null; object_id: string | null; changed_columns: string[] | null; before: unknown; after: unknown;
  reason_code: string | null; second_staff_user_id: string | null; related_case: string | null; source: string | null;
};
const staffName = (names: Map<string, string>, id: string | null) => (id === null ? null : (names.get(`staff_user:${id}`) ?? null));
const view = (r: Row, names: Map<string, string>, isAdmin: boolean): AuditRow => ({
  id: r.id, at: r.at_text, kind: r.kind, actor: { staff: r.actor_staff_user_id, staffName: staffName(names, r.actor_staff_user_id), candidate: r.actor_candidate_user_id, portal: r.actor_portal_user_id, system: r.actor_system },
  roleInForce: r.role_in_force, action: r.action, objectType: r.object_type, objectId: r.object_id, objectLabel: r.object_type && r.object_id ? (names.get(`${r.object_type}:${r.object_id}`) ?? null) : null, changedColumns: r.changed_columns, before: r.before, after: r.after,
  reasonCode: r.reason_code, secondStaff: r.second_staff_user_id, secondStaffName: isAdmin ? staffName(names, r.second_staff_user_id) : null, relatedCase: r.related_case, source: r.source,
});

/** The labels of the objects these rows name and the names of the staff on them, by "type:id" (staff names under "staff_user:id"). One statement, none when no row names either. */
async function labels(db: Pick<pg.Pool, "query">, rows: Row[]): Promise<Map<string, string>> {
  const ids = Object.fromEntries(LABELLED.map((t) => [t, new Set<string>()]));
  for (const r of rows) for (const id of [r.actor_staff_user_id, r.second_staff_user_id]) if (id !== null) ids.staff_user!.add(id);
  for (const r of rows) if (r.object_type && r.object_id && r.object_type in ids && (r.object_type === "staff_user" || /^\d{1,18}$/.test(r.object_id))) ids[r.object_type]!.add(r.object_id);
  if (LABELLED.every((t) => ids[t]!.size === 0)) return new Map();
  const found = (await db.query<{ t: string; i: string; l: string }>(AUDIT_LABELS, LABELLED.map((t) => [...ids[t]!]))).rows;
  return new Map(found.map((f) => [`${f.t}:${f.i}`, f.l]));
}

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

/** The filter checked and the rows it reads, at most `limit` and one more to tell there are more. An administrator may filter by any staff member; anyone else is held to their own rows and refused another member's id. */
async function read(db: Pick<pg.Pool, "query">, staff: string, f: AuditFilter, sql: string): Promise<{ rows: Row[]; names: Map<string, string>; isAdmin: boolean; filter: Record<string, string> }> {
  const actor = text(f.staff, /^[A-Za-z0-9_-]{1,64}$/, "bad_staff_id");
  const action = text(f.action, ACTION, "bad_action");
  const type = text(f.objectType, TYPE, "bad_object_type");
  const object = text(f.objectId, OBJECT_ID, "bad_object_id");
  const kind = f.kind ?? null;
  if (kind !== null && !(AUDIT_KINDS as readonly string[]).includes(kind)) throw new QueueRefused("bad_kind");
  const caseId = text(f.case, OBJECT_ID, "bad_case_id");
  const from = f.from === undefined ? null : day(f.from, "bad_from");
  const to = f.to === undefined ? null : day(f.to, "bad_to");
  if (from !== null && to !== null && from > to) throw new QueueRefused("bad_range");
  const cursor = f.after === undefined ? [null, null] : decode(f.after);
  if (!validStaffId(staff)) throw new QueueRefused("not_active_staff");
  const roles = await staffRoles(db, staff);
  const isAdmin = roles.includes("administrator");
  if (!isAdmin && actor !== null && actor !== staff) throw new QueueRefused("not_administrator");
  const rows = (await db.query<Row>(sql, [isAdmin ? actor : staff, action, type, object, from, to, cursor[0], cursor[1], kind, caseId])).rows;
  const shown = { staff: actor, action, objectType: type, objectId: object, kind, case: caseId, from, to };
  return { rows, names: await labels(db, rows.slice(0, AUDIT_EXPORT_MAX)), isAdmin, filter: Object.fromEntries(Object.entries(shown).filter((e): e is [string, string] => e[1] !== null)) };
}

/** One page of the log, newest first. */
export async function listAudit(db: Pick<pg.Pool, "query">, staff: string, f: AuditFilter = {}): Promise<{ events: AuditRow[]; next: string | null }> {
  const { rows: all, names, isAdmin } = await read(db, staff, f, AUDIT_PAGE_SQL);
  const rows = all.slice(0, AUDIT_PAGE);
  return { events: rows.map((r) => view(r, names, isAdmin)), next: all.length > AUDIT_PAGE ? encode(rows.at(-1)!) : null };
}

// A cell as CSV text: always quoted, and one a spreadsheet would run as a formula (it starts with = + - @ tab or return) gets a quote in front. Names and job titles are typed by people.
const cell = (v: unknown) => {
  const t = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replaceAll('"', '""')}"`;
};
export const AUDIT_CSV_HEAD = ["id", "at", "kind", "staffId", "staffName", "action", "objectType", "objectId", "objectLabel", "reasonCode", "relatedCase", "secondStaffId", "secondStaffName", "source", "changedColumns", "before", "after"];
/** The rows as CSV text, newest first. Pure. */
export function auditCsv(rows: AuditRow[]): string {
  const line = (r: AuditRow) => [r.id, r.at, r.kind, r.actor.staff, r.actor.staffName, r.action, r.objectType, r.objectId, r.objectLabel, r.reasonCode, r.relatedCase, r.secondStaff, r.secondStaffName,
    r.source, r.changedColumns?.join(";") ?? null, r.before, r.after].map(cell).join(",");
  return [AUDIT_CSV_HEAD.map(cell).join(","), ...rows.map(line)].join("\r\n") + "\r\n";
}

/** The rows of the filter (no cursor) as CSV, at most AUDIT_EXPORT_MAX, newest first; `truncated` when there were more. Who sees what is as the list. The export is itself logged
 *  (audit.export, with the filter and the row count) in the same transaction, as the staff export is. */
export async function exportAudit(db: Pick<pg.Pool, "connect">, staff: string, f: Omit<AuditFilter, "after"> = {}): Promise<{ csv: string; rows: number; truncated: boolean }> {
  const c = await db.connect();
  try {
    await c.query("begin");
    const { rows: all, names, isAdmin, filter } = await read(c, staff, f, AUDIT_EXPORT_SQL);
    const rows = all.slice(0, AUDIT_EXPORT_MAX);
    const truncated = all.length > AUDIT_EXPORT_MAX;
    await c.query(AUDIT, [staff, "audit.export", "audit_event", "export", JSON.stringify({ filter, rows: rows.length, truncated }), null, null, null]);
    await c.query("commit");
    return { csv: auditCsv(rows.map((r) => view(r, names, isAdmin))), rows: rows.length, truncated };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
