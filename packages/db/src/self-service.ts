// Audit row R1: the portal login's own data export and self delete (migration 0034), and the staff member's own data export. Candidates have theirs in
// candidate.ts. Staff never delete their own login: an administrator disables it (staff-admin.ts, disableLogin).
import type pg from "pg";
import { fileStore } from "./file-store";
import { staffRoles } from "./staff-admin";

/** The refusals of private.portal_account_* as a status and code. Anything else raised is REFUSED (fail closed); a non P0001 error is not ours (null). */
const ACCOUNT_STATUS: Record<string, number> = { NO_SESSION: 401, OPEN_SERVICES_CASE: 409, OWNER_MUST_TRANSFER: 409, CLOSE_COMPANY_FIRST: 409 };
export function accountRefusal(e: unknown): { status: number; code: string } | null {
  const { code, message = "" } = (e ?? {}) as { code?: string; message?: string };
  if (code !== "P0001") return null;
  const c = /^account refused: ([A-Z_]+)/.exec(message)?.[1];
  return c && ACCOUNT_STATUS[c] ? { status: ACCOUNT_STATUS[c], code: c } : { status: 403, code: "REFUSED" };
}

/** The portal login that holds this session token: its data and one audit row, in one statement. */
export const portalExport = async (db: Pick<pg.Pool, "query">, token: string) =>
  ({ exportedAt: new Date().toISOString(), ...(await db.query("select private.portal_account_export($1) r", [token])).rows[0].r });

/** Erases the login that holds this session token (every session ends with it), then removes its stored files. The rows are already gone when a removal
 *  fails, so the key (a random id, never a name) goes to the server log for removal by hand, as the retention run does; the reply still says deleted. */
export async function portalDelete(db: Pick<pg.Pool, "query">, token: string): Promise<{ ok: true; filesRemoved: number }> {
  const keys: string[] = (await db.query("select private.portal_account_delete($1) r", [token])).rows[0].r.storage_keys;
  let removed = 0;
  for (const k of keys) {
    try { await fileStore().remove(k); removed++; } catch { console.error("portal account delete: stored file not removed, delete by hand:", JSON.stringify(k)); }
  }
  return { ok: true, filesRemoved: removed };
}

const list = (cols: string, from: string, order: string) => `(select coalesce(jsonb_agg(to_jsonb(t) order by ${order}), '[]') from (select ${cols} from ${from}) t)`;
// Every part filters by $1, the acting staff id. Ids and codes only: no case evidence, note bodies, reasons, before or after values, and no other staff
// member's id (who granted a role, who confirmed a request, who else claimed an item). The audit row of this export is written in the same statement, so it
// is not in this file (one snapshot) but in the next one.
export const STAFF_EXPORT_SQL = `with logged as (
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, source) values ('data_access', $1, 'staff.export', 'staff_user', $1, 'panel') returning 1)
select (select count(*) from logged) as logged, jsonb_build_object(
  'account', (select jsonb_build_object('name', u.name, 'email', u.email, 'emailConfirmed', u.email_verified, 'status', u.status, 'createdAt', u.created_at,
      'signInMethods', (select coalesce(jsonb_agg(distinct a.provider_id), '[]') from staff_account a where a.user_id = u.id)) from staff_user u where u.id = $1),
  'roles', ${list('r.role, r.seeded_by_owner as "seededByOwner"', "staff_role r where r.staff_user_id = $1", "role")},
  'yourActions', ${list('a.kind, a.action, a.object_type as "objectType", a.reason_code as "reasonCode", a.source, a.at', "audit_event a where a.actor_staff_user_id = $1", "at desc")},
  'reviewItems', ${list(`i.id::text as id, i.queue, i.status, i.outcome, case when i.claimed_by_staff_user_id = $1 then i.claimed_at end as "claimedAt",
      case when i.decided_by_staff_user_id = $1 then i.decided_at end as "decidedAt"`, "review_item i where i.claimed_by_staff_user_id = $1 or i.decided_by_staff_user_id = $1", "id::bigint")},
  'approvalRequests', ${list(`q.id::text as id, q.kind, q.status, case when q.proposed_by_staff_user_id = $1 then 'proposed' else 'confirmed' end as "yourPart", q.created_at as "createdAt", q.decided_at as "decidedAt"`,
      "approval_request q where q.proposed_by_staff_user_id = $1 or q.confirmed_by_staff_user_id = $1", "id::bigint")},
  'reportsDecided', ${list('r.id::text as id, r.status, r.decided_at as "decidedAt"', "report r where r.decided_by_staff_user_id = $1", "id::bigint")},
  'strikesDecided', ${list('s.id::text as id, s.stage, s.outcome', "strike s where s.decided_by_staff_user_id = $1 or s.appeal_decided_by_staff_user_id = $1", "id::bigint")},
  'contactMessagesClaimed', ${list('m.id::text as id, m.status, m.claimed_at as "claimedAt"', "contact_message m where m.claimed_by_staff_user_id = $1", "id::bigint")},
  'casesAssigned', ${list('c.id::text as id, c.status', "services_case c where c.assigned_staff_user_id = $1", "id::bigint")},
  'caseNotesWritten', ${list('n.id::text as id, n.services_case_id::text as "caseId", n.created_at as "createdAt"', "case_note n where n.author_staff_user_id = $1", "id::bigint")}) as data`;

/** The acting staff member's own data. Any active staff login, whatever its roles. One transaction: the acting id is set, then one statement. */
export async function staffExport(db: Pick<pg.Pool, "connect">, staff: string) {
  const c = await db.connect();
  try {
    await c.query("begin");
    await staffRoles(c, staff); // sets app.staff_user_id for the audit row; refuses a disabled or unknown id
    const r = await c.query(STAFF_EXPORT_SQL, [staff]);
    await c.query("commit");
    return { exportedAt: new Date().toISOString(), ...r.rows[0].data };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally { c.release(); }
}
