// The staff services board (step 15 SV-B2: M3 board, M9 referral, the referral solicitor list) and the requester's case timeline read (S-Q9).
// Staff calls run as app_admin, like contact-inbox.ts: the first statement checks the person is active staff with a role that may do it and sets
// app.staff_user_id for the transaction. The matrix (20c:128-132, S-Q11 B): services_case_handler works cases; an administrator sees the list and
// a case without notes, copies or requester contact, may reassign a case and keeps the solicitor list. One person does case work: every case
// action but assign needs the assigned handler (20c:130). Staff never handle their own case: a staff member whose email equals the requester's
// account email is refused on that case, reads included (20c:231). Every open writes a data_access row with reason services_case and the case id
// (S-Q8 A); every action writes its own case_event (no trigger does, 0061) and an admin_action row, codes and ids only, in one transaction.
// The requester's notices (M5) come from 0063's trigger on case_event, so nothing here writes a notification or an email.
import type pg from "pg";
import { decodeReviewCursor } from "./account-review";
import { candidateRead, Refuse, type CandidateEnv } from "./candidate-route";
import { QueueRefused } from "./admin-queue";
import { documentLabels, isCaseDocumentCode } from "./case-document-codes";
import { PAGE_SIZE, validId } from "./search";

type Db = Pick<pg.Pool, "query" | "connect">;

/** S-Q10 B: the requester sees the referral firm's name only when this is on. It is turned on by a PR after the owner's list and our solicitor's
 *  view; until then a referral shows the generic code only. */
export const REFERRAL_FIRM_SHOWN = false;
/** Placeholder labels for the outcome (S-Q3 A). */
export const OUTCOME_LABELS = { granted: "Permit granted", refused: "Permit refused" } as const;
export const OPEN_STATUSES = ["received", "documents_needed", "waiting_for_employer", "submitted", "decision"] as const;
/** Allowed status moves (services-plan-check.md section 4). Closing is its own action (close, refer), from any open status. */
export const CASE_MOVES: Record<string, readonly string[]> = {
  received: ["documents_needed", "waiting_for_employer", "submitted"],
  documents_needed: ["waiting_for_employer", "submitted"],
  waiting_for_employer: ["documents_needed", "submitted"],
  submitted: ["documents_needed", "decision"], // DETE can ask for more documents after submission (its portal FAQ, read 20 Nov 2026)
  decision: [],
};
export const canMove = (from: string, to: string) => Object.hasOwn(CASE_MOVES, from) && CASE_MOVES[from]!.includes(to);
/** Close reasons staff give (withdrawn is the requester's own act, referred_to_solicitor is the refer action). */
export const STAFF_CLOSE_REASONS = ["decided", "employer_not_engaged", "no_reply"] as const;
export const MAX_NOTE = 2000;
export const TIMELINE_CAP = 200;

const HANDLER = "services_case_handler", ADMIN = "administrator";
export const BOARD_CHECK =
  "select set_config('app.staff_user_id', $1, true), exists (select 1 from staff_user where id = $1 and status = 'active') as active, " +
  "coalesce((select array_agg(r.role order by r.role) from staff_role r join staff_user u on u.id = r.staff_user_id " +
  "where u.id = $1 and u.status = 'active' and r.role in ('services_case_handler','administrator')), '{}') as roles";

/** The board roles this person holds now (handler, administrator), or not_active_staff / not_case_staff. */
async function roles(db: Pick<pg.Pool, "query">, staff: string): Promise<string[]> {
  if (typeof staff !== "string" || staff.length === 0 || staff.length > 200) throw new QueueRefused("not_active_staff");
  const r = (await db.query<{ active: boolean; roles: string[] }>(BOARD_CHECK, [staff])).rows[0]!;
  if (!r.active) throw new QueueRefused("not_active_staff");
  if (r.roles.length === 0) throw new QueueRefused("not_case_staff");
  return r.roles;
}
const handlerOnly = (rs: string[]) => {
  if (!rs.includes(HANDLER)) throw new QueueRefused("not_case_handler");
};
const adminOnly = (rs: string[]) => {
  if (!rs.includes(ADMIN)) throw new QueueRefused("not_administrator");
};

