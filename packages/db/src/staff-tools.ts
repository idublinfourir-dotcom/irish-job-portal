// Staff and admin tools (step 15 small wave 3): the scheduled_check reminders (Q3), the overdue view (Q12), the company seed (brand list) bulk import
// through the two-person rule (Q14) and a setting's value through the two-person rule (R2). Run as app_admin; every call checks the acting staff
// member's roles in the database first (STAFF_WHO also sets app.staff_user_id for the transaction, as the guards expect). Every statement is a
// constant with parameters. The database stays the last guard: approval_request_guard (only an administrator confirms these kinds, never the
// proposer) and setting_guard (a value changes only through a confirmed, unused 'setting' request naming that value, 0004).
import type pg from "pg";
import { QueueRefused } from "./admin-queue";
import { parseSeed, seedRows, type SeedResult, type SeedRow } from "./company-seed";
import { fileStore } from "./file-store";
import { validId } from "./search";
import { requireRole } from "./staff-admin";
import { AUDIT } from "./trust-safety";

type Q = Pick<pg.Pool, "query">;
type Db = Pick<pg.Pool, "query" | "connect">;
export const MAX_SHOWN = 100; // ponytail: one answer, no cursor; add one if a list ever passes this (it says truncated)

export async function inTransaction<T>(db: Db, staff: string, roles: readonly string[], why: string, fn: (c: pg.PoolClient, held: string[]) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("begin");
    const held = await requireRole(c, staff, roles, why);
    const out = await fn(c, held);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
const audit = (c: pg.PoolClient, staff: string, action: string, type: string, id: string, after: object, second: string | null = null) =>
  c.query(AUDIT, [staff, action, type, id, JSON.stringify(after), null, second, null]);
const page = <T>(rows: T[]) => ({ items: rows.slice(0, MAX_SHOWN), truncated: rows.length > MAX_SHOWN });

// ===== Q3: the scheduled_check reminders (written daily by scheduled-checks-cli.ts) =====
/** The roles that work a reminder (detail.role); an administrator sees and closes them all. */
export const SCHEDULED_ROLES = ["rules_data_editor", "fetched_job_reviewer", "administrator"] as const;
const rolesFor = (held: string[]) => (held.includes("administrator") ? [...SCHEDULED_ROLES] : held);
// Oldest first on review_item_queue_idx (queue, created_at, id) where status in ('open','claimed').
export const SCHEDULED_LIST =
  "select id::text as id, reason, detail, status, created_at::text as created_at from review_item where queue = 'scheduled_check' and status in ('open','claimed') " +
  `and detail->>'role' = any($1::text[]) order by created_at, id limit ${MAX_SHOWN + 1}`;
export type ScheduledItem = { id: string; reason: string; detail: Record<string, string>; status: string; created_at: string };

/** The open reminders for the roles this staff member holds. */
export async function listScheduledChecks(db: Q, staff: string): Promise<{ items: ScheduledItem[]; truncated: boolean }> {
  const held = await requireRole(db, staff, SCHEDULED_ROLES, "not_scheduled_staff");
  return page((await db.query<ScheduledItem>(SCHEDULED_LIST, [rolesFor(held)])).rows);
}

// One statement: the item is closed only when it is open and of a role the member holds, and its audit row is written with it.
export const SCHEDULED_DONE =
  "with w as (update review_item set status = 'done', decided_by_staff_user_id = $2, decided_at = now(), outcome = 'done' where id = $1::bigint " +
  "and queue = 'scheduled_check' and status in ('open','claimed') and detail->>'role' = any($3::text[]) returning id, reason) " +
  "insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, after, source) " +
  "select 'admin_action', $2, 'scheduled_check.done', 'review_item', id::text, jsonb_build_object('reason', reason), 'panel' from w";
const SCHEDULED_STATE = "select status, detail->>'role' as role from review_item where id = $1::bigint and queue = 'scheduled_check'";

/** Marks one reminder done. */
export async function doneScheduledCheck(db: Db, staff: string, itemId: unknown): Promise<void> {
  if (!validId(itemId)) throw new QueueRefused("not_found");
  await inTransaction(db, staff, SCHEDULED_ROLES, "not_scheduled_staff", async (c, held) => {
    const roles = rolesFor(held);
    if ((await c.query(SCHEDULED_DONE, [itemId, staff, roles])).rowCount === 1) return;
    const s = (await c.query<{ status: string; role: string }>(SCHEDULED_STATE, [itemId])).rows[0];
    if (!s || !roles.includes(s.role)) throw new QueueRefused("not_found"); // another role's item is not shown to this member either
    throw new QueueRefused("already_decided");
  });
}

// ===== Q12: the overdue view =====
const DAY = 86_400_000;
const DUBLIN = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
/** The Irish wall clock of an instant, as a UTC time with the same digits. */
function wall(t: number): number {
  const p = Object.fromEntries(DUBLIN.formatToParts(t).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) + (((t % 1000) + 1000) % 1000);
}
/**
 * One working day (Monday to Friday, Irish time) before `now`: an item created before it has waited more than a working day. A weekend counts
 * as no time (Monday 10:00 gives Friday 10:00; any time at the weekend gives Thursday 24:00, the start of Friday). Pure.
 * ponytail: no bank holidays (there is no list in the repo); add a list of dates here when one exists.
 */
export function workingDayBefore(now: Date): Date {
  let w = wall(now.getTime());
  const dow = new Date(w).getUTCDay();
  if (dow === 6 || dow === 0) w = Math.floor(w / DAY) * DAY - (dow === 0 ? DAY : 0); // the weekend starts at Saturday 00:00
  w -= DAY;
  if (new Date(w).getUTCDay() === 0) w -= 2 * DAY; // from Monday back over the weekend to Friday
  const guess = w - (wall(w) - w); // wall clock back to an instant, with the offset at the answer (a second pass covers a clock change)
  return new Date(w - (wall(guess) - guess));
}

// Every queue, oldest first. ponytail: no index orders open items across queues; the open set is small (cleared daily), add (created_at, id) where open if it grows.
export const OVERDUE =
  "select id::text as id, queue, status, claimed_by_staff_user_id as claimed_by, created_at::text as created_at from review_item " +
  `where status in ('open','claimed') and created_at < $1::timestamptz order by created_at, id limit ${MAX_SHOWN + 1}`;
export type OverdueItem = { id: string; queue: string; status: string; claimed_by: string | null; created_at: string };
// Two-person requests waiting for a second person, oldest first (approval_request is small: one pending per target, approval_request_pending_unique).
export const OVERDUE_APPROVALS =
  "select id::text as id, kind, target_table, target_id, proposed_by_staff_user_id as proposed_by, created_at::text as created_at from approval_request " +
  `where status = 'pending' and created_at < $1::timestamptz order by created_at, id limit ${MAX_SHOWN + 1}`;
export type OverdueApproval = { id: string; kind: string; target_table: string; target_id: string; proposed_by: string; created_at: string };

/** Open and claimed items of every queue, and approval requests waiting for a second person, older than one working day. Administrators only. */
export async function listOverdue(db: Q, staff: string, now = new Date()) {
  await requireRole(db, staff, ["administrator"], "not_administrator");
  const before = workingDayBefore(now).toISOString();
  const [items, approvals] = await Promise.all([db.query<OverdueItem>(OVERDUE, [before]), db.query<OverdueApproval>(OVERDUE_APPROVALS, [before])]);
  const a = page(approvals.rows);
  return { before, ...page(items.rows), approvals: a.items, approvalsTruncated: a.truncated };
}

// ===== the two-person requests of Q14 and R2 =====
const PROPOSE = "insert into approval_request(kind, target_table, target_id, change, reason) values ($1, $2, $3, $4::jsonb, $5) returning id::text as id";
export async function propose(c: pg.PoolClient, args: [string, string, string, string, string]): Promise<string> {
  try {
    return (await c.query<{ id: string }>(PROPOSE, args)).rows[0]!.id;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new QueueRefused("decision_pending"); // approval_request_pending_unique: one at a time per target
    throw e;
  }
}
const LOCK = "select id::text as id, target_id, change, status, proposed_by_staff_user_id as proposed_by from approval_request where id = $1::bigint and kind = $2 for update";
export type Locked = { id: string; target_id: string; change: Record<string, unknown>; status: string; proposed_by: string };
export async function lockRequest(c: pg.PoolClient, kind: string, requestId: unknown): Promise<Locked> {
  const r = validId(requestId) ? (await c.query<Locked>(LOCK, [requestId, kind])).rows[0] : undefined;
  if (!r) throw new QueueRefused("not_found");
  if (r.status !== "pending") throw new QueueRefused("request_not_pending");
  return r;
}
export const SET_STATUS = "update approval_request set status = $2 where id = $1::bigint and status = 'pending'";
/** Ends a pending request: withdrawn by its proposer, refused by anyone else allowed (the staff route's rule). */
export async function endRequest(c: pg.PoolClient, staff: string, kind: string, requestId: unknown, type: string): Promise<void> {
  const r = await lockRequest(c, kind, requestId);
  const withdrawn = r.proposed_by === staff;
  await c.query(SET_STATUS, [r.id, withdrawn ? "withdrawn" : "refused"]);
  await audit(c, staff, `${kind}.${withdrawn ? "withdraw" : "refuse"}`, type, r.target_id, { request_id: r.id }, withdrawn ? null : r.proposed_by);
}
export const PENDING_OF = "select id::text as id, target_id, change, proposed_by_staff_user_id as proposed_by, created_at::text as created_at from approval_request " +
  "where kind = $1 and status = 'pending' order by id limit 200";

// ===== Q14: the company seed (brand list) =====
// A rules data editor proposes (20c: RE edits, AD approves); an administrator who did not propose confirms. The proposer may withdraw.
export const SEED_PROPOSERS = ["rules_data_editor"] as const;
const SEED_READERS = ["rules_data_editor", "administrator"] as const;
export const MAX_SEED_TEXT = 1_000_000; // characters, as company-seed-cli.ts's file cap

/** The pending import (at most one) with its rows. */
export async function listCompanySeed(db: Q, staff: string): Promise<{ pending: { requestId: string; proposedBy: string; createdAt: string; rows: SeedRow[] }[] }> {
  await requireRole(db, staff, SEED_READERS, "not_seed_staff");
  const r = await db.query(PENDING_OF, ["company_seed"]);
  return { pending: r.rows.map((x) => ({ requestId: x.id, proposedBy: x.proposed_by, createdAt: x.created_at, rows: x.change.rows })) };
}

/** Proposes a seed file (the company-seed-cli.ts format). A file with any bad line is refused whole (bad_data, the first lines' errors in stage). */
export async function proposeCompanySeed(db: Db, staff: string, text: unknown): Promise<{ requestId: string; rows: number }> {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_SEED_TEXT) throw new QueueRefused("bad_text");
  return inTransaction(db, staff, SEED_PROPOSERS, "not_rules_data_editor", async (c) => {
    const { rows, errors } = parseSeed(text);
    if (errors.length || rows.length === 0) throw new QueueRefused("bad_data", (errors.length ? errors.slice(0, 5) : ["no rows"]).join("; "));
    const requestId = await propose(c, ["company_seed", "organisation", "company_seed", JSON.stringify({ rows }), "company seed"]);
    await audit(c, staff, "company_seed.propose", "approval_request", requestId, { rows: rows.length });
    return { requestId, rows: rows.length };
  });
}

