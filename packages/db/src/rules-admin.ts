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
import { BadRulesData, cleanData, entriesOf, IN_FORCE, RULES_KINDS, validDate, type BigName, type Minimums, type PayDealEntry, type PayDealList, type VersionData, type RulesKind } from "./rules-data";
import { decodeIdCursor, encodeIdCursor } from "./wire";

type Q = Pick<pg.Pool, "query">;
type Db = Pick<pg.Pool, "query" | "connect">;

const REQUEST_KIND: Record<RulesKind, string> = {
  minimums: "threshold", critical_skills_list: "critical_skills_list", ineligible_list: "ineligible_list",
  public_pay_employers: "public_pay_employer", big_company_names: "big_company_entry", pay_scales: "pay_scales",
};
/** The rules data's own requests, and the big-company flag on one company (#230). */
const OURS = "((target_table = 'rules_version' and kind in ('threshold','critical_skills_list','ineligible_list','public_pay_employer','big_company_entry','pay_scales')) " +
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
// role_in_force: the role that allowed the action (SV-A, 20 Nov: no rules row had set it since 11 Nov). A proposal and its withdrawal are the rules
// data editor's (the proposer's), a confirm or refuse the administrator's.
export const RULES_ROLE: Record<string, "rules_data_editor" | "administrator"> = {
  propose: "rules_data_editor", propose_flag: "rules_data_editor", withdraw: "rules_data_editor",
  confirm: "administrator", confirm_flag: "administrator", refuse: "administrator",
};
const RULES_AUDIT = "insert into audit_event(kind, actor_staff_user_id, role_in_force, action, object_type, object_id, after, second_staff_user_id, source) " +
  "values ('admin_action', $1, $2, $3, $4, $5, $6::jsonb, $7, 'panel')";
const audit = (c: pg.PoolClient, staff: string, action: keyof typeof RULES_ROLE, type: string, id: string, after: object, second: string | null = null) =>
  c.query(RULES_AUDIT, [staff, RULES_ROLE[action], `rules.${action}`, type, id, JSON.stringify(after), second]);

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
  "select q.id::text as id, q.kind, q.target_table, q.target_id, q.change, q.proposed_by_staff_user_id as proposed_by, u.name as proposed_by_name, q.created_at::text as created_at, o.display_name " +
  "from approval_request q left join staff_user u on u.id = q.proposed_by_staff_user_id left join organisation o on q.target_table = 'organisation' and o.id::text = q.target_id where q.status = 'pending' " +
  "and ((q.target_table = 'rules_version' and q.kind in ('threshold','critical_skills_list','ineligible_list','public_pay_employer','big_company_entry','pay_scales')) " +
  "or (q.target_table = 'organisation' and q.kind = 'big_company_entry')) order by q.created_at, q.id";
type VersionRow = { kind: RulesKind; data: VersionData; id: string; effective_from: string };
export type Version = { kind: RulesKind; versionId: string; effectiveFrom: string; data: VersionData; hourly?: Record<string, number> };
export type Pending =
  | { requestId: string; kind: RulesKind; effectiveFrom: string; proposedBy: string; proposedByName: string; createdAt: string; change: Change }
  | { requestId: string; kind: "big_company_flag"; organisationId: string; displayName: string | null; proposedBy: string; proposedByName: string; createdAt: string };
const HOURLY = ["criticalSkills", "graduate", "nonList", "general", "generalLower"] as const;
/** B64: each yearly minimum as euro an hour, to the cent, over 52 weeks of the standard week (32,691 at 39 hours is 16.12). Pure. */
export const hourlyOf = (m: Minimums): Record<string, number> =>
  Object.fromEntries(HOURLY.flatMap((k) => (m[k] === undefined ? [] : [[k, Math.round((m[k]! * 100) / (52 * m.standardWeekHours)) / 100]])));
const version = (r: VersionRow): Version => ({ kind: r.kind, versionId: r.id, effectiveFrom: r.effective_from, data: r.data,
  ...(r.kind === "minimums" ? { hourly: hourlyOf(r.data as Minimums) } : {}) });

