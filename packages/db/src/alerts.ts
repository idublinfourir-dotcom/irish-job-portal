// Job alerts (step 11, part 11a): the signed-in candidate's own alerts (list, create, edit, pause, resume, delete) and the unsubscribe by token, which needs no sign-in.
// Every signed-in function takes the candidate's id from the session and puts it in every WHERE or INSERT (the database has no row level security).
// Filters only, no free text (Q2): search_text is never written. The matching run that sends the email is part 11b.
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { socTitle } from "@portal/rules";
import { clientAddress, inTransaction, isObject, only, Refuse, withinRate } from "./candidate-route";
import { isStamp4 } from "./candidate";
import { checkJobFilters, validId } from "./search";

export const MAX_ALERTS = 10; // per candidate, every row counts (D1)

// ===== the bodies
const FILTERS = ["occupationCode", "sector", "county", "salaryMin", "badge", "frequency"] as const;
export type AlertBody = { occupation_code: string | null; sector: string | null; county: string | null; salary_min: number | null; badge: string | null; frequency: "daily" | "weekly" };

/** Null means refuse. A filter that is absent or null means "any"; unknown fields and free text are refused. */
const filters = (b: Record<string, unknown>, occupations: ReadonlySet<string>): AlertBody | null => {
  const f = checkJobFilters(b, occupations);
  const { frequency } = b;
  if (!f || (frequency !== "daily" && frequency !== "weekly")) return null;
  return { occupation_code: f.occupationCode, sector: f.sector, county: f.county, salary_min: f.salaryMin, badge: f.badge, frequency };
};
export const checkAlert = (occupations: ReadonlySet<string>) => (b: unknown): AlertBody | null =>
  isObject(b) && only(b, FILTERS) ? filters(b, occupations) : null;
/** An edit replaces every filter (a key left out becomes "any"), like the profile PUT. */
export const checkAlertEdit = (occupations: ReadonlySet<string>) => (b: unknown): (AlertBody & { id: string }) | null => {
  if (!isObject(b) || !only(b, ["id", ...FILTERS]) || !validId(b.id)) return null;
  const f = filters(b, occupations);
  return f && { ...f, id: b.id };
};
export const checkAlertId = (b: unknown): { id: string } | null => (isObject(b) && only(b, ["id"]) && validId(b.id) ? { id: b.id } : null);

// ===== the signed-in routes
const ROW = `id::text as id, occupation_code as "occupationCode", sector, county, salary_min as "salaryMin", badge, frequency, status, pause_reason as "pauseReason", last_sent_at as "lastSentAt"`;

/** Newest first, at most 10 rows. The unsubscribe token is never returned. */
export async function listAlerts(db: pg.Pool, userId: string) {
  const r = await db.query(`select ${ROW} from alert where candidate_user_id = $1 order by id desc limit ${MAX_ALERTS}`, [userId]);
  return { alerts: r.rows };
}

/** Locks the candidate's row (so two requests at once cannot both take the last slot) and refuses an unverified candidate (20d) or a Stamp 4 (#105). */
async function gate(c: pg.PoolClient, userId: string) {
  const r = await c.query(
    `select u.email_verified as verified, (select current_stamp from candidate_profile where candidate_user_id = u.id) as stamp
     from candidate_user u where u.id = $1 and u.deleted_at is null and u.suspended_at is null for update of u`, [userId]);
  if (!r.rowCount) throw new Refuse(403, "REFUSED");
  if (!r.rows[0].verified) throw new Refuse(403, "EMAIL_NOT_VERIFIED");
  if (isStamp4(r.rows[0].stamp)) throw new Refuse(409, "STAMP_4");
}

/** The token is 32 characters from 24 random bytes (192 bits). */
export const newToken = () => randomBytes(24).toString("base64url");

export async function createAlert(db: pg.Pool, userId: string, a: AlertBody) {
  return inTransaction(db, async (c) => {
    await gate(c, userId);
    const r = await c.query(
      `insert into alert(candidate_user_id, occupation_code, sector, county, salary_min, badge, frequency, unsubscribe_token)
       select $1, $2, $3, $4, $5, $6, $7, $8 where (select count(*) from alert where candidate_user_id = $1) < ${MAX_ALERTS}
       returning ${ROW}`, [userId, a.occupation_code, a.sector, a.county, a.salary_min, a.badge, a.frequency, newToken()]);
    if (!r.rowCount) throw new Refuse(409, "ALERT_LIMIT");
    return { alert: r.rows[0] };
  });
}

export async function editAlert(db: pg.Pool, userId: string, a: AlertBody & { id: string }) {
  const r = await db.query(
    `update alert set occupation_code = $3, sector = $4, county = $5, salary_min = $6, badge = $7, frequency = $8
     where id = $1::bigint and candidate_user_id = $2 returning ${ROW}`, [a.id, userId, a.occupation_code, a.sector, a.county, a.salary_min, a.badge, a.frequency]);
  if (!r.rowCount) throw new Refuse(404, "ALERT_NOT_FOUND");
  return { alert: r.rows[0] };
}