const USE_SEED = "select private.use_company_seed($1::bigint)";
/** An administrator who did not propose confirms: the seed runs in the same transaction, so a failure leaves the request pending. */
export async function confirmCompanySeed(db: Db, staff: string, requestId: unknown): Promise<SeedResult> {
  return inTransaction(db, staff, ["administrator"], "not_administrator", async (c) => {
    const r = await lockRequest(c, "company_seed", requestId);
    if (r.proposed_by === staff) throw new QueueRefused("same_person");
    await c.query(SET_STATUS, [r.id, "confirmed"]);
    await c.query(USE_SEED, [r.id]); // marks it used (applied_at): a request is applied once, and the database's seed guard needs it
    const out = await seedRows(c, r.change.rows as SeedRow[]);
    const { refused, deteNotFound, notes, ...counts } = out;
    await audit(c, staff, "company_seed.confirm", "approval_request", r.id, { ...counts, refused: refused.length, deteNotFound: deteNotFound.length, notes: notes.length }, r.proposed_by);
    return out;
  });
}

export const refuseCompanySeed = (db: Db, staff: string, requestId: unknown) =>
  inTransaction(db, staff, SEED_READERS, "not_seed_staff", (c) => endRequest(c, staff, "company_seed", requestId, "approval_request"));

// ===== R2: a setting's value =====
// An administrator proposes, a different administrator confirms (as role grants, staff-admin.ts). The key must be a row of `setting`; the value a
// whole number from 0 to MAX_SETTING, or null (not set). The unit never changes here (no grant).
export const MAX_SETTING = 100_000;
const KEY = /^[a-z][a-z0-9_]{0,62}$/;
const validValue = (v: unknown): v is number | null => v === null || (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_SETTING);
export const SETTINGS =
  "select key, value, unit, is_guess, solicitor_confirmed_at::text as solicitor_confirmed_at, updated_by_staff_user_id as updated_by, updated_at::text as updated_at from setting order by key";