/** The versions in force today, the confirmed ones still to come, and the pending proposals with their change against the version in force. Any active staff member. */
export async function listRules(db: Q, staff: string): Promise<{ inForce: Version[]; upcoming: Version[]; pending: Pending[] }> {
  await check(db, staff, "any");
  const [now, later, pend] = await Promise.all([db.query<VersionRow>(TODAY_IN_FORCE), db.query<VersionRow>(UPCOMING), db.query(PENDING)]);
  const current = new Map(now.rows.map((r) => [r.kind, r.data]));
  const pending = pend.rows.map((r): Pending => {
    if (r.target_table === "organisation") return { requestId: r.id, kind: "big_company_flag", organisationId: r.target_id, displayName: r.display_name, proposedBy: r.proposed_by, proposedByName: r.proposed_by_name, createdAt: r.created_at };
    const kind = r.target_id as RulesKind;
    return { requestId: r.id, kind, effectiveFrom: r.change.effective_from, proposedBy: r.proposed_by, proposedByName: r.proposed_by_name, createdAt: r.created_at, change: diffVersion(kind, current.get(kind) ?? null, r.change.data) };
  });
  return { inForce: now.rows.map(version), upcoming: later.rows.map(version), pending };
}

// ===== B64: the versions of one kind that have started, newest first (the first is the one in force), each with its change against the one before it =====
export const HISTORY_PAGE = 10; // whole lists are read to make the change (the Ineligible list is about 35 kB), so the page is short
export const HISTORY =
  "select v.id::text as id, v.effective_from::text as effective_from, v.data, v.seeded_by_owner, q.proposed_by_staff_user_id as proposed_by, p.name as proposed_by_name, " +
  "c.name as confirmed_by_name, q.decided_at::text as confirmed_at, (select n.effective_from::text from rules_version n where n.kind = v.kind and n.effective_from <= current_date " +
  "and (n.effective_from, n.id) > (v.effective_from, v.id) order by n.effective_from, n.id limit 1) as until " +
  "from rules_version v left join approval_request q on q.id = v.approval_request_id left join staff_user p on p.id = q.proposed_by_staff_user_id " +
  "left join staff_user c on c.id = q.confirmed_by_staff_user_id where v.kind = $1 and v.effective_from <= current_date " +
  "and ($2::bigint is null or (v.effective_from, v.id) < (select a.effective_from, a.id from rules_version a where a.id = $2::bigint and a.kind = $1)) " +
  `order by v.effective_from desc, v.id desc limit ${HISTORY_PAGE + 1}`;
export type PastVersion = {
  versionId: string; effectiveFrom: string; until: string | null; inForce: boolean; seeded: boolean; proposedBy: string | null; proposedByName: string | null;
  confirmedByName: string | null; confirmedAt: string | null; change: Change;
};

/** The started versions of one kind, a page of HISTORY_PAGE; `after` is the `next` of the page before. The first version's change is every entry added. Any active staff member. */
export async function listRulesHistory(db: Q, staff: string, opts: { kind?: unknown; after?: string }): Promise<{ kind: RulesKind; items: PastVersion[]; next: string | null }> {
  if (!isRulesKind(opts.kind)) throw new QueueRefused("bad_kind");
  const kind = opts.kind, after = opts.after === undefined ? null : decodeIdCursor("rules_history", opts.after);
  await check(db, staff, "any");
  const all = (await db.query(HISTORY, [kind, after])).rows;
  const items = all.slice(0, HISTORY_PAGE).map((r, i): PastVersion => ({
    versionId: r.id, effectiveFrom: r.effective_from, until: r.until, inForce: r.until === null, seeded: r.seeded_by_owner, proposedBy: r.proposed_by,
    proposedByName: r.proposed_by_name, confirmedByName: r.confirmed_by_name, confirmedAt: r.confirmed_at, change: diffVersion(kind, all[i + 1]?.data ?? null, r.data),
  }));
  return { kind, items, next: all.length > HISTORY_PAGE ? encodeIdCursor("rules_history", items.at(-1)!.versionId) : null };
}

