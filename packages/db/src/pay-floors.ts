// Employer-signed pay floors (#82, #100, #104). Portal side: a signer of a big-company employer signs a floor for a role family, lists the company's
// floors and withdraws one. Admin side: the pay_floor_check queue. A rules data editor proposes the `pay_floor` approval, an administrator (never the
// proposer) confirms it and the floor becomes active; either may reject it. The database stays the guard (pay_floor_insert, signer_check, pay_floor_guard,
// approval_check, approval_request_guard); the checks here only give short refusal codes first. 0023 adds the four-digit family check and drops a withdrawn floor's queue item.
import type pg from "pg";
import { isSoc2010 } from "@portal/rules";
import { QueueRefused } from "./admin-queue";
import { decodeReviewCursor, REASON } from "./account-review";
import { PAGE_SIZE, validId } from "./search";
import { AUDIT } from "./trust-safety";

type Q = Pick<pg.Pool, "query">;
type Db = Pick<pg.Pool, "query" | "connect">;

// ===== the portal side =====
export const FLOOR_MONTHS = 12; // #82
export const MAX_FLOOR_EUR = 1_000_000;
export const MAX_FLOORS_SHOWN = 200;

/** A refusal the portal route turns into a status. The code is upper case, like the other portal routes'. */
export class FloorRefused extends Error {}

/** The signed-in member who signs or withdraws: always from the session (requirePortal), never from a body. */
export type FloorMember = { membershipId: number; organisationId: number; role: string };
const TITLE: Record<string, string> = { account_owner: "Account owner", poster: "Poster", recruiter: "Recruiter" };

/** The role family is a SOC 2010 occupation code (#231, and pay_floor_role_family_check in 0023). Null for anything else; the portal route also refuses an Ineligible code. */
export function cleanFamily(s: unknown): string | null {
  return isSoc2010(s) ? s : null;
}

const CURRENT_TEXT = "select id::text as id, version, body from consent_text where purpose = 'pay_floor' order by published_at desc, id desc limit 1";
export type FloorText = { id: string; version: string; body: string };
export const currentFloorText = async (db: Q): Promise<FloorText | null> => (await db.query<FloorText>(CURRENT_TEXT)).rows[0] ?? null;

// The signer's name comes from the membership's own login, in the same statement; the signer trigger checks the rest.
const INSERT_FLOOR =
  "insert into pay_floor(organisation_id, role_family, floor_eur, consent_text_id, signer_membership_id, signer_name, signer_title, valid_until) " +
  "select $1::bigint, $2, $3::int, $4::bigint, m.id, u.name, $5, now() + make_interval(months => $6::int) " +
  "from membership m join portal_user u on u.id = m.portal_user_id where m.id = $7::bigint and m.organisation_id = $1::bigint returning id::text as id, valid_until::text as valid_until";

/**
 * Signs a pay floor for the member's own company. The text must be the current pay_floor wording (the signer saw it), the floor a whole euro amount from 1 to
 * 1,000,000. The database refuses an agency, an employer not on the big-company list and a member who may not sign. Starts `pending_check` and queues the staff check.
 */
export async function createPayFloor(db: Q, who: FloorMember, input: { roleFamily: string; floorEur: number; consentTextId: string }): Promise<{ id: string; validUntil: string }> {
  const family = cleanFamily(input.roleFamily);
  if (family === null || !Number.isInteger(input.floorEur) || input.floorEur < 1 || input.floorEur > MAX_FLOOR_EUR || !validId(input.consentTextId)) throw new FloorRefused("BAD_REQUEST");
  const text = await currentFloorText(db);
  if (text === null) throw new FloorRefused("NO_CONSENT_TEXT");
  if (text.id !== input.consentTextId) throw new FloorRefused("TEXT_CHANGED");
  try {
    const r = (await db.query<{ id: string; valid_until: string }>(INSERT_FLOOR, [who.organisationId, family, input.floorEur, text.id, TITLE[who.role] ?? null, FLOOR_MONTHS, who.membershipId])).rows[0];
    if (!r) throw new FloorRefused("REFUSED");
    return { id: r.id, validUntil: r.valid_until };
  } catch (e) {
    const { code, message = "", constraint } = (e ?? {}) as { code?: string; message?: string; constraint?: string };
    if (code === "23505" && constraint === "pay_floor_one_pending") throw new FloorRefused("ALREADY_PENDING");
    if (code === "P0001" && message.includes("big-company")) throw new FloorRefused("NOT_BIG_COMPANY");
    if (code === "P0001" && message.includes("signer refused")) throw new FloorRefused("NOT_SIGNER");
    throw e;
  }
}