const SETTING_OF = "select value from setting where key = $1 for update";

/** Every setting with its value, and the changes waiting for a second administrator. */
export async function listSettings(db: Q, staff: string) {
  await requireRole(db, staff, ["administrator"], "not_administrator");
  const [s, p] = await Promise.all([db.query(SETTINGS), db.query(PENDING_OF, ["setting"])]);
  return { settings: s.rows, pending: p.rows.map((x) => ({ requestId: x.id, key: x.target_id, value: x.change.value, proposedBy: x.proposed_by, createdAt: x.created_at })) };
}

export async function proposeSetting(db: Db, staff: string, key: unknown, value: unknown): Promise<{ requestId: string }> {
  if (typeof key !== "string" || !KEY.test(key)) throw new QueueRefused("bad_key");
  if (!validValue(value)) throw new QueueRefused("bad_value");
  return inTransaction(db, staff, ["administrator"], "not_administrator", async (c) => {
    const cur = (await c.query<{ value: number | null }>(SETTING_OF, [key])).rows[0];
    if (!cur) throw new QueueRefused("not_found");
    if (cur.value === value) throw new QueueRefused("no_change");
    const requestId = await propose(c, ["setting", "setting", key, JSON.stringify({ value }), "setting change"]);
    await audit(c, staff, "setting.propose", "setting", key, { request_id: requestId, before: cur.value, value });
    return { requestId };
  });
}