async function tx<T>(db: Db, staff: string, fn: (c: pg.PoolClient, rs: string[]) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("begin");
    const out = await fn(c, await roles(c, staff));
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export const BOARD_AUDIT =
  "insert into audit_event(kind, actor_staff_user_id, role_in_force, action, object_type, object_id, subject_candidate_user_id, reason_code, related_case, after, source) " +
  "values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'panel')";
const audit = (c: pg.PoolClient, kind: "data_access" | "admin_action", staff: string, role: string, action: string, type: string, id: string, subject: string | null, after: object) =>
  c.query(BOARD_AUDIT, [kind, staff, role, action, type, id, subject, kind === "data_access" ? "services_case" : null, type === "services_case" ? id : null, JSON.stringify(after)]);

const camel = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase()), v]));

// ===== the list =====
// One status at a time, oldest first, on services_case_board_idx (status, created_at, id) where status <> 'closed'.
const LIST_COLS =
  "select c.id::text as id, c.status, c.created_at::text as created_text, c.permit_type, c.payer, c.employer_contact_consent_record_id is not null as hr_contact_consent, " +
  "c.assigned_staff_user_id, case when c.candidate_user_id is not null then 'candidate' when c.portal_user_id is not null then 'portal' end as side " +
  "from services_case c where c.status = $1 and c.status <> 'closed'";
export const BOARD_FIRST = `${LIST_COLS} order by c.created_at, c.id limit ${PAGE_SIZE + 1}`;
export const BOARD_AFTER = `${LIST_COLS} and (c.created_at, c.id) > ($2::timestamptz, $3::bigint) order by c.created_at, c.id limit ${PAGE_SIZE + 1}`;

/** Open cases at one status, a page at a time. The same columns for a handler and an administrator: no requester name or contact. */
export async function listServiceCases(db: Pick<pg.Pool, "query">, staff: string, opts: { status?: string; after?: string } = {}) {
  const status = opts.status ?? "received";
  await roles(db, staff);
  if (!(OPEN_STATUSES as readonly string[]).includes(status)) throw new QueueRefused("bad_status");
  const cursor = opts.after === undefined ? undefined : decodeReviewCursor(opts.after);
  const all = (cursor ? await db.query(BOARD_AFTER, [status, ...cursor]) : await db.query(BOARD_FIRST, [status])).rows as (Record<string, unknown> & { id: string; created_text: string })[];
  const rows = all.slice(0, PAGE_SIZE);
  const last = rows.at(-1);
  return {
    items: rows.map(({ created_text, ...r }) => ({ ...camel(r), createdAt: created_text })),
    next: all.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({ t: last.created_text, i: last.id })).toString("base64url") : null,
  };
}

// ===== one case =====
// own: the acting staff member's email is the requester's (20c:231). The requester's name and email only while the case is open and not erased (20c:143).
const OWN = "lower((select email from staff_user where id = $2)) in (select lower(email) from candidate_user where id = c.candidate_user_id " +
  "union all select lower(email) from portal_user where id = c.portal_user_id) as own";
export const CASE_ONE =
  "select c.id::text as id, c.status, c.created_at::text as created_at, c.permit_type, c.offer_details, c.payer, c.organisation_id::text as organisation_id, c.job_id::text as job_id, " +
  "c.consent_record_id::text as consent_record_id, c.employer_contact_consent_record_id is not null as hr_contact_consent, c.decision_outcome, c.documents_needed, " +
  "c.decided_at::text as decided_at, c.closed_at::text as closed_at, c.close_reason, c.referral_solicitor_id::text as referral_solicitor_id, c.assigned_staff_user_id, " +
  "case when c.candidate_user_id is not null then 'candidate' when c.portal_user_id is not null then 'portal' end as side, c.requester_erased_at is not null as requester_erased, " +
  "c.candidate_user_id, case when c.status <> 'closed' and c.requester_erased_at is null then coalesce(cu.name, pu.name) end as requester_name, " +
  "case when c.status <> 'closed' and c.requester_erased_at is null then coalesce(cu.email, pu.email) end as requester_email, " +
  "(select count(*)::int from case_document d where d.services_case_id = c.id and d.storage_key is not null) as copies, " + OWN + " " +
  "from services_case c left join candidate_user cu on cu.id = c.candidate_user_id left join portal_user pu on pu.id = c.portal_user_id where c.id = $1::bigint";