// Same people as signer_check: an active poster or recruiter with the signer switch, or the account owner, of the floor's own company.
const WITHDRAW =
  "update pay_floor set status = 'withdrawn' where id = $1::bigint and organisation_id = $2::bigint and status in ('pending_check','active') and exists " +
  "(select 1 from membership m where m.id = $3::bigint and m.organisation_id = $2::bigint and m.status = 'active' and ((m.is_signer and m.role in ('poster','recruiter')) or m.role = 'account_owner'))";
const WHY_NOT = "select f.status, exists (select 1 from membership m where m.id = $3::bigint and m.organisation_id = $2::bigint and m.status = 'active' and ((m.is_signer and m.role in ('poster','recruiter')) or m.role = 'account_owner')) as signer " +
  "from pay_floor f where f.id = $1::bigint and f.organisation_id = $2::bigint";

/** Withdraws a pending or active floor of the member's own company. Another company's floor is NOT_FOUND, whoever asks. */
export async function withdrawPayFloor(db: Q, who: FloorMember, floorId: string): Promise<void> {
  if (!validId(floorId)) throw new FloorRefused("BAD_REQUEST");
  const args = [floorId, who.organisationId, who.membershipId];
  if ((await db.query(WITHDRAW, args)).rowCount === 1) return;
  const f = (await db.query<{ status: string; signer: boolean }>(WHY_NOT, args)).rows[0];
  if (!f) throw new FloorRefused("NOT_FOUND");
  throw new FloorRefused(!f.signer ? "NOT_SIGNER" : "NOT_WITHDRAWABLE");
}

const OWN_FLOORS =
  "select id::text as id, role_family, floor_eur, status, signed_at::text as signed_at, valid_until::text as valid_until, ended_at::text as ended_at, signer_name, signer_title " +
  `from pay_floor where organisation_id = $1::bigint order by id desc limit ${MAX_FLOORS_SHOWN}`;
export type OwnFloor = { id: string; roleFamily: string; floorEur: number; status: string; signedAt: string; validUntil: string; endedAt: string | null; signerName: string | null; signerTitle: string | null };

/** The company's own floors, newest first (at most 200), and the wording a new floor would sign. Every active member may read. */
export async function listPayFloors(db: Q, organisationId: number): Promise<{ text: FloorText | null; floors: OwnFloor[] }> {
  const [text, rows] = await Promise.all([currentFloorText(db), db.query(OWN_FLOORS, [organisationId])]);
  return {
    text,
    floors: rows.rows.map((r) => ({ id: r.id, roleFamily: r.role_family, floorEur: r.floor_eur, status: r.status, signedAt: r.signed_at, validUntil: r.valid_until, endedAt: r.ended_at, signerName: r.signer_name, signerTitle: r.signer_title })),
  };
}

// ===== the admin side: the pay_floor_check queue =====
// Matrix 20c ("Employer-declared pay floors"): the rules data editor edits, the administrator approves. Neither role stands in for the other,
// except that either may look and reject.
export const FLOOR_ACT =
  "select set_config('app.staff_user_id', $1, true), exists (select 1 from staff_user where id = $1 and status = 'active') as active, " +
  "exists (select 1 from staff_user u join staff_role r on r.staff_user_id = u.id where u.id = $1 and u.status = 'active' and r.role = 'rules_data_editor') as editor, " +
  "exists (select 1 from staff_user u join staff_role r on r.staff_user_id = u.id where u.id = $1 and u.status = 'active' and r.role = 'administrator') as administrator";
type Need = "editor" | "administrator" | "either";
const CODE: Record<Need, string> = { editor: "not_rules_editor", administrator: "not_administrator", either: "not_floor_staff" };