// ===== B66: the pay-deal list in force, entry by entry =====
// Each entry's companies are matched as the badge matches them (public-pages.ts): by display name or any name row, lower case; the HSE entry by the HSE name test
// (public-pay.ts). Then those companies' name rows and live jobs. ponytail: reads every company name (the staff page only); an index on lower(name) if it passes 100,000 rows.
export const PAY_DEAL_COUNTS =
  "with n as (select id as org, display_name as name from organisation where merged_into_id is null union all select organisation_id, name from organisation_name), " +
  "m as (select e.entry, n.org from unnest($1::text[]) e(entry) join n on lower(btrim(n.name)) = e.entry " +
  "union select 'health service executive', n.org from n where 'health service executive' = any($1::text[]) and n.name ~* '\\mhse\\M|health service executive') " +
  "select m.entry, count(*)::int as companies, sum((select count(*) from organisation_name x where x.organisation_id = m.org and x.kind = 'legal'))::int as legal_names, " +
  "sum((select count(*) from job j where j.organisation_id = m.org and j.status = 'live'))::int as live_jobs from m group by m.entry";
const STAFF_NAMES = "select id, name from staff_user where id = any($1::text[])";
export type PayDealRow = {
  name: string; tier: 1 | 2; note: string | null; bodyType: string | null; evidence: PayDealEntry["evidence"] | null; addedOn: string | null; addedBy: string | null;
  addedByName: string | null; on: boolean; companies: number; legalNames: number; liveJobs: number;
};

/** The public pay-deal employers in force (on and off), by name, with their counts. Any active staff member. */
export async function listPayDealEmployers(db: Q, staff: string): Promise<{ versionId: string; effectiveFrom: string; items: PayDealRow[] } | { versionId: null; effectiveFrom: null; items: [] }> {
  await check(db, staff, "any");
  const v = (await db.query<{ id: string; effective_from: string; data: PayDealList }>(CURRENT_OF, ["public_pay_employers"])).rows[0];
  if (!v) return { versionId: null, effectiveFrom: null, items: [] };
  const entries = Object.entries(v.data).sort(([a], [b]) => (a < b ? -1 : 1));
  const [counts, people] = await Promise.all([
    db.query<{ entry: string; companies: number; legal_names: number; live_jobs: number }>(PAY_DEAL_COUNTS, [entries.map(([n]) => n)]),
    db.query<{ id: string; name: string }>(STAFF_NAMES, [[...new Set(entries.flatMap(([, e]) => e.addedBy ?? []))]]),
  ]);
  const count = new Map(counts.rows.map((r) => [r.entry, r])), who = new Map(people.rows.map((r) => [r.id, r.name]));
  return { versionId: v.id, effectiveFrom: v.effective_from, items: entries.map(([name, e]) => ({
    name, tier: e.tier, note: e.note ?? null, bodyType: e.bodyType ?? null, evidence: e.evidence ?? null, addedOn: e.addedOn ?? null, addedBy: e.addedBy ?? null,
    addedByName: who.get(e.addedBy ?? "") ?? null, on: e.on !== false, companies: count.get(name)?.companies ?? 0, legalNames: count.get(name)?.legal_names ?? 0,
    liveJobs: count.get(name)?.live_jobs ?? 0,
  })) };
}

// ===== propose =====
const CURRENT_OF = "select id::text as id, effective_from::text as effective_from, data, current_date::text as today from rules_version where kind = $1 and effective_from <= current_date order by effective_from desc, id desc limit 1";
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

// B66: who uploaded what (staff-uploads.ts writes the row with the file): the one place an uploaded file's name comes from
const UPLOADED = "select object_id as id, after->>'file_name' as name from audit_event where object_type = 'rules_evidence' and object_id = any($1::text[]) and action = 'rules.evidence_upload'";

/**
 * B66: the pay-deal entries as they will be saved, whatever the sender put in them: an entry already on the list keeps its date added and added by, a new one gets today
 * and the proposer; an evidence file must be an uploaded one, and takes the name it was uploaded with.
 */