export const CASE_NOTES =
  `select id::text as id, author_staff_user_id, body, created_at::text as created_at from case_note where services_case_id = $1::bigint order by id limit ${TIMELINE_CAP}`;

/** One case, or null. A handler sees all of it; an administrator sees it without notes, copies or requester contact. Logged on every open. */
export async function getServiceCase(db: Db, staff: string, id: string | number) {
  const key = String(id);
  return tx(db, staff, async (c, rs) => {
    if (!validId(key)) return null;
    const r = (await c.query(CASE_ONE, [key, staff])).rows[0] as (Record<string, unknown> & { own: boolean; candidate_user_id: string | null; documents_needed: string[] }) | undefined;
    if (!r) return null;
    if (r.own) throw new QueueRefused("own_case");
    const role = rs.includes(HANDLER) ? HANDLER : ADMIN;
    await audit(c, "data_access", staff, role, "services_case.read", "services_case", key, r.candidate_user_id, {});
    const item = camel(r);
    for (const k of ["own", "candidateUserId"]) delete item[k];
    item.documentsNeeded = documentLabels(r.documents_needed);
    if (role === HANDLER) return { ...item, notes: (await c.query(CASE_NOTES, [key])).rows.map(camel) };
    delete item.requesterName;
    delete item.requesterEmail;
    delete item.copies;
    return item;
  });
}

// ===== the actions =====
export const SERVICE_CASE_LOCK =
  "select c.id, c.status, c.assigned_staff_user_id, c.decision_outcome, c.documents_needed, c.candidate_user_id, " + OWN + " from services_case c where c.id = $1::bigint for update of c";
type Locked = { status: string; assigned_staff_user_id: string | null; decision_outcome: string | null; documents_needed: string[]; candidate_user_id: string | null; own: boolean };
export const CASE_EVENT = "insert into case_event(case_id, kind, status, detail, staff_user_id) values ($1::bigint, $2, $3, $4::jsonb, $5)";

/** Locks the case and applies the rules every action shares: found, not the actor's own, open. */
async function lockCase(c: pg.PoolClient, staff: string, key: string): Promise<Locked> {
  if (!validId(key)) throw new QueueRefused("not_found");
  const k = (await c.query<Locked>(SERVICE_CASE_LOCK, [key, staff])).rows[0];
  if (!k) throw new QueueRefused("not_found");
  if (k.own) throw new QueueRefused("own_case");
  if (k.status === "closed") throw new QueueRefused("case_closed");
  return k;
}

/** A handler-only action on a case assigned to the actor: the update, its event, its audit row. One transaction. */
async function handle(db: Db, staff: string, id: string, action: string, work: (c: pg.PoolClient, k: Locked) => Promise<{ kind?: string; status?: string; detail?: object; after: object }>) {
  const key = String(id);
  return tx(db, staff, async (c, rs) => {
    handlerOnly(rs);
    const k = await lockCase(c, staff, key);
    if (k.assigned_staff_user_id !== staff) throw new QueueRefused("not_assigned");
    const e = await work(c, k);
    if (e.kind) await c.query(CASE_EVENT, [key, e.kind, e.status, JSON.stringify(e.detail ?? {}), staff]);
    await audit(c, "admin_action", staff, HANDLER, `services_case.${action}`, "services_case", key, k.candidate_user_id, e.after);
  });
}

