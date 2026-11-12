// The admin side of the rules versions (#229, #230, #234 D9; migration 0021). Every active staff member reads the versions in force, the confirmed
// ones still to come and the pending proposals (20c: "view" for every role). A rules data editor proposes a new version of a kind with its date, or
// the big-company flag on one company; an administrator who did not propose confirms or refuses; the proposer may withdraw. The database stays the
// guard (approval_request_guard, approval_check's rules_version and organisation branches); the checks here only give short refusal codes first.
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import { cleanEmployerName } from "@portal/rules";
import { QueueRefused } from "./admin-queue";
import { FLOOR_ACT } from "./pay-floors";
import { validId } from "./search";
import { AUDIT } from "./trust-safety";
import { BadRulesData, cleanData, entriesOf, IN_FORCE, RULES_KINDS, validDate, type BigName, type VersionData, type RulesKind } from "./rules-data";

type Q = Pick<pg.Pool, "query">;
type Db = Pick<pg.Pool, "query" | "connect">;

const REQUEST_KIND: Record<RulesKind, string> = {
  minimums: "threshold", critical_skills_list: "critical_skills_list", ineligible_list: "ineligible_list",
  public_pay_employers: "public_pay_employer", big_company_names: "big_company_entry",
};
/** The rules data's own requests, and the big-company flag on one company (#230). */
const OURS = "((target_table = 'rules_version' and kind in ('threshold','critical_skills_list','ineligible_list','public_pay_employer','big_company_entry')) " +
  "or (target_table = 'organisation' and kind = 'big_company_entry'))";
export const isRulesKind = (k: unknown): k is RulesKind => typeof k === "string" && (RULES_KINDS as readonly string[]).includes(k);

type Need = "any" | "editor" | "administrator";
async function check(db: Q, staff: string, need: Need): Promise<void> {
  if (typeof staff !== "string" || staff.length === 0 || staff.length > 200) throw new QueueRefused("not_active_staff");
  const r = (await db.query<{ active: boolean; editor: boolean; administrator: boolean }>(FLOOR_ACT, [staff])).rows[0]!;
  if (!r.active) throw new QueueRefused("not_active_staff");
  if (need === "editor" && !r.editor) throw new QueueRefused("not_rules_editor");
  if (need === "administrator" && !r.administrator) throw new QueueRefused("not_administrator");
}