async function check(db: Q, staff: string, need: Need): Promise<void> {
  if (typeof staff !== "string" || staff.length === 0 || staff.length > 200) throw new QueueRefused("not_active_staff");
  const r = (await db.query<{ active: boolean; editor: boolean; administrator: boolean }>(FLOOR_ACT, [staff])).rows[0]!;
  if (!r.active) throw new QueueRefused("not_active_staff");
  if (!(need === "either" ? r.editor || r.administrator : r[need])) throw new QueueRefused(CODE[need]);
}

const COLS =
  "r.id as item_id, r.created_at::text as created_text, f.id::text as floor_id, f.role_family, f.floor_eur, f.signed_at::text as signed_at, f.valid_until::text as valid_until, " +
  "f.signer_name, f.signer_title, o.id::text as organisation_id, o.display_name, o.kind, o.is_big_company, o.status as organisation_status, " +
  "(select a.floor_eur from pay_floor a where a.organisation_id = f.organisation_id and a.role_family = f.role_family and a.status = 'active') as current_floor_eur, " +
  "q.id::text as request_id, q.proposed_by_staff_user_id as proposed_by " +
  "from review_item r join pay_floor f on f.id = r.pay_floor_id join organisation o on o.id = f.organisation_id " +
  "left join approval_request q on q.kind = 'pay_floor' and q.target_table = 'pay_floor' and q.target_id = f.id::text and q.status = 'pending' ";
// Open items on a floor still waiting for its check, oldest first on review_item_queue_idx. A floor the employer withdrew leaves its item behind; it is not listed.
const OPEN = "r.queue = 'pay_floor_check' and r.status in ('open','claimed') and f.status = 'pending_check'";
export const FLOOR_FIRST = `select ${COLS}where ${OPEN} order by r.created_at, r.id limit ${PAGE_SIZE + 1}`;
export const FLOOR_AFTER = `select ${COLS}where ${OPEN} and (r.created_at, r.id) > ($1::timestamptz, $2::bigint) order by r.created_at, r.id limit ${PAGE_SIZE + 1}`;
export const FLOOR_ONE = `select ${COLS}where r.queue = 'pay_floor_check' and f.id = $1::bigint order by r.id desc limit 1`;

type Row = {
  item_id: string; created_text: string; floor_id: string; role_family: string; floor_eur: number; signed_at: string; valid_until: string; signer_name: string | null; signer_title: string | null;
  organisation_id: string; display_name: string; kind: string; is_big_company: boolean; organisation_status: string; current_floor_eur: number | null; request_id: string | null; proposed_by: string | null;
};
export type FloorCheck = {
  floorId: string; itemId: string; createdAt: string; roleFamily: string; floorEur: number; signedAt: string; validUntil: string; signerName: string | null; signerTitle: string | null;
  organisationId: string; displayName: string; kind: string; isBigCompany: boolean; organisationStatus: string;
  /** The amount of the floor now active for the same role family, which this one would replace; null when none. */
  currentFloorEur: number | null;
  /** The pending pay_floor approval, when an editor has proposed; `proposedBy` is that editor's staff id. */
  requestId: string | null; proposedBy: string | null;
};
const view = (r: Row): FloorCheck => ({
  floorId: r.floor_id, itemId: r.item_id, createdAt: r.created_text, roleFamily: r.role_family, floorEur: r.floor_eur, signedAt: r.signed_at, validUntil: r.valid_until,
  signerName: r.signer_name, signerTitle: r.signer_title, organisationId: r.organisation_id, displayName: r.display_name, kind: r.kind, isBigCompany: r.is_big_company,
  organisationStatus: r.organisation_status, currentFloorEur: r.current_floor_eur, requestId: r.request_id, proposedBy: r.proposed_by,
});
const encode = (r: Row) => Buffer.from(JSON.stringify({ t: r.created_text, i: r.item_id })).toString("base64url");

/** Floors waiting for their check, oldest first, a page at a time. Rules data editors and administrators. */
export async function listFloorChecks(db: Q, staff: string, opts: { after?: string } = {}): Promise<{ items: FloorCheck[]; next: string | null }> {
  const cursor = opts.after === undefined ? undefined : decodeReviewCursor(opts.after);
  await check(db, staff, "either");
  const all = (cursor ? await db.query<Row>(FLOOR_AFTER, cursor) : await db.query<Row>(FLOOR_FIRST)).rows;
  const rows = all.slice(0, PAGE_SIZE);
  return { items: rows.map(view), next: all.length > PAGE_SIZE ? encode(rows.at(-1)!) : null };
}