export const IS_HANDLER =
  "select exists (select 1 from staff_role r join staff_user u on u.id = r.staff_user_id where u.id = $1 and u.status = 'active' and r.role = 'services_case_handler') as handler, " +
  "lower((select email from staff_user where id = $1)) in (select lower(email) from candidate_user where id = (select candidate_user_id from services_case where id = $2::bigint) " +
  "union all select lower(email) from portal_user where id = (select portal_user_id from services_case where id = $2::bigint)) as own";

/** Assign a case to a handler: a handler takes an unassigned case or passes on their own one; an administrator may reassign any open case. */
export async function assignCase(db: Db, staff: string, id: string | number, to: string): Promise<void> {
  const key = String(id);
  await tx(db, staff, async (c, rs) => {
    const k = await lockCase(c, staff, key);
    const asHandler = rs.includes(HANDLER) && (k.assigned_staff_user_id === null || k.assigned_staff_user_id === staff);
    if (!asHandler && !rs.includes(ADMIN)) throw new QueueRefused(rs.includes(HANDLER) ? "not_assigned" : "not_case_handler");
    if (typeof to !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(to)) throw new QueueRefused("bad_staff_id");
    const t = (await c.query<{ handler: boolean; own: boolean }>(IS_HANDLER, [to, key])).rows[0]!;
    if (!t.handler || t.own) throw new QueueRefused("bad_assignee");
    if (k.assigned_staff_user_id === to) throw new QueueRefused("no_change");
    await c.query("update services_case set assigned_staff_user_id = $2 where id = $1::bigint", [key, to]);
    await c.query(CASE_EVENT, [key, "assigned", k.status, JSON.stringify({ assignedStaffUserId: to }), staff]);
    await audit(c, "admin_action", staff, asHandler ? HANDLER : ADMIN, "services_case.assign", "services_case", key, k.candidate_user_id,
      { assignedStaffUserId: to, before: k.assigned_staff_user_id });
  });
}

/** An allowed move between open statuses (CASE_MOVES). Moving to decision sets decided_at. */
export const setCaseStatus = (db: Db, staff: string, id: string | number, to: string) =>
  handle(db, staff, String(id), "status", async (c, k) => {
    if (!canMove(k.status, to)) throw new QueueRefused("bad_move");
    await c.query("update services_case set status = $2::text, decided_at = case when $2::text = 'decision' then now() else decided_at end where id = $1::bigint", [String(id), to]);
    return { kind: "status_changed", status: to, after: { from: k.status, status: to } };
  });

/** The documents the requester must send, codes from case-document-codes.ts only; before the decision. */
export const setDocumentsNeeded = (db: Db, staff: string, id: string | number, codes: unknown) =>
  handle(db, staff, String(id), "documents", async (c, k) => {
    if (!Array.isArray(codes) || codes.length > 30 || !codes.every(isCaseDocumentCode) || new Set(codes).size !== codes.length) throw new QueueRefused("bad_codes");
    if (k.status === "decision") throw new QueueRefused("bad_move");
    if (codes.length === k.documents_needed.length && codes.every((x) => k.documents_needed.includes(x))) throw new QueueRefused("no_change");
    await c.query("update services_case set documents_needed = $2::text[] where id = $1::bigint", [String(id), codes]);
    return { kind: "documents_needed", status: k.status, detail: { documentsNeeded: codes }, after: { documentsNeeded: codes } };
  });

/** The outcome (granted or refused), at status decision only. */
export const recordDecision = (db: Db, staff: string, id: string | number, outcome: string) =>
  handle(db, staff, String(id), "decision", async (c, k) => {
    if (!Object.hasOwn(OUTCOME_LABELS, outcome)) throw new QueueRefused("bad_outcome");
    if (k.status !== "decision") throw new QueueRefused("not_at_decision");
    if (k.decision_outcome === outcome) throw new QueueRefused("no_change");
    await c.query("update services_case set decision_outcome = $2 where id = $1::bigint", [String(id), outcome]);
    return { kind: "decision", status: "decision", detail: { outcome }, after: { outcome } };
  });