async function acting<T>(db: Db, staff: string, need: Need, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  if (typeof staff !== "string" || staff.length === 0 || staff.length > 200) throw new QueueRefused("not_active_staff");
  const c = await db.connect();
  try {
    await c.query("begin");
    await check(c, staff, need);
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
  c.query(AUDIT, [staff, `rules.${action}`, type, id, JSON.stringify(after), null, second, null]);

// ===== the change against the version in force =====
export type Change = { added: Record<string, unknown>; removed: Record<string, unknown>; changed: Record<string, { before: unknown; after: unknown }> };
export function diffVersion(kind: RulesKind, before: VersionData | null, after: VersionData): Change {
  const a = before === null ? new Map<string, unknown>() : entriesOf(kind, before), b = entriesOf(kind, after);
  const out: Change = { added: {}, removed: {}, changed: {} };
  for (const [k, v] of b) if (!a.has(k)) out.added[k] = v; else if (!isDeepStrictEqual(a.get(k), v)) out.changed[k] = { before: a.get(k), after: v };
  for (const [k, v] of a) if (!b.has(k)) out.removed[k] = v;
  return out;
}
const empty = (d: Change) => !Object.keys(d.added).length && !Object.keys(d.removed).length && !Object.keys(d.changed).length;

// ===== read =====
const TODAY_IN_FORCE = IN_FORCE.replace("$1::date", "current_date");
const UPCOMING = "select kind, data, id::text as id, effective_from::text as effective_from from rules_version where effective_from > current_date order by kind, effective_from, id";
export const PENDING =
  "select q.id::text as id, q.kind, q.target_table, q.target_id, q.change, q.proposed_by_staff_user_id as proposed_by, q.created_at::text as created_at, o.display_name " +
  "from approval_request q left join organisation o on q.target_table = 'organisation' and o.id::text = q.target_id where q.status = 'pending' " +
  "and ((q.target_table = 'rules_version' and q.kind in ('threshold','critical_skills_list','ineligible_list','public_pay_employer','big_company_entry')) " +
  "or (q.target_table = 'organisation' and q.kind = 'big_company_entry')) order by q.created_at, q.id";
type VersionRow = { kind: RulesKind; data: VersionData; id: string; effective_from: string };
export type Version = { kind: RulesKind; versionId: string; effectiveFrom: string; data: VersionData };
export type Pending =
  | { requestId: string; kind: RulesKind; effectiveFrom: string; proposedBy: string; createdAt: string; change: Change }
  | { requestId: string; kind: "big_company_flag"; organisationId: string; displayName: string | null; proposedBy: string; createdAt: string };
const version = (r: VersionRow): Version => ({ kind: r.kind, versionId: r.id, effectiveFrom: r.effective_from, data: r.data });

/** The versions in force today, the confirmed ones still to come, and the pending proposals with their change against the version in force. Any active staff member. */
export async function listRules(db: Q, staff: string): Promise<{ inForce: Version[]; upcoming: Version[]; pending: Pending[] }> {
  await check(db, staff, "any");
  const [now, later, pend] = await Promise.all([db.query<VersionRow>(TODAY_IN_FORCE), db.query<VersionRow>(UPCOMING), db.query(PENDING)]);
  const current = new Map(now.rows.map((r) => [r.kind, r.data]));
  const pending = pend.rows.map((r): Pending => {
    if (r.target_table === "organisation") return { requestId: r.id, kind: "big_company_flag", organisationId: r.target_id, displayName: r.display_name, proposedBy: r.proposed_by, createdAt: r.created_at };
    const kind = r.target_id as RulesKind;
    return { requestId: r.id, kind, effectiveFrom: r.change.effective_from, proposedBy: r.proposed_by, createdAt: r.created_at, change: diffVersion(kind, current.get(kind) ?? null, r.change.data) };
  });
  return { inForce: now.rows.map(version), upcoming: later.rows.map(version), pending };
}

// ===== propose =====
const CURRENT_OF = "select data, current_date::text as today from rules_version where kind = $1 and effective_from <= current_date order by effective_from desc, id desc limit 1";
const TODAY = "select current_date::text as today";
const PROPOSE = "insert into approval_request(kind, target_table, target_id, change, effective_from, reason) values ($1, $2, $3, $4::jsonb, $5::date, $6) returning id::text as id";

async function insertRequest(c: pg.PoolClient, args: unknown[]): Promise<string> {
  try {
    return (await c.query<{ id: string }>(PROPOSE, args)).rows[0]!.id;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new QueueRefused("decision_pending"); // one pending proposal per kind or company
    throw e;
  }
}

/**
 * A rules data editor proposes a new whole version of one kind, in force from `effectiveFrom` (today or later). The data is checked for its kind;
 * a big-company name that is new or changed needs its link, date read and next review date (#230). Refused when nothing changes.
 */
export async function proposeRules(db: Db, staff: string, input: { kind: unknown; effectiveFrom: unknown; data: unknown }): Promise<{ requestId: string; change: Change }> {
  if (!isRulesKind(input.kind)) throw new QueueRefused("bad_kind");
  if (!validDate(input.effectiveFrom)) throw new QueueRefused("bad_date");
  const kind = input.kind, from = input.effectiveFrom;
  let data: VersionData;
  try {
    data = cleanData(kind, input.data);
  } catch (e) {
    if (e instanceof BadRulesData) throw new QueueRefused("bad_data", e.message);
    throw e;
  }
  return acting(db, staff, "editor", async (c) => {
    const cur = (await c.query<{ data: VersionData; today: string }>(CURRENT_OF, [kind])).rows[0];
    const today = cur?.today ?? (await c.query<{ today: string }>(TODAY)).rows[0]!.today;
    if (from < today) throw new QueueRefused("date_in_past");
    const change = diffVersion(kind, cur?.data ?? null, data);
    if (empty(change)) throw new QueueRefused("no_change");
    if (kind === "big_company_names") {
      for (const e of [...Object.values(change.added), ...Object.values(change.changed).map((x) => x.after)] as BigName[]) {
        if (e.link === null || e.readOn === null || e.reviewOn === null) throw new QueueRefused("bad_data", `${e.name}: a new or changed name needs its link, date read and next review date`);
        if (cleanEmployerName(e.name) !== e.name) throw new QueueRefused("bad_data", `${e.name}: not a cleaned name`);
      }
    }
    const requestId = await insertRequest(c, [REQUEST_KIND[kind], "rules_version", kind, JSON.stringify({ data, effective_from: from }), from, "rules version"]);
    const counts = { added: Object.keys(change.added).length, removed: Object.keys(change.removed).length, changed: Object.keys(change.changed).length };
    await audit(c, staff, "propose", "rules_version", kind, { request_id: requestId, effective_from: from, ...counts });
    return { requestId, change };
  });
}

// The company's names (its display name and every name row), against the big-company names in force today, matched as isBigCompany matches.
const COMPANY =
  "select o.is_big_company, o.display_name, coalesce(array_agg(n.name) filter (where n.name is not null), '{}') as names " +
  "from organisation o left join organisation_name n on n.organisation_id = o.id where o.id = $1::bigint group by o.id";
const BIG_NAMES = "select data from rules_version where kind = 'big_company_names' and effective_from <= current_date order by effective_from desc, id desc limit 1";

async function companyMatches(c: pg.PoolClient, organisationId: string): Promise<boolean> {
  const o = (await c.query<{ is_big_company: boolean; display_name: string; names: string[] }>(COMPANY, [organisationId])).rows[0];
  if (!o) throw new QueueRefused("not_found");
  if (o.is_big_company) throw new QueueRefused("already_big");
  const big = ((await c.query<{ data: BigName[] }>(BIG_NAMES)).rows[0]?.data ?? []).map((e) => e.name);
  return [o.display_name, ...o.names].map(cleanEmployerName).some((n) => big.some((b) => n === b || n.startsWith(b + " ")));
}

/** A rules data editor proposes setting organisation.is_big_company on one company (#230): refused unless one of its names matches a name in force. */
export async function proposeBigFlag(db: Db, staff: string, organisationId: unknown): Promise<{ requestId: string }> {
  if (!validId(organisationId)) throw new QueueRefused("not_found");
  return acting(db, staff, "editor", async (c) => {
    if (!(await companyMatches(c, organisationId))) throw new QueueRefused("no_name_match");
    const requestId = await insertRequest(c, ["big_company_entry", "organisation", organisationId, JSON.stringify({ is_big_company: true }), null, "big company flag"]);
    await audit(c, staff, "propose_flag", "organisation", organisationId, { request_id: requestId });
    return { requestId };
  });
}

// ===== decide =====
const LOCK = `select id::text as id, kind, target_table, target_id, change, status, proposed_by_staff_user_id as proposed_by, current_date::text as today from approval_request where id = $1::bigint and ${OURS} for update`;
type Locked = { id: string; kind: string; target_table: string; target_id: string; change: { data?: VersionData; effective_from?: string } | null; status: string; proposed_by: string; today: string };

async function lockRequest(c: pg.PoolClient, requestId: unknown): Promise<Locked> {
  const r = validId(requestId) ? (await c.query<Locked>(LOCK, [requestId])).rows[0] : undefined;
  if (!r) throw new QueueRefused("not_found");
  if (r.status !== "pending") throw new QueueRefused("not_pending");
  return r;
}

const SET_STATUS = "update approval_request set status = $2 where id = $1::bigint and status = 'pending'";
const INSERT_VERSION =
  "insert into rules_version(kind, data, effective_from, approval_request_id) select target_id, change->'data', (change->>'effective_from')::date, id from approval_request " +
  "where id = $1::bigint returning id::text as id";
// #234 D9: one notice per company with a live or draft employer or agency job, to its account owner. A second confirm cannot repeat it (dedupe key).
export const NOTICES =
  "insert into email_outbox(template, portal_user_id, params, dedupe_key) " +
  "select 'rules_minimums_changed', m.portal_user_id, jsonb_build_object('organisationId', o.id, 'versionId', $1::bigint, 'effectiveFrom', $2::text), 'rules_minimums_changed:' || $1 || ':' || o.id " +
  "from organisation o join membership m on m.organisation_id = o.id and m.role = 'account_owner' and m.status = 'active' " +
  "where exists (select 1 from job j where j.organisation_id = o.id and j.source in ('employer','agency') and j.status in ('live','draft')) " +
  "on conflict (dedupe_key) do nothing";

/** An administrator who did not propose confirms: the version is written (or the company's flag set) in the same transaction. */
export async function confirmRules(db: Db, staff: string, requestId: unknown): Promise<{ versionId: string | null; notices: number }> {
  return acting(db, staff, "administrator", async (c) => {
    const r = await lockRequest(c, requestId);
    if (r.proposed_by === staff) throw new QueueRefused("same_person");
    if (r.target_table === "organisation") {
      if (!(await companyMatches(c, r.target_id))) throw new QueueRefused("no_name_match"); // the names may have changed since the proposal
      await c.query(SET_STATUS, [r.id, "confirmed"]);
      await c.query("update organisation set is_big_company = true where id = $1::bigint", [r.target_id]);
      await audit(c, staff, "confirm_flag", "organisation", r.target_id, { request_id: r.id }, r.proposed_by);
      return { versionId: null, notices: 0 };
    }
    if (r.change!.effective_from! < r.today) throw new QueueRefused("date_passed");
    await c.query(SET_STATUS, [r.id, "confirmed"]);
    const versionId = (await c.query<{ id: string }>(INSERT_VERSION, [r.id])).rows[0]!.id;
    const notices = r.target_id === "minimums" ? ((await c.query(NOTICES, [versionId, r.change!.effective_from])).rowCount ?? 0) : 0;
    await audit(c, staff, "confirm", "rules_version", versionId, { request_id: r.id, kind: r.target_id, effective_from: r.change!.effective_from, notices }, r.proposed_by);
    return { versionId, notices };
  });
}

/** An administrator who did not propose refuses the proposal. */
export async function refuseRules(db: Db, staff: string, requestId: unknown): Promise<void> {
  await acting(db, staff, "administrator", async (c) => {
    const r = await lockRequest(c, requestId);
    if (r.proposed_by === staff) throw new QueueRefused("same_person");
    await c.query(SET_STATUS, [r.id, "refused"]);
    await audit(c, staff, "refuse", r.target_table, r.target_id, { request_id: r.id }, r.proposed_by);
  });
}

/** The proposer withdraws their own pending proposal. */
export async function withdrawRules(db: Db, staff: string, requestId: unknown): Promise<void> {
  await acting(db, staff, "any", async (c) => {
    const r = await lockRequest(c, requestId);
    if (r.proposed_by !== staff) throw new QueueRefused("not_proposer");
    await c.query(SET_STATUS, [r.id, "withdrawn"]);
    await audit(c, staff, "withdraw", r.target_table, r.target_id, { request_id: r.id });
  });
}