/** Only an active alert is paused; any other alert stays as it is. */
export async function pauseAlert(db: pg.Pool, userId: string, b: { id: string }) {
  const r = await db.query(
    `update alert set pause_reason = case when status = 'active' then 'candidate' else pause_reason end, status = case when status = 'active' then 'paused' else status end
     where id = $1::bigint and candidate_user_id = $2 returning ${ROW}`, [b.id, userId]);
  if (!r.rowCount) throw new Refuse(404, "ALERT_NOT_FOUND");
  return { alert: r.rows[0] };
}

/** Back to active from paused or unsubscribed (D6). "New" starts again at the resume, so a long pause does not send a backlog. */
export async function resumeAlert(db: pg.Pool, userId: string, b: { id: string }) {
  return inTransaction(db, async (c) => {
    await gate(c, userId);
    const r = await c.query(
      `update alert set last_sent_at = case when status = 'active' then last_sent_at else now() end, status = 'active', pause_reason = null
       where id = $1::bigint and candidate_user_id = $2 returning ${ROW}`, [b.id, userId]);
    if (!r.rowCount) throw new Refuse(404, "ALERT_NOT_FOUND");
    return { alert: r.rows[0] };
  });
}

export async function deleteAlert(db: pg.Pool, userId: string, b: { id: string }) {
  const r = await db.query("delete from alert where id = $1::bigint and candidate_user_id = $2", [b.id, userId]);
  if (!r.rowCount) throw new Refuse(404, "ALERT_NOT_FOUND");
  return { ok: true };
}

// ===== unsubscribe by token (no sign-in)
export const TOKEN = /^[A-Za-z0-9_-]{32,64}$/; // checked before any query
// GET and POST together, per client address (Vercel's header, the only one trusted). ponytail: a mail provider's one-click POSTs share its servers'
// addresses; 60 a minute is far above this site's volume, raise it or key on the token too if real unsubscribes ever meet it.
export const UNSUBSCRIBE_RATE = { windowMs: 60_000, max: 60 };
/** True while this client address is under UNSUBSCRIBE_RATE. One statement; a bad link is refused before it, so junk costs no query. */
export const withinUnsubscribeRate = (headers: Headers) => withinRate("candidate_rate_limit", `unsubscribe:${clientAddress(headers)}`, UNSUBSCRIBE_RATE);
export type Scope = "one" | "all";
/** The token and scope of an unsubscribe link; null means refuse (nothing is queried). */
export function unsubscribeParams(url: URL): { token: string; scope: Scope } | null {
  const token = url.searchParams.get("token"), scope = url.searchParams.get("scope");
  return token !== null && TOKEN.test(token) && (scope === "one" || scope === "all") ? { token, scope } : null;
}

/** The alert's filters in words, for the unsubscribe page and the email. */
export function describeAlert(a: { occupationCode: string | null; sector: string | null; county: string | null; salaryMin: number | null; badge: string | null }): string[] {
  return [
    a.occupationCode && `Occupation: ${socTitle(a.occupationCode) ?? a.occupationCode} (${a.occupationCode})`,
    a.sector && `Sector: ${a.sector}`,
    a.county && `County: ${a.county}`,
    a.salaryMin !== null && `Pay from EUR ${a.salaryMin.toLocaleString("en-IE")} a year`,
    a.badge === "sponsor_confirmed" && "Sponsor confirmed jobs only",
    a.badge === "critical_skills_eligible" && "Critical Skills eligible jobs only",
  ].filter((x): x is string => typeof x === "string");
}

/** A GET changes nothing. A known token gives the alert's filters in words; an unknown one gives the same shape with `alert: null`. */
export async function unsubscribeInfo(db: pg.Pool, p: { token: string; scope: Scope }) {
  const r = await db.query(
    `select occupation_code as "occupationCode", sector, county, salary_min as "salaryMin", badge, frequency, status from alert where unsubscribe_token = $1`, [p.token]);
  const a = r.rows[0];
  return { scope: p.scope, alert: a ? { filters: describeAlert(a), frequency: a.frequency as string, status: a.status as string } : null };
}

/** `one`: that alert. `all`: every alert of the same candidate. An unknown token changes nothing and answers the same. */
export async function unsubscribe(db: pg.Pool, p: { token: string; scope: Scope }) {
  await db.query(
    `update alert set status = 'unsubscribed' where status <> 'unsubscribed' and ${p.scope === "one" ? "unsubscribe_token = $1"
      : "candidate_user_id = (select candidate_user_id from alert where unsubscribe_token = $1)"}`, [p.token]);
  return { ok: true, scope: p.scope };
}
