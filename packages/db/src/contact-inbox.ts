// The staff contact inbox (decision #55, 20c: SC and CE edit, AD views): list the new and claimed messages, read one, claim it, mark it answered, closed or spam.
// Run as app_admin, like admin-queue.ts. Every call takes the acting staff id and, in its first statement, checks the person is active staff with a role that may
// do it and sets app.staff_user_id for the transaction. Reading needs services_case_handler, content_editor or administrator; acting needs one of the first two.
// Reading one message and every status change write an audit_event row (codes and ids only, never the text); the list shows no name, email or text.
// Staff reply from the support mailbox for now: nothing is sent from here.
import type pg from "pg";
import { decodeReviewCursor } from "./account-review";
import { QueueRefused, STALE_AFTER } from "./admin-queue";
import { PAGE_SIZE, validId } from "./search";

type Db = Pick<pg.Pool, "query" | "connect">;

export const CONTACT_ACTIONS = { answer: "answered", close: "closed", spam: "spam" } as const;
export type ContactAction = keyof typeof CONTACT_ACTIONS;

// One statement: sets the acting id and answers two questions. A role is not implied by another.
export const CONTACT_ACT =
  "select set_config('app.staff_user_id', $1, true), exists (select 1 from staff_user where id = $1 and status = 'active') as active, " +
  "coalesce((select array_agg(r.role order by r.role = 'administrator', r.role) from staff_role r join staff_user u on u.id = r.staff_user_id " +
  "where u.id = $1 and u.status = 'active' and r.role in ('services_case_handler','content_editor','administrator')), '{}') as roles";
const ACTORS = ["services_case_handler", "content_editor"];

/** The role the call runs under (for the audit row), or a refusal. */
async function check(db: Pick<pg.Pool, "query">, staff: string, act: boolean): Promise<string> {
  if (typeof staff !== "string" || staff.length === 0 || staff.length > 200) throw new QueueRefused("not_active_staff");
  const r = (await db.query<{ active: boolean; roles: string[] }>(CONTACT_ACT, [staff])).rows[0]!;
  if (!r.active) throw new QueueRefused("not_active_staff");
  const role = act ? r.roles.find((x) => ACTORS.includes(x)) : r.roles[0];
  if (!role) throw new QueueRefused(act ? "not_contact_staff" : "not_contact_reader");
  return role;
}

async function acting<T>(db: Db, staff: string, act: boolean, fn: (c: pg.PoolClient, role: string) => Promise<T>): Promise<T> {
  if (typeof staff !== "string" || staff.length === 0 || staff.length > 200) throw new QueueRefused("not_active_staff");
  const c = await db.connect();
  try {
    await c.query("begin");
    const out = await fn(c, await check(c, staff, act));
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export const CONTACT_AUDIT =
  "insert into audit_event(kind, actor_staff_user_id, role_in_force, action, object_type, object_id, subject_candidate_user_id, after, source) " +
  "values ($1, $2, $3, $4, 'contact_message', $5, $6, $7::jsonb, 'panel')";
// The candidate (when the message came from a signed-in one) is the subject, so the access shows in their own data export.
const audit = (c: pg.PoolClient, kind: "data_access" | "admin_action", staff: string, role: string, action: string, id: string, subject: string | null, after: object) =>
  c.query(CONTACT_AUDIT, [kind, staff, role, `contact.${action}`, id, subject, JSON.stringify(after)]);

const camel = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase()), v]));

// ===== the list =====
// Oldest first on contact_message_inbox_idx (status, created_at, id). Each status is read in index order with its own limit, then the two are merged,
// so the page reads about 2 x PAGE_SIZE index entries however many messages wait.
const COLS = "m.id, m.status, m.topic, m.surface, m.created_at as at, m.created_at::text as created_text, m.claimed_by_staff_user_id, m.claimed_at::text as claimed_text from contact_message m";
const branch = (status: string, after: string) => `(select ${COLS} where m.status = '${status}'${after} order by m.created_at, m.id limit ${PAGE_SIZE + 1})`;
const KEYSET = " and (m.created_at, m.id) > ($1::timestamptz, $2::bigint)";
export const CONTACT_FIRST = `select id, status, topic, surface, created_text, claimed_by_staff_user_id, claimed_text from (${branch("new", "")} union all ${branch("claimed", "")}) p order by at, id limit ${PAGE_SIZE + 1}`;
export const CONTACT_AFTER = `select id, status, topic, surface, created_text, claimed_by_staff_user_id, claimed_text from (${branch("new", KEYSET)} union all ${branch("claimed", KEYSET)}) p order by at, id limit ${PAGE_SIZE + 1}`;