/** Close with a staff reason. decided needs a recorded outcome; a case with an outcome closes as decided (or is referred). */
export const closeCase = (db: Db, staff: string, id: string | number, reason: string) =>
  handle(db, staff, String(id), "close", async (c, k) => {
    if (!(STAFF_CLOSE_REASONS as readonly string[]).includes(reason)) throw new QueueRefused("bad_reason");
    if ((reason === "decided") !== (k.decision_outcome !== null)) throw new QueueRefused(reason === "decided" ? "not_decided" : "outcome_recorded");
    await c.query("update services_case set status = 'closed', closed_at = now(), close_reason = $2 where id = $1::bigint", [String(id), reason]);
    return { kind: "closed", status: "closed", after: { status: "closed", closeReason: reason } };
  });

/** M9: close as referred to a solicitor, optionally naming one from the active list. */
export const referCase = (db: Db, staff: string, id: string | number, solicitorId?: string) =>
  handle(db, staff, String(id), "refer", async (c) => {
    if (solicitorId !== undefined) {
      if (!validId(solicitorId)) throw new QueueRefused("bad_solicitor_id");
      const s = (await c.query("select active from referral_solicitor where id = $1::bigint", [solicitorId])).rows[0];
      if (!s?.active) throw new QueueRefused("bad_solicitor");
    }
    await c.query("update services_case set status = 'closed', closed_at = now(), close_reason = 'referred_to_solicitor', referral_solicitor_id = $2::bigint where id = $1::bigint",
      [String(id), solicitorId ?? null]);
    const detail = solicitorId === undefined ? {} : { referralSolicitorId: Number(solicitorId) };
    return { kind: "referred", status: "closed", detail, after: { status: "closed", closeReason: "referred_to_solicitor", ...detail } };
  });

/** A staff note: never shown to the requester, no event; the audit row holds the note's id, never its text. */
export const noteOk = (body: unknown): body is string =>
  typeof body === "string" && body.trim().length > 0 && body.length <= MAX_NOTE && !/[\p{Cc}\p{Cf}]/u.test(body.replace(/[\n\t]/g, ""));
export const addCaseNote = (db: Db, staff: string, id: string | number, body: string) =>
  handle(db, staff, String(id), "note", async (c) => {
    if (!noteOk(body)) throw new QueueRefused("bad_text");
    const n = (await c.query("insert into case_note(services_case_id, author_staff_user_id, body) values ($1::bigint, $2, $3) returning id::text as id", [String(id), staff, body])).rows[0];
    return { after: { noteId: n.id } }; // no kind: no event
  });

// ===== the referral solicitor list (S-Q10 B) =====
export const SOLICITORS = `select id::text as id, firm, contact, active, created_at::text as created_at from referral_solicitor order by active desc, firm, id limit ${TIMELINE_CAP}`;
/** A firm or contact text: trimmed, 1 to max characters, no control characters. Pure. */
export const solicitorText = (v: unknown, max: number): v is string => typeof v === "string" && v === v.trim() && v.length >= 1 && v.length <= max && !/[\p{Cc}\p{Cf}]/u.test(v);

