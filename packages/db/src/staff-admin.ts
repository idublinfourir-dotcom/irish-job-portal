// Staff accounts from the admin panel (#233, #234 D4 and D5): list staff with their roles, grant a role through the two-person rule (an administrator proposes, a
// different administrator confirms, #137 b), remove a role at once, disable a login (every open session ends in the same transaction) and enable it again. Every call
// takes the acting staff id from the session and checks in the database, in the same statement that sets app.staff_user_id, that it is an active administrator.
// No function makes a login: the owner's command does (staff-seed-cli.ts). The grant itself is role-grant.ts, shared with the owner's command.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { QueueRefused } from "./admin-queue";
import { confirmGrant, proposeGrant } from "./role-grant";
import { validId } from "./search";
import { AUDIT } from "./trust-safety";

type Q = Pick<pg.Pool, "query">;
type Db = Pick<pg.Pool, "query" | "connect">;

// The same seven roles as staff-seed-cli.ts and the staff_role check (0001). Not imported from the command: it loads files by their .ts name, which the apps cannot. A test keeps the two lists equal.
export const STAFF_ROLE_LIST: readonly string[] = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "services_case_handler", "content_editor", "administrator"];
export const MAX_STAFF_SHOWN = 200; // ponytail: the whole team in one answer; add a cursor if staff ever pass a few dozen
const STAFF_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const validStaffId = (s: unknown): s is string => typeof s === "string" && STAFF_ID.test(s);

// One statement: sets the acting id and answers whether the login is active and which roles it holds (no row at all for an unknown id).
export const STAFF_WHO =
  "select set_config('app.staff_user_id', $1, true) as acting, u.status = 'active' as active, coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles " +
  "from staff_user u left join staff_role r on r.staff_user_id = u.id where u.id = $1 group by u.id";

/** The acting member's roles. Throws not_active_staff for an unknown, disabled or malformed id. Roles are read from the database on every call (#233). */
export async function staffRoles(db: Q, staff: string): Promise<string[]> {
  if (!validStaffId(staff)) throw new QueueRefused("not_active_staff");
  const r = (await db.query<{ active: boolean; roles: string[] }>(STAFF_WHO, [staff])).rows[0];
  if (!r?.active) throw new QueueRefused("not_active_staff");
  return r.roles;
}
// B57: the signed-in member's own name and roles, for the sidebar chip and the links its roles may open. One statement; a disabled or unknown login has no row that counts.
export const STAFF_ME =
  "select u.id, u.name, u.status = 'active' as active, coalesce(array_agg(r.role order by r.role) filter (where r.role is not null), '{}') as roles " +
  "from staff_user u left join staff_role r on r.staff_user_id = u.id where u.id = $1 group by u.id";
/** Any active staff login, whatever its roles: its id, name and roles. Throws not_active_staff for an unknown, disabled or malformed id. */
export async function staffMe(db: Q, staff: string): Promise<{ id: string; name: string; roles: string[] }> {
  if (!validStaffId(staff)) throw new QueueRefused("not_active_staff");
  const r = (await db.query<{ id: string; name: string; active: boolean; roles: string[] }>(STAFF_ME, [staff])).rows[0];
  if (!r?.active) throw new QueueRefused("not_active_staff");
  return { id: r.id, name: r.name, roles: r.roles };
}
/** Throws `why` unless the acting member holds one of `any`. */
export async function requireRole(db: Q, staff: string, any: readonly string[], why: string): Promise<string[]> {
  const roles = await staffRoles(db, staff);
  if (!any.some((r) => roles.includes(r))) throw new QueueRefused(why);
  return roles;
}
const admin = (db: Q, staff: string) => requireRole(db, staff, ["administrator"], "not_administrator");