/** A different administrator confirms; the value is written in the same transaction (setting_guard uses the request and writes the audit row). */
export async function confirmSetting(db: Db, staff: string, requestId: unknown): Promise<{ key: string; value: number | null }> {
  return inTransaction(db, staff, ["administrator"], "not_administrator", async (c) => {
    const r = await lockRequest(c, "setting", requestId);
    if (r.proposed_by === staff) throw new QueueRefused("same_person");
    const value = r.change.value as number | null;
    if ((await c.query<{ value: number | null }>(SETTING_OF, [r.target_id])).rows[0]?.value === value) throw new QueueRefused("no_change"); // changed since the proposal
    await c.query(SET_STATUS, [r.id, "confirmed"]);
    // A confirmed value is a staff decision, no longer a guess; cleared (null) means not set, and a value not set is still to be decided.
    await c.query("update setting set value = $2, is_guess = $2::integer is null where key = $1", [r.target_id, value]);
    await audit(c, staff, "setting.confirm", "setting", r.target_id, { request_id: r.id, value }, r.proposed_by);
    return { key: r.target_id, value };
  });
}

export const refuseSetting = (db: Db, staff: string, requestId: unknown) =>
  inTransaction(db, staff, ["administrator"], "not_administrator", (c) => endRequest(c, staff, "setting", requestId, "setting"));