/** One floor's check item, whatever its state. null when the floor has no pay_floor_check item. */
export async function getFloorCheck(db: Q, staff: string, floorId: string | number): Promise<FloorCheck | null> {
  await check(db, staff, "either");
  const key = String(floorId);
  if (!validId(key)) return null;
  const r = (await db.query<Row>(FLOOR_ONE, [key])).rows[0];
  return r ? view(r) : null;
}

async function acting<T>(db: Db, staff: string, floorId: string | number, need: Need, fn: (c: pg.PoolClient, id: string) => Promise<T>): Promise<T> {
  if (typeof staff !== "string" || staff.length === 0 || staff.length > 200) throw new QueueRefused("not_active_staff");
  const key = String(floorId);
  if (!validId(key)) throw new QueueRefused("not_found");
  const c = await db.connect();
  try {
    await c.query("begin");
    await check(c, staff, need);
    const out = await fn(c, key);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// The floor and its company, locked, so two staff cannot decide it at once.
const LOCK =
  "select f.status, f.organisation_id::text as organisation_id, f.role_family, f.valid_until <= now() as expired, o.kind = 'employer' and o.is_big_company as big, " +
  "o.status in ('verified','verified_restricted') as active_company from pay_floor f join organisation o on o.id = f.organisation_id where f.id = $1::bigint for update of f";
const PENDING = "select id::text as id, proposed_by_staff_user_id as proposed_by from approval_request where kind = 'pay_floor' and target_table = 'pay_floor' and target_id = $1 and status = 'pending' for update";
type Locked = { status: string; organisation_id: string; role_family: string; expired: boolean; big: boolean; active_company: boolean };

async function lock(c: pg.PoolClient, id: string, forActivation: boolean): Promise<Locked> {
  const f = (await c.query<Locked>(LOCK, [id])).rows[0];
  if (!f) throw new QueueRefused("not_found");
  if (f.status !== "pending_check") throw new QueueRefused("floor_not_pending");
  if (forActivation) {
    if (f.expired) throw new QueueRefused("floor_expired");
    if (!f.big) throw new QueueRefused("not_big_company"); // the list can change after the floor was signed (#100)
    if (!f.active_company) throw new QueueRefused("organisation_not_active");
  }
  return f;
}

const audit = (c: pg.PoolClient, staff: string, action: string, id: string, after: object, reason: string | null = null, second: string | null = null) =>
  c.query(AUDIT, [staff, `pay_floor.${action}`, "pay_floor", id, JSON.stringify(after), reason, second, null]);
const PROPOSE = "insert into approval_request(kind, target_table, target_id, change, reason) values ('pay_floor', 'pay_floor', $1, $2::jsonb, 'floor check') returning id::text as id";
// The queue item closes and (N5), in the same statement, the company's active owner and the member who signed the floor (one notice when they are the
// same person; none for a member who has left) get one portal notice and one queued email: $4 the template, $5 the params (floorNotice: ids and the reason code).
const ITEM_DONE =
  "with i as (update review_item set status = 'done', decided_by_staff_user_id = $2, decided_at = now(), outcome = $3 where queue = 'pay_floor_check' and pay_floor_id = $1::bigint and status in ('open','claimed')), " +
  "u as (select distinct m.portal_user_id as p, f.organisation_id as org from pay_floor f join membership m on m.organisation_id = f.organisation_id and m.status = 'active' " +
  "and (m.role = 'account_owner' or m.id = f.signer_membership_id) where f.id = $1::bigint), " +
  "n as (insert into notification(portal_user_id, organisation_id, category, template_key, params) select p, org, 'account', $4::text, $5::jsonb from u) " +
  "insert into email_outbox(template, portal_user_id, params) select $4::text, p, $5::jsonb from u";

/** N5: the template and params of the floor decision notice. Ids, and the reason code on a reject; nothing else from staff. */
export function floorNotice(outcome: "approved" | "rejected", floorId: string, organisationId: string, reason?: string): { template: string; params: Record<string, string> } {
  const params: Record<string, string> = { organisationId, floorId };
  if (outcome === "rejected" && reason !== undefined) params.reason = reason;
  return { template: `pay_floor_${outcome}`, params };
}
const itemDone = (c: pg.PoolClient, id: string, staff: string, outcome: string, n: ReturnType<typeof floorNotice>) =>
  c.query(ITEM_DONE, [id, staff, outcome, n.template, JSON.stringify(n.params)]);

/** A rules data editor checks the floor against the advert evidence and proposes the pay_floor approval. The floor stays pending_check until an administrator confirms. */
export async function proposeFloor(db: Db, staff: string, floorId: string | number): Promise<{ requestId: string }> {
  return acting(db, staff, floorId, "editor", async (c, id) => {
    const f = await lock(c, id, true);
    if ((await c.query(PENDING, [id])).rowCount) throw new QueueRefused("decision_pending");
    const req = (await c.query<{ id: string }>(PROPOSE, [id, JSON.stringify({ role_family: f.role_family })])).rows[0]!;
    await audit(c, staff, "propose", id, { request_id: req.id });
    return { requestId: req.id };
  });
}

const CONFIRM = "update approval_request set status = 'confirmed' where id = $1::bigint and status = 'pending'";
const REPLACE = "update pay_floor set status = 'replaced' where organisation_id = $1::bigint and role_family = $2 and status = 'active' returning id::text as id";
const ACTIVATE =
  "update pay_floor set status = 'active', approval_request_id = $2::bigint, checked_by_staff_id = $3, checked_at = now(), replaces_id = $4::bigint where id = $1::bigint and status = 'pending_check'";

/**
 * An administrator who did not propose confirms the pending approval: the floor becomes active in the same transaction (the approval trigger uses the
 * request once), and an active floor of the same role family is set to replaced first (#82: signing again before expiry).
 */
export async function confirmFloor(db: Db, staff: string, floorId: string | number): Promise<{ floorId: string; replacedId: string | null }> {
  return acting(db, staff, floorId, "administrator", async (c, id) => {
    const f = await lock(c, id, true);
    const req = (await c.query<{ id: string; proposed_by: string }>(PENDING, [id])).rows[0];
    if (!req) throw new QueueRefused("nothing_pending");
    if (req.proposed_by === staff) throw new QueueRefused("same_person");
    await c.query(CONFIRM, [req.id]);
    const old = (await c.query<{ id: string }>(REPLACE, [f.organisation_id, f.role_family])).rows[0]?.id ?? null;
    if ((await c.query(ACTIVATE, [id, req.id, staff, old])).rowCount !== 1) throw new Error("the floor was not activated"); // rolls back; the lock above makes this unreachable
    await itemDone(c, id, staff, "accepted", floorNotice("approved", id, f.organisation_id));
    await audit(c, staff, "confirm", id, { status: "active", request_id: req.id, replaced: old }, null, req.proposed_by);
    return { floorId: id, replacedId: old };
  });
}

const REFUSE_REQ = "update approval_request set status = case when proposed_by_staff_user_id = $2 then 'withdrawn' else 'refused' end where id = $1::bigint";
const REJECT = "update pay_floor set status = 'rejected', checked_by_staff_id = $2, checked_at = now() where id = $1::bigint and status = 'pending_check'";

/** Ends the floor (`rejected`): a rules data editor or an administrator, with a reason code. A pending approval is refused (or withdrawn, if the rejecter proposed it). */
export async function rejectFloor(db: Db, staff: string, floorId: string | number, reason: string): Promise<void> {
  if (typeof reason !== "string" || !REASON.test(reason)) throw new QueueRefused("bad_reason");
  await acting(db, staff, floorId, "either", async (c, id) => {
    const f = await lock(c, id, false);
    const req = (await c.query<{ id: string }>(PENDING, [id])).rows[0];
    if (req) await c.query(REFUSE_REQ, [req.id, staff]);
    if ((await c.query(REJECT, [id, staff])).rowCount !== 1) throw new Error("the floor was not rejected");
    await itemDone(c, id, staff, "rejected", floorNotice("rejected", id, f.organisation_id, reason));
    await audit(c, staff, "reject", id, { status: "rejected", request_id: req?.id ?? null }, reason);
  });
}