async function inTransaction<T>(db: Db, staff: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("begin");
    await admin(c, staff);
    const out = await fn(c);
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
  c.query(AUDIT, [staff, `staff.${action}`, type, id, JSON.stringify(after), null, second, null]);
const checkTarget = (id: unknown): string => {
  if (!validStaffId(id)) throw new QueueRefused("bad_staff_id");
  return id;
};
const checkRole = (role: unknown): string => {
  if (typeof role !== "string" || !STAFF_ROLE_LIST.includes(role)) throw new QueueRefused("bad_role");
  return role;
};

// ===== the list =====
const LIST =
  "select u.id, u.name, u.email, u.status, u.created_at::text as created_at, coalesce(array_agg(r.role order by r.role) filter (where r.role is not null), '{}') as roles " +
  `from staff_user u left join staff_role r on r.staff_user_id = u.id group by u.id order by u.created_at, u.id limit ${MAX_STAFF_SHOWN + 1}`;
const PENDING =
  "select q.id::text as id, q.target_id as staff_id, q.change->>'role' as role, q.proposed_by_staff_user_id as proposed_by, q.created_at::text as created_at from approval_request q " +
  `where q.target_table = 'staff_role' and q.status = 'pending' and q.kind in ('grant_role','grant_administrator') order by q.id limit ${MAX_STAFF_SHOWN}`;
export const STAFF_LIST = [LIST, PENDING];
export type StaffRow = { id: string; name: string; email: string; status: string; createdAt: string; roles: string[] };
export type PendingGrant = { requestId: string; staffId: string; role: string; proposedBy: string; createdAt: string };

/** Every staff login with its roles and status, and the role grants waiting for a second administrator. Administrators only. */
export async function listStaff(db: Q, staff: string): Promise<{ staff: StaffRow[]; truncated: boolean; pending: PendingGrant[] }> {
  await admin(db, staff);
  const [rows, pending] = await Promise.all([db.query(LIST), db.query(PENDING)]);
  return {
    staff: rows.rows.slice(0, MAX_STAFF_SHOWN).map((r) => ({ id: r.id, name: r.name, email: r.email, status: r.status, createdAt: r.created_at, roles: r.roles })),
    truncated: rows.rows.length > MAX_STAFF_SHOWN,
    pending: pending.rows.map((r) => ({ requestId: r.id, staffId: r.staff_id, role: r.role, proposedBy: r.proposed_by, createdAt: r.created_at })),
  };
}

// ===== role grants (two people) =====
const TARGET = "select status, exists (select 1 from staff_role r where r.staff_user_id = u.id and r.role = $2) as holds from staff_user u where u.id = $1 for share";

/** An administrator proposes a role for another login (or themselves); a different administrator confirms. One pending grant per login and kind. */
export async function proposeRoleGrant(db: Db, staff: string, target: string, role: string): Promise<{ requestId: string }> {
  checkTarget(target);
  checkRole(role);
  return inTransaction(db, staff, async (c) => {
    const t = (await c.query<{ status: string; holds: boolean }>(TARGET, [target, role])).rows[0];
    if (!t) throw new QueueRefused("not_found");
    if (t.status !== "active") throw new QueueRefused("target_not_active");
    if (t.holds) throw new QueueRefused("already_holds");
    let requestId: string;
    try {
      requestId = await proposeGrant(c as unknown as pg.ClientBase, staff, target, role, "role grant");
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new QueueRefused("grant_pending"); // approval_request_pending_unique
      throw e;
    }
    await audit(c, staff, "role_propose", "staff_user", target, { role, requestId });
    return { requestId };
  });
}

const REQUEST =
  "select id::text as id, status, kind, target_id, change->>'role' as role, proposed_by_staff_user_id as proposed_by from approval_request " +
  "where id = $1::bigint and target_table = 'staff_role' and kind in ('grant_role','grant_administrator') for update";
type Request = { id: string; status: string; kind: string; target_id: string; role: string; proposed_by: string };
async function lockRequest(c: pg.PoolClient, requestId: string): Promise<Request> {
  if (!validId(requestId)) throw new QueueRefused("not_found");
  const q = (await c.query<Request>(REQUEST, [requestId])).rows[0];
  if (!q) throw new QueueRefused("not_found");
  if (q.status !== "pending") throw new QueueRefused("request_not_pending");
  return q;
}

/** A different administrator confirms: the role is written in the same transaction (the database checks the request is confirmed, matching and used once). */
export async function confirmRoleGrant(db: Db, staff: string, requestId: string): Promise<{ staffId: string; role: string }> {
  return inTransaction(db, staff, async (c) => {
    const q = await lockRequest(c, requestId);
    if (q.proposed_by === staff) throw new QueueRefused("same_person");
    const t = (await c.query<{ status: string; holds: boolean }>(TARGET, [q.target_id, q.role])).rows[0];
    if (!t || t.status !== "active") throw new QueueRefused("target_not_active");
    if (t.holds) throw new QueueRefused("already_holds");
    await confirmGrant(c as unknown as pg.ClientBase, { confirmer: staff, proposer: q.proposed_by, staff: q.target_id, role: q.role, request: q.id });
    return { staffId: q.target_id, role: q.role };
  });
}

/** Ends a pending grant: refused when a different administrator does it, withdrawn when the proposer does (the pay floor route's rule). */
export async function refuseRoleGrant(db: Db, staff: string, requestId: string): Promise<void> {
  await inTransaction(db, staff, async (c) => {
    const q = await lockRequest(c, requestId);
    const withdrawn = q.proposed_by === staff;
    await c.query("update approval_request set status = $2 where id = $1::bigint", [q.id, withdrawn ? "withdrawn" : "refused"]);
    await audit(c, staff, withdrawn ? "role_withdraw" : "role_refuse", "staff_user", q.target_id, { role: q.role, requestId: q.id }, withdrawn ? null : q.proposed_by);
  });
}

// ===== invite a new login (step 15 Q15) =====
// One administrator makes the login (no password, no role) and proposes its first role in the same transaction; a different administrator confirms
// it as any grant (#104, #137 b). The route then sends the set-password email through Better Auth's reset (the security@ sender, #264); the invitee
// can ask for a new one at the sign-in page's reset if it runs out. One pending grant per login and kind (approval_request_pending_unique), so one
// role here and the others through propose_role.
export const STAFF_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/; // PLAIN_EMAIL in staff-seed-cli.ts (a test keeps them equal)
export const validStaffEmail = (v: unknown): v is string => typeof v === "string" && v.length <= 254 && STAFF_EMAIL.test(v);
export const validStaffName = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 100 && !/[\u0000-\u001f\u007f]/.test(v);
const INVITE = "insert into staff_user(id, name, email, email_verified, status) values ($1, $2, $3, false, 'active')";

/** Makes the login and proposes its first role. The email is stored lowercased, as Better Auth looks it up; it is returned for the email. */
export async function inviteStaff(db: Db, staff: string, email: unknown, name: unknown, role: unknown): Promise<{ staffId: string; requestId: string; email: string }> {
  const address = typeof email === "string" ? email.trim().toLowerCase() : email;
  if (!validStaffEmail(address)) throw new QueueRefused("bad_email");
  if (!validStaffName(name)) throw new QueueRefused("bad_name");
  checkRole(role);
  return inTransaction(db, staff, async (c) => {
    const id = randomUUID();
    try {
      await c.query(INVITE, [id, name.trim(), address]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new QueueRefused("email_taken"); // staff_user_email_key
      throw e;
    }
    const requestId = await proposeGrant(c as unknown as pg.ClientBase, staff, id, role as string, "role grant");
    await audit(c, staff, "invite", "staff_user", id, { role, requestId });
    return { staffId: id, requestId, email: address };
  });
}

// A new set-password email for an invited login that has not set a password yet (no credential account), at most RESEND_MAX an hour per login,
// counted from its staff.invite_resend audit rows under a lock on the login, so two resends at once take turns.
export const RESEND_MAX = 3;
const RESEND_TARGET =
  "select u.status, u.email, exists (select 1 from staff_account a where a.user_id = u.id and a.provider_id = 'credential') as has_password, " +
  "(select count(*)::int from audit_event e where e.object_id = u.id and e.object_type = 'staff_user' and e.action = 'staff.invite_resend' and e.at > now() - interval '1 hour') as recent " +
  "from staff_user u where u.id = $1 for update of u";

/** Checks and records a resend; returns the address for the email. */
export async function resendInvite(db: Db, staff: string, target: string): Promise<{ email: string }> {
  checkTarget(target);
  return inTransaction(db, staff, async (c) => {
    const t = (await c.query<{ status: string; email: string; has_password: boolean; recent: number }>(RESEND_TARGET, [target])).rows[0];
    if (!t) throw new QueueRefused("not_found");
    if (t.status !== "active") throw new QueueRefused("target_not_active");
    if (t.has_password) throw new QueueRefused("password_set");
    if (t.recent >= RESEND_MAX) throw new QueueRefused("too_many_resends");
    await audit(c, staff, "invite_resend", "staff_user", target, {});
    return { email: t.email };
  });
}

// ===== remove a role, disable, enable (one administrator, at once) =====
// Every path that could lower the number of active administrators first locks the active administrators' staff_user rows, in id order, then counts them
// again in a new statement: two administrators acting at once take turns, and the second sees the first one's result.
const LOCK_ADMINS = "select u.id from staff_user u where u.status = 'active' and exists (select 1 from staff_role r where r.staff_user_id = u.id and r.role = 'administrator') order by u.id for update of u";
const ADMINS = "select u.id from staff_user u where u.status = 'active' and exists (select 1 from staff_role r where r.staff_user_id = u.id and r.role = 'administrator')";
async function keepOneAdministrator(c: pg.PoolClient, leaving: string): Promise<void> {
  await c.query(LOCK_ADMINS);
  const ids = (await c.query<{ id: string }>(ADMINS)).rows.map((r) => r.id);
  if (ids.includes(leaving) && ids.every((i) => i === leaving)) throw new QueueRefused("last_administrator");
}

/** One administrator removes a role at once (#137 c). Refused when it would take the last active administrator's role away. */
export async function removeRole(db: Db, staff: string, target: string, role: string): Promise<void> {
  checkTarget(target);
  checkRole(role);
  await inTransaction(db, staff, async (c) => {
    if (role === "administrator") await keepOneAdministrator(c, target);
    const gone = await c.query("delete from staff_role where staff_user_id = $1 and role = $2", [target, role]);
    if (gone.rowCount !== 1) throw new QueueRefused("not_found");
    await audit(c, staff, "role_remove", "staff_user", target, { role });
  });
}

/** Disables a login and ends every open session of it in the same transaction. Refused when it is the last active administrator. */
export async function disableLogin(db: Db, staff: string, target: string): Promise<{ sessionsEnded: number }> {
  checkTarget(target);
  return inTransaction(db, staff, async (c) => {
    await keepOneAdministrator(c, target);
    const off = await c.query("update staff_user set status = 'disabled', updated_at = now() where id = $1 and status = 'active'", [target]);
    if (off.rowCount !== 1) {
      const t = (await c.query("select 1 from staff_user where id = $1", [target])).rowCount;
      throw new QueueRefused(t ? "already_disabled" : "not_found");
    }
    const ended = (await c.query("delete from staff_session where user_id = $1", [target])).rowCount ?? 0;
    await audit(c, staff, "disable", "staff_user", target, { sessionsEnded: ended });
    return { sessionsEnded: ended };
  });
}

/**
 * Turns a disabled login back on. The database refuses this for a login that still holds a role (migration 0004: that would be a role grant without the
 * second person), so the roles are removed first and granted again the usual way; the check here only gives the short code.
 */
export async function enableLogin(db: Db, staff: string, target: string): Promise<void> {
  checkTarget(target);
  await inTransaction(db, staff, async (c) => {
    const t = (await c.query<{ status: string; roles: number }>(
      "select u.status, (select count(*)::int from staff_role r where r.staff_user_id = u.id) as roles from staff_user u where u.id = $1 for update", [target])).rows[0];
    if (!t) throw new QueueRefused("not_found");
    if (t.status !== "disabled") throw new QueueRefused("not_disabled");
    if (t.roles > 0) throw new QueueRefused("holds_roles");
    await c.query("update staff_user set status = 'active', updated_at = now() where id = $1 and status = 'disabled'", [target]);
    await audit(c, staff, "enable", "staff_user", target, {});
  });
}

// ===== suspend a candidate login, block a portal login, and lift either (step 15 C3; one administrator, at once) =====
// Hold on: the login's open sessions end in the same transaction (the session hook in @portal/auth already refuses a held login's next request). The reason is a
// code, kept in the audit row (and, for a portal login, in blocked_reason_code); never free text. Appeal is the contact form (decision #55).
export type HoldPool = "candidate" | "portal";
const HOLD = {
  candidate: {
    on: "update candidate_user set suspended_at = now() where id = $1 and suspended_at is null",
    off: "update candidate_user set suspended_at = null where id = $1 and suspended_at is not null",
    exists: "select 1 from candidate_user where id = $1",
    sessions: "delete from candidate_session where user_id = $1",
    actions: ["account.suspend", "account.unsuspend"],
  },
  portal: {
    on: "update portal_user set status = 'blocked', blocked_at = now(), blocked_reason_code = $2 where id = $1 and status is distinct from 'blocked'",
    off: "update portal_user set status = 'active', blocked_at = null, blocked_reason_code = null where id = $1 and status = 'blocked'",
    exists: "select 1 from portal_user where id = $1",
    sessions: "delete from portal_session where user_id = $1",
    actions: ["account.block", "account.unblock"],
  },
} as const;
const REASON = /^[a-z][a-z0-9_]{0,62}$/;

/** Suspends (on) or lifts (off) a login of one pool. Administrators only. Refuses not_found, already_held (on) and not_held (off). */
export async function setLoginHold(db: Db, staff: string, pool: HoldPool, userId: string, on: boolean, reason: string): Promise<{ sessionsEnded: number }> {
  if (!validStaffId(userId)) throw new QueueRefused("bad_user_id"); // the same id shape in all three pools (Better Auth ids)
  if (typeof reason !== "string" || !REASON.test(reason)) throw new QueueRefused("bad_reason");
  const h = HOLD[pool];
  return inTransaction(db, staff, async (c) => {
    const done = await c.query(on ? h.on : h.off, pool === "portal" && on ? [userId, reason] : [userId]);
    if (done.rowCount !== 1) throw new QueueRefused((await c.query(h.exists, [userId])).rowCount ? (on ? "already_held" : "not_held") : "not_found");
    const ended = on ? ((await c.query(h.sessions, [userId])).rowCount ?? 0) : 0;
    await c.query(AUDIT, [staff, h.actions[on ? 0 : 1], `${pool}_user`, userId, JSON.stringify(on ? { sessionsEnded: ended } : {}), reason, null, null]);
    return { sessionsEnded: ended };
  });
}