// ===== C6: merge two candidate accounts of one person =====
// An administrator proposes {keep, drop}; a different administrator confirms and private.candidate_merge (0048) moves the dropped account's rows to the
// kept one and erases the dropped account in the same transaction, using the request once. The stored files it returns are removed after the commit;
// a failed removal is logged by key (a random id) for removal by hand, as the self delete does. The proposer withdraws, another administrator refuses.
const LOGIN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CANDIDATE = "select deleted_at is not null as deleted from candidate_user where id = $1";
const MERGE_REFUSED = /^merge refused: ([a-z_]+)/;
export type MergeMoved = Record<"savedJobs" | "alerts" | "tracker" | "hiddenOrganisations" | "profile" | "cv" | "applications" | "contactRequests", number>;

/** The merges waiting for a second administrator (ids only). */
export async function listCandidateMerges(db: Q, staff: string) {
  await requireRole(db, staff, ["administrator"], "not_administrator");
  const p = await db.query(PENDING_OF, ["candidate_merge"]);
  return { pending: p.rows.map((x) => ({ requestId: x.id, keep: x.change.keep, drop: x.change.drop, proposedBy: x.proposed_by, createdAt: x.created_at })) };
}

export async function proposeCandidateMerge(db: Db, staff: string, keep: unknown, drop: unknown): Promise<{ requestId: string }> {
  if (typeof keep !== "string" || !LOGIN_ID.test(keep) || typeof drop !== "string" || !LOGIN_ID.test(drop)) throw new QueueRefused("bad_user_id");
  if (keep === drop) throw new QueueRefused("same_account");
  return inTransaction(db, staff, ["administrator"], "not_administrator", async (c) => {
    const k = (await c.query<{ deleted: boolean }>(CANDIDATE, [keep])).rows[0];
    if (!k || !(await c.query(CANDIDATE, [drop])).rowCount) throw new QueueRefused("not_found");
    if (k.deleted) throw new QueueRefused("kept_account_deleted");
    const requestId = await propose(c, ["candidate_merge", "candidate_user", drop, JSON.stringify({ keep, drop }), "candidate merge"]);
    await audit(c, staff, "candidate_merge.propose", "candidate_user", keep, { request_id: requestId, dropped: drop });
    return { requestId };
  });
}

/** A different administrator confirms: the merge runs at once. Refused (and the request left pending) on an open case or report of either account. */
export async function confirmCandidateMerge(db: Db, staff: string, requestId: unknown): Promise<{ keep: string; drop: string; moved: MergeMoved; filesRemoved: number }> {
  const out = await inTransaction(db, staff, ["administrator"], "not_administrator", async (c) => {
    const r = await lockRequest(c, "candidate_merge", requestId);
    if (r.proposed_by === staff) throw new QueueRefused("same_person");
    await c.query(SET_STATUS, [r.id, "confirmed"]);
    try {
      return (await c.query<{ r: { keep: string; drop: string; moved: MergeMoved; storage_keys: string[] } }>("select private.candidate_merge($1::bigint) r", [r.id])).rows[0]!.r;
    } catch (e) {
      const m = (e as { code?: string }).code === "P0001" ? MERGE_REFUSED.exec((e as Error).message) : null;
      throw m ? new QueueRefused(m[1]!) : e;
    }
  });
  let filesRemoved = 0;
  for (const k of out.storage_keys) {
    try { await fileStore().remove(k); filesRemoved++; } catch { console.error("candidate merge: stored file not removed, delete by hand:", JSON.stringify(k)); }
  }
  return { keep: out.keep, drop: out.drop, moved: out.moved, filesRemoved };
}

export const refuseCandidateMerge = (db: Db, staff: string, requestId: unknown) =>
  inTransaction(db, staff, ["administrator"], "not_administrator", (c) => endRequest(c, staff, "candidate_merge", requestId, "candidate_user"));