async function payDealEntries(c: pg.PoolClient, staff: string, today: string, current: VersionData | null, list: PayDealList): Promise<PayDealList> {
  const before = new Map(Object.entries((current ?? {}) as PayDealList));
  const ids = Object.values(list).flatMap((e) => e.evidence?.file?.id ?? []);
  const uploaded = new Map(ids.length ? (await c.query<{ id: string; name: string }>(UPLOADED, [ids])).rows.map((r) => [r.id, r.name]) : []);
  return Object.fromEntries(Object.entries(list).map(([name, sent]) => {
    const e = { ...sent }, was = before.get(name), file = e.evidence?.file;
    if (e.evidence && file) {
      const label = was?.evidence?.file?.id === file.id ? was.evidence.file.name : uploaded.get(file.id);
      if (label === undefined) throw new QueueRefused("bad_data", `${name}: the evidence file is not an uploaded file`);
      e.evidence = { ...e.evidence, file: { id: file.id, name: label } };
    }
    delete e.addedOn;
    delete e.addedBy;
    const added = was ? { ...(was.addedOn ? { addedOn: was.addedOn } : {}), ...(was.addedBy ? { addedBy: was.addedBy } : {}) } : { addedOn: today, addedBy: staff };
    return [name, { ...e, ...added }];
  }));
}

/**
 * A rules data editor proposes a new whole version of one kind, in force from `effectiveFrom` (today or later). The data is checked for its kind;
 * a big-company name that is new or changed needs its link, date read and next review date (#230); a pay-deal entry that is new or changed and on needs its
 * body type and evidence (#67, B66). Refused when nothing changes.
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
    if (kind === "public_pay_employers") data = await payDealEntries(c, staff, today, cur?.data ?? null, data as PayDealList);
    const change = diffVersion(kind, cur?.data ?? null, data);
    if (empty(change)) throw new QueueRefused("no_change");
    if (kind === "big_company_names") {
      for (const e of [...Object.values(change.added), ...Object.values(change.changed).map((x) => x.after)] as BigName[]) {
        if (e.link === null || e.readOn === null || e.reviewOn === null) throw new QueueRefused("bad_data", `${e.name}: a new or changed name needs its link, date read and next review date`);
        if (cleanEmployerName(e.name) !== e.name) throw new QueueRefused("bad_data", `${e.name}: not a cleaned name`);
      }
    }
    if (kind === "public_pay_employers") {
      for (const [name, e] of [...Object.entries(change.added), ...Object.entries(change.changed).map(([k, x]) => [k, x.after])] as [string, PayDealEntry][])
        if (e.on !== false && (!e.bodyType || !e.evidence)) throw new QueueRefused("bad_data", `${name}: a new or changed entry that is on needs its body type and evidence`);
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
// #234 D9, #93: one email and one portal notice per company with a live or draft employer or agency job, to its account owner, in one statement.
// A second confirm cannot repeat either (dedupe key). Returns the emails queued. The notice holds this company's id only.
export const NOTICES =
  "with t as (select o.id as org, m.portal_user_id as u from organisation o join membership m on m.organisation_id = o.id and m.role = 'account_owner' and m.status = 'active' " +
  "where exists (select 1 from job j where j.organisation_id = o.id and j.source in ('employer','agency') and j.status in ('live','draft'))), " +
  "e as (insert into email_outbox(template, portal_user_id, params, dedupe_key) " +
  "select 'rules_minimums_changed', u, jsonb_build_object('organisationId', org, 'versionId', $1::bigint, 'effectiveFrom', $2::text), 'rules_minimums_changed:' || $1 || ':' || org from t " +
  "on conflict (dedupe_key) do nothing returning 1), " +
  "n as (insert into notification(portal_user_id, category, template_key, params, dedupe_key) " +
  "select u, 'rules', 'rules_minimums_changed', jsonb_build_object('organisationId', org, 'versionId', $1::bigint, 'effectiveFrom', $2::text), 'rules_minimums_changed:' || $1 || ':' || org from t " +
  "on conflict (dedupe_key) do nothing returning 1) " +
  "select (select count(*) from e)::int as emails";

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
    const notices = r.target_id === "minimums" ? (await c.query<{ emails: number }>(NOTICES, [versionId, r.change!.effective_from])).rows[0]!.emails : 0;
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