type Row = Record<string, unknown> & { id: string; created_text: string };
const encode = (r: Row) => Buffer.from(JSON.stringify({ t: r.created_text, i: r.id })).toString("base64url");

/** New and claimed messages, oldest first, a page at a time. */
export async function listContact(db: Pick<pg.Pool, "query">, staff: string, opts: { after?: string } = {}) {
  const cursor = opts.after === undefined ? undefined : decodeReviewCursor(opts.after);
  await check(db, staff, false);
  const all = (cursor ? await db.query<Row>(CONTACT_AFTER, cursor) : await db.query<Row>(CONTACT_FIRST)).rows;
  const rows = all.slice(0, PAGE_SIZE);
  return { items: rows.map(camel), next: all.length > PAGE_SIZE ? encode(rows.at(-1)!) : null };
}

// ===== one message =====
export const CONTACT_ITEM =
  "select m.id, m.status, m.topic, m.surface, m.from_name, m.from_email, m.body, m.candidate_user_id, m.portal_user_id, m.claimed_by_staff_user_id, " +
  "m.created_at::text as created_text, m.claimed_at::text as claimed_text, m.closed_at::text as closed_text from contact_message m where m.id = $1::bigint";

/** One message in full, whatever its status; null when there is none. The read is logged (kind data_access). */
export async function getContact(db: Db, staff: string, id: string | number) {
  const key = String(id);
  return acting(db, staff, false, async (c, role) => {
    if (!validId(key)) return null;
    const r = (await c.query<Record<string, unknown> & { candidate_user_id: string | null }>(CONTACT_ITEM, [key])).rows[0];
    if (!r) return null;
    await audit(c, "data_access", staff, role, "read", key, r.candidate_user_id, {});
    return camel(r);
  });
}

// ===== the steps =====
// A claim goes stale after a working day, or at once when its holder is no longer active, so an absent staff member never blocks a message.
export const CONTACT_CLAIM =
  "update contact_message set status = 'claimed', claimed_by_staff_user_id = $2, claimed_at = now() where id = $1::bigint and (status = 'new' or " +
  "(status = 'claimed' and claimed_by_staff_user_id <> $2 and (claimed_at < now() - $3::interval or not exists (select 1 from staff_user u where u.id = claimed_by_staff_user_id and u.status = 'active')))) " +
  "returning candidate_user_id";
const STATE = "select status, claimed_by_staff_user_id from contact_message where id = $1::bigint";
export const CONTACT_DECIDE =
  "update contact_message set status = $2::text, closed_at = case when $2::text = 'closed' then now() else closed_at end " +
  "where id = $1::bigint and status = 'claimed' and claimed_by_staff_user_id = $3 returning candidate_user_id";

/** new to claimed by this person; a stale claim can be taken over. Claiming what you already hold is fine and writes nothing. */
export async function claimContact(db: Db, staff: string, id: string | number): Promise<void> {
  const key = String(id);
  await acting(db, staff, true, async (c, role) => {
    if (!validId(key)) throw new QueueRefused("not_found");
    const r = (await c.query<{ candidate_user_id: string | null }>(CONTACT_CLAIM, [key, staff, STALE_AFTER])).rows[0];
    if (r) return void (await audit(c, "admin_action", staff, role, "claim", key, r.candidate_user_id, { status: "claimed" }));
    const s = (await c.query<{ status: string; claimed_by_staff_user_id: string | null }>(STATE, [key])).rows[0];
    if (!s) throw new QueueRefused("not_found");
    if (s.status !== "claimed") throw new QueueRefused("already_decided");
    if (s.claimed_by_staff_user_id !== staff) throw new QueueRefused("claimed_by_other");
  });
}

/** claimed to answered, closed or spam, by the person who holds the claim. */
export async function decideContact(db: Db, staff: string, id: string | number, action: ContactAction): Promise<void> {
  const key = String(id);
  if (!Object.hasOwn(CONTACT_ACTIONS, action)) throw new QueueRefused("bad_action");
  const status = CONTACT_ACTIONS[action];
  await acting(db, staff, true, async (c, role) => {
    if (!validId(key)) throw new QueueRefused("not_found");
    const r = (await c.query<{ candidate_user_id: string | null }>(CONTACT_DECIDE, [key, status, staff])).rows[0];
    if (r) return void (await audit(c, "admin_action", staff, role, status, key, r.candidate_user_id, { status }));
    const s = (await c.query<{ status: string; claimed_by_staff_user_id: string | null }>(STATE, [key])).rows[0];
    if (!s) throw new QueueRefused("not_found");
    if (s.status === "new") throw new QueueRefused("not_claimed");
    if (s.status !== "claimed") throw new QueueRefused("already_decided");
    throw new QueueRefused("not_claimer");
  });
}