// ===== Q2: act on a data request (queue data_request) =====
// Administrators only (20c: data requests are AD's). The account is the one whose email is the requester's email on the item's message
// (private.data_request_account, 0050: refused no_account, several_accounts, sender_not_account). Staff never read anyone's data (20c, decision
// #271): send_confirm emails the matched login's own address a one-time link (the outbox sender makes the token, outbox-cli.ts); its owner confirms
// on their own site and, for an export, downloads it there (data-request-confirm.ts). erase: irreversible, so two administrators (as C6), and only
// once the request is proved (sent by that login while signed in, or confirmed by its owner for an erase; private.data_request_proved).
// private.data_request_erase (0050) runs the erase function and closes the item. close: ends an item that needs nothing more.
const DR_REFUSED = /^data request refused: ([a-z_]+)/;
const drRefusal = (e: unknown) => {
  const m = (e as { code?: string }).code === "P0001" ? DR_REFUSED.exec((e as Error).message) : null;
  return m ? new QueueRefused(m[1]!) : e;
};
type Account = { kind: "candidate" | "portal"; userId: string };
async function accountOf(c: Q, itemId: unknown, fn = "data_request_account"): Promise<Account> {
  if (!validId(itemId)) throw new QueueRefused("not_found");
  try {
    return (await c.query<{ a: Account }>(`select private.${fn}($1::bigint) a`, [itemId])).rows[0]!.a;
  } catch (e) {
    throw drRefusal(e);
  }
}
// Oldest first on review_item_queue_idx; the requester's email from the message (signedIn: the message came from a signed-in login) and the
// state of the owner's confirmation.
export const DATA_REQUESTS =
  "select i.id::text as \"itemId\", i.status, i.created_at::text as \"createdAt\", m.surface, m.from_email as email, " +
  "coalesce(m.candidate_user_id, m.portal_user_id) is not null as \"signedIn\", i.detail->>'purpose' as \"confirmPurpose\", " +
  "i.detail->>'sentAt' as \"confirmSentAt\", i.detail->>'confirmedAt' as \"confirmedAt\" from review_item i join contact_message m on m.id = i.contact_message_id " +
  `where i.queue = 'data_request' and i.status in ('open','claimed') order by i.created_at, i.id limit ${MAX_SHOWN + 1}`;
export type DataRequestItem = { itemId: string; status: string; createdAt: string; surface: string; email: string | null; signedIn: boolean;
  confirmPurpose: string | null; confirmSentAt: string | null; confirmedAt: string | null };

/** The open data requests and the erasures waiting for a second administrator. */
export async function listDataRequests(db: Q, staff: string) {
  await requireRole(db, staff, ["administrator"], "not_administrator");
  const [items, p] = await Promise.all([db.query<DataRequestItem>(DATA_REQUESTS), db.query(PENDING_OF, ["data_request_erase"])]);
  return { ...page(items.rows), pending: p.rows.map((x) => ({ requestId: x.id, itemId: x.target_id, kind: x.change.kind, userId: x.change.userId, proposedBy: x.proposed_by, createdAt: x.created_at })) };
}

export const DR_PURPOSES = ["export", "erase"] as const;
const LOGIN_STATE = { candidate: "select email_verified, deleted_at is not null as deleted from candidate_user where id = $1",
  portal: "select email_verified, deleted_at is not null as deleted from portal_user where id = $1" } as const;
// The item's detail is replaced (a new send ends an older link and an older confirmation); the outbox row names the login, so the sender takes
// that login's own address (outbox-cli.ts ADDRESSES). One audit row.
const DR_SEND =
  "update review_item set detail = jsonb_build_object('purpose', $2::text, 'kind', $3::text, 'userId', $4::text, 'sentBy', $5::text, 'sentAt', now()) " +
  "where id = $1::bigint and status in ('open','claimed') returning detail->>'sentAt' as sent_at";
const DR_OUTBOX = (kind: Account["kind"]) =>
  `insert into email_outbox(template, ${kind}_user_id, params, dedupe_key) values ('data_request_confirm', $1, jsonb_build_object('itemId', $2::text, 'sentAt', $3::text), ` +
  "'data_request_confirm:' || $2 || ':' || $3)";