/** Handlers and administrators read the list. */
export async function listSolicitors(db: Pick<pg.Pool, "query">, staff: string) {
  await roles(db, staff);
  return { items: (await db.query(SOLICITORS)).rows.map(camel) };
}
/** Administrators add, edit and deactivate; nothing is ever deleted. */
export async function addSolicitor(db: Db, staff: string, firm: string, contact: string): Promise<string> {
  return tx(db, staff, async (c, rs) => {
    adminOnly(rs);
    if (!solicitorText(firm, 200)) throw new QueueRefused("bad_firm");
    if (!solicitorText(contact, 300)) throw new QueueRefused("bad_contact");
    const id = (await c.query("insert into referral_solicitor(firm, contact, created_by_staff_user_id) values ($1, $2, $3) returning id::text as id", [firm, contact, staff])).rows[0].id as string;
    await audit(c, "admin_action", staff, ADMIN, "referral_solicitor.add", "referral_solicitor", id, null, { active: true });
    return id;
  });
}
export async function editSolicitor(db: Db, staff: string, id: string, change: { firm?: string; contact?: string; active?: false }): Promise<void> {
  await tx(db, staff, async (c, rs) => {
    adminOnly(rs);
    if (!validId(id)) throw new QueueRefused("not_found");
    if (change.firm !== undefined && !solicitorText(change.firm, 200)) throw new QueueRefused("bad_firm");
    if (change.contact !== undefined && !solicitorText(change.contact, 300)) throw new QueueRefused("bad_contact");
    const before = (await c.query("select firm, contact, active from referral_solicitor where id = $1::bigint for update", [id])).rows[0];
    if (!before) throw new QueueRefused("not_found");
    const next = { firm: change.firm ?? before.firm, contact: change.contact ?? before.contact, active: change.active ?? before.active };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== before[k]);
    if (changed.length === 0) throw new QueueRefused("no_change");
    await c.query("update referral_solicitor set firm = $2, contact = $3, active = $4 where id = $1::bigint", [id, next.firm, next.contact, next.active]);
    await audit(c, "admin_action", staff, ADMIN, change.active === false ? "referral_solicitor.deactivate" : "referral_solicitor.edit", "referral_solicitor", id, null, { changed, active: next.active });
  });
}

// ===== the requester's timeline (S-Q9), through 0061's per-side wrappers only =====
export type CaseSide = "candidate" | "portal";
export const timelineSql = (side: CaseSide, showFirm: boolean) =>
  `select private.${side}_case_readable($1, $2::bigint) as ok, ${showFirm ? `private.${side}_case_referral_firm($1, $2::bigint)` : "null::text"} as firm, ` +
  `(select coalesce(jsonb_agg(jsonb_build_object('at', t.at, 'kind', t.kind, 'status', t.status, 'detail', t.detail)), '[]') ` +
  `from (select * from private.${side}_case_timeline($1, $2::bigint) limit ${TIMELINE_CAP}) t) as events`;

type RawEvent = { at: string; kind: string; status: string; detail: { documentsNeeded?: string[]; outcome?: keyof typeof OUTCOME_LABELS } };
/** The reply's events: codes with their labels, never an id or a staff name; a referral names the firm only when shown. Pure. */
export function timelineEvents(events: RawEvent[], firm: string | null) {
  return events.map((e) => ({
    at: e.at, kind: e.kind, status: e.status,
    ...(e.detail.documentsNeeded ? { documentsNeeded: documentLabels(e.detail.documentsNeeded) } : {}),
    ...(e.detail.outcome ? { outcome: { code: e.detail.outcome, label: OUTCOME_LABELS[e.detail.outcome] ?? null } } : {}),
    ...(e.kind === "referred" ? { referral: { code: "referred_to_solicitor", ...(firm ? { firm } : {}) } } : {}),
  }));
}

/** The case's steps, oldest first (at most TIMELINE_CAP), for its requester (or, on a portal case, the company's Owner or Recruiter); null when not readable. */
export async function caseTimeline(db: Pick<pg.Pool, "query">, side: CaseSide, userId: string, caseId: string, showFirm = REFERRAL_FIRM_SHOWN) {
  if (!validId(caseId)) return null;
  const r = (await db.query<{ ok: boolean; firm: string | null; events: RawEvent[] }>(timelineSql(side, showFirm), [userId, caseId])).rows[0]!;
  return r.ok ? { events: timelineEvents(r.events, showFirm ? r.firm : null) } : null;
}

/** GET /api/{candidate,portal}/cases/[id]/timeline: a bad id is 400, a case this login cannot read is 404 (whatever the case is). */
export const caseTimelineGet = (request: Request, env: CandidateEnv, side: CaseSide, caseId: string) =>
  candidateRead(request, env, async (db, userId) => {
    if (!validId(caseId)) throw new Refuse(400, "BAD_REQUEST");
    const t = await caseTimeline(db, side, userId, caseId);
    if (!t) throw new Refuse(404, "CASE_NOT_FOUND");
    return t;
  }, undefined, side);