/** Queues the confirm email to the matched login's own, confirmed address. */
export async function sendDataRequestConfirm(db: Db, staff: string, itemId: unknown, purpose: unknown): Promise<Account & { purpose: string }> {
  if (!(DR_PURPOSES as readonly unknown[]).includes(purpose)) throw new QueueRefused("bad_purpose");
  return inTransaction(db, staff, ["administrator"], "not_administrator", async (c) => {
    const a = await accountOf(c, itemId);
    const u = (await c.query<{ email_verified: boolean; deleted: boolean }>(LOGIN_STATE[a.kind], [a.userId])).rows[0]!;
    if (u.deleted) throw new QueueRefused("account_deleted");
    if (!u.email_verified) throw new QueueRefused("email_not_confirmed");
    const sentAt = (await c.query<{ sent_at: string }>(DR_SEND, [itemId, purpose, a.kind, a.userId, staff])).rows[0]!.sent_at;
    await c.query(DR_OUTBOX(a.kind), [a.userId, itemId, sentAt]);
    await audit(c, staff, "data_request.send_confirm", "review_item", itemId as string, { purpose, kind: a.kind });
    return { ...a, purpose: purpose as string };
  });
}

export const DR_CLOSE =
  "with w as (update review_item set status = 'done', outcome = 'answered', decided_by_staff_user_id = $2, decided_at = now(), candidate_user_id = null, portal_user_id = null, detail = null " +
  "where id = $1::bigint and queue = 'data_request' and status in ('open','claimed') returning id) " +
  "insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, source) select 'admin_action', $2, 'data_request.close', 'review_item', id::text, 'panel' from w";

/** Closes an open item with nothing erased (the owner downloaded the export, or nothing more is needed); its link stops working. */
export async function closeDataRequest(db: Db, staff: string, itemId: unknown): Promise<void> {
  if (!validId(itemId)) throw new QueueRefused("not_found");
  await inTransaction(db, staff, ["administrator"], "not_administrator", async (c) => {
    if ((await c.query(DR_CLOSE, [itemId, staff])).rowCount !== 1) throw new QueueRefused("not_found");
  });
}

export async function proposeDataRequestErase(db: Db, staff: string, itemId: unknown): Promise<Account & { requestId: string }> {
  return inTransaction(db, staff, ["administrator"], "not_administrator", async (c) => {
    const a = await accountOf(c, itemId, "data_request_proved");
    const requestId = await propose(c, ["data_request_erase", "review_item", itemId as string, JSON.stringify(a), "data request erase"]);
    await audit(c, staff, "data_request_erase.propose", "review_item", itemId as string, { request_id: requestId, kind: a.kind });
    return { ...a, requestId };
  });
}

/** A different administrator confirms: the erase runs at once. Refused (the request left pending) on an open case or report, or a changed match. */
export async function confirmDataRequestErase(db: Db, staff: string, requestId: unknown): Promise<Account & { filesRemoved: number }> {
  const out = await inTransaction(db, staff, ["administrator"], "not_administrator", async (c) => {
    const r = await lockRequest(c, "data_request_erase", requestId);
    if (r.proposed_by === staff) throw new QueueRefused("same_person");
    await c.query(SET_STATUS, [r.id, "confirmed"]);
    try {
      return (await c.query<{ r: Account & { storage_keys: string[] } }>("select private.data_request_erase($1::bigint) r", [r.id])).rows[0]!.r;
    } catch (e) {
      throw drRefusal(e);
    }
  });
  let filesRemoved = 0;
  for (const k of out.storage_keys) {
    try { await fileStore().remove(k); filesRemoved++; } catch { console.error("data request erase: stored file not removed, delete by hand:", JSON.stringify(k)); }
  }
  return { kind: out.kind, userId: out.userId, filesRemoved };
}

export const refuseDataRequestErase = (db: Db, staff: string, requestId: unknown) =>
  inTransaction(db, staff, ["administrator"], "not_administrator", (c) => endRequest(c, staff, "data_request_erase", requestId, "review_item"));
