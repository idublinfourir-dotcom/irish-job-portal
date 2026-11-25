// B69 and B70 (frames D08 and D09): the trust and safety reads for the admin pages. One list of reports and cases with one id label, the report counts per job and per
// company, the count of each tab, the closed history; the ban list and the WRC-reported list. Reads only: a ban is added by a decided case and lifted by two officers
// (#44, #104, #137), so there is no ban write here. trust_and_safety only, no other role stands in (checkTs). A reporter is never in these rows (#99), and nothing of
// them reaches the portal. Keyset paging only (#125); every count stops at COUNT_CAP.
import type pg from "pg";
import { QueueRefused } from "./admin-queue";
import { decodeReviewCursor } from "./account-review";
import { COUNT_CAP, PAGE_SIZE, isTime, validId } from "./search";
import { NEEDS_ACTION, checkTs } from "./trust-safety";
import { decodeIdCursor, encodeIdCursor } from "./wire";

type Q = Pick<pg.Pool, "query">;

/** The one id label of a report ("R-0091") or a case ("C-0091"): reports and cases have separate id spaces, so the letter says which. */
export const trustLabel = (kind: "report" | "case", id: string | number) => `${kind === "report" ? "R" : "C"}-${String(id).padStart(4, "0")}`;

/** The row in camel case, without the columns named in `drop` (the paging text of the time, which only the token needs). */
const camel = (r: Record<string, unknown>, drop: string[] = []) => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.includes(k)).map(([k, v]) => [k.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase()), v]));

// ===== B69: the list =====
const INBOX = "r.status in ('open','job_hidden')"; // report_queue_idx
const WAITING = "s.outcome is null and s.stage in ('employer_notified','reply_window')";
// Each tab: the report filter (null: no reports on it), the case filter, and the order. Open, waiting and appeals are oldest first; the closed history is newest first.
const TABS = {
  open: { report: INBOX, case: `${NEEDS_ACTION} and s.stage not in ('employer_notified','reply_window','appealed')`, desc: false },
  waiting: { report: null, case: WAITING, desc: false },
  appeals: { report: null, case: "s.stage = 'appealed'", desc: false },
  closed: { report: `not (${INBOX})`, case: `not ${NEEDS_ACTION}`, desc: true },
} as const;
export type TrustTab = keyof typeof TABS;
export const TRUST_TABS = Object.keys(TABS) as readonly TrustTab[];

// The position after a row, as a token: `{ b: tab, t: created_at text, k: "report" | "case", i: id }`. Ordered by (created_at, kind, id), the kind as text ("case" before "report").
const encode = (tab: TrustTab, r: { created_text: string; kind: string; id: string }) => Buffer.from(JSON.stringify({ b: tab, t: r.created_text, k: r.kind, i: r.id })).toString("base64url");
function decode(tab: TrustTab, token: unknown): [string, string, string] {
  const bad = new QueueRefused("bad_cursor");
  if (typeof token !== "string" || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) throw bad;
  let o: { b?: unknown; t?: unknown; k?: unknown; i?: unknown };
  try { o = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); } catch { throw bad; }
  if (o === null || typeof o !== "object" || Array.isArray(o) || Object.keys(o).join() !== "b,t,k,i" || o.b !== tab || typeof o.t !== "string" || !isTime(o.t) || (o.k !== "report" && o.k !== "case") || !validId(o.i)) throw bad;
  return [o.t, o.k, o.i as string];
}

// A row after the cursor ($1 time, $2 kind, $3 id) in the list's order (created_at, kind, id; "case" sorts before "report"). The plain time bound lets the index range-scan.
const after = (a: string, kind: "report" | "case", desc: boolean) => {
  const t = `${a}.created_at`;
  if (!desc) return kind === "report" ? `${t} >= $1::timestamptz and (${t} > $1::timestamptz or $2 = 'case' or ${a}.id > $3::bigint)` : `${t} >= $1::timestamptz and (${t} > $1::timestamptz or ($2 = 'case' and ${a}.id > $3::bigint))`;
  return kind === "report" ? `${t} <= $1::timestamptz and (${t} < $1::timestamptz or ($2 = 'report' and ${a}.id < $3::bigint))` : `${t} <= $1::timestamptz and (${t} < $1::timestamptz or $2 = 'report' or ${a}.id < $3::bigint)`;
};

function listSql(tab: TrustTab, paged: boolean): string {
  const t = TABS[tab], dir = t.desc ? "desc" : "asc";
  const report = "select 'report' as kind, r.id, r.created_at, r.created_at::text as created_text, coalesce(j.organisation_id, r.target_organisation_id) as organisation_id, r.target_job_id as job_id, " +
    "r.reason, r.status as state, null::text as outcome, null::smallint as level, null::bigint as report_id from report r left join job j on j.id = r.target_job_id " +
    `where ${t.report}${paged ? ` and ${after("r", "report", t.desc)}` : ""} order by r.created_at ${dir}, r.id ${dir} limit ${PAGE_SIZE + 1}`;
  const kase = "select 'case' as kind, s.id, s.created_at, s.created_at::text as created_text, s.organisation_id, s.job_id, s.reason_code as reason, s.stage as state, s.outcome, s.level, s.report_id " +
    `from strike s where ${t.case}${paged ? ` and ${after("s", "case", t.desc)}` : ""} order by s.created_at ${dir}, s.id ${dir} limit ${PAGE_SIZE + 1}`;
  const parts = [...(t.report ? [`(${report})`] : []), `(${kase})`].join(" union all ");
  // Each count looks at one more row than it shows, never more than COUNT_CAP: the reports on this job, and on this company (its own and those on its jobs).
  return `select p.*, o.display_name, o.kind as organisation_kind, jb.title as job_title, ` +
    `(select count(*)::int from (select 1 from report x where x.target_job_id = p.job_id limit ${COUNT_CAP}) c) as job_reports, ` +
    `(select count(*)::int from (select 1 from report x where x.target_organisation_id = p.organisation_id union all ` +
    `select 1 from job jj join report x on x.target_job_id = jj.id where jj.organisation_id = p.organisation_id limit ${COUNT_CAP}) c) as company_reports ` +
    `from (select * from (${parts}) u order by created_at ${dir}, kind ${dir}, id ${dir} limit ${PAGE_SIZE + 1}) p ` +
    `left join organisation o on o.id = p.organisation_id left join job jb on jb.id = p.job_id order by p.created_at ${dir}, p.kind ${dir}, p.id ${dir}`;
}
export const TRUST_LIST = Object.fromEntries(TRUST_TABS.flatMap((t) => [[`${t}`, listSql(t, false)], [`${t}:after`, listSql(t, true)]])) as Record<string, string>;

// The number on each tab, none above COUNT_CAP. One statement; reads report_queue_idx and the strike table.
export const TRUST_COUNTS = `select ${TRUST_TABS.map((t) => {
  const x = TABS[t];
  const rows = [...(x.report ? [`select 1 from report r where ${x.report}`] : []), `select 1 from strike s where ${x.case}`].join(" union all ");
  return `(select count(*)::int from (${rows} limit ${COUNT_CAP}) c) as ${t}`;
}).join(", ")}`;

/**
 * One list of reports and cases for a tab (open, waiting for the employer's reply, appeals, closed), 20 a page, each row with the one id label, the company, the job and
 * the report counts on that job and on that company (at most COUNT_CAP). `counts` (every tab, at most COUNT_CAP) comes with the first page only. No reporter, no evidence text.
 */
export async function listTrust(db: Q, staff: string, opts: { tab?: string; after?: string } = {}) {
  const tab = opts.tab ?? "open";
  if (!(TRUST_TABS as readonly string[]).includes(tab)) throw new QueueRefused("bad_tab");
  const cursor = opts.after === undefined ? undefined : decode(tab as TrustTab, opts.after);
  await checkTs(db, staff);
  const [list, counts] = await Promise.all([
    db.query<Record<string, string> & { id: string; kind: "report" | "case"; created_text: string }>(TRUST_LIST[cursor ? `${tab}:after` : tab]!, cursor),
    cursor ? undefined : db.query<Record<TrustTab, number>>(TRUST_COUNTS),
  ]);
  const rows = list.rows.slice(0, PAGE_SIZE);
  const items = rows.map((r) => ({ ...camel(r, ["created_text"]), label: trustLabel(r.kind, r.id) }));
  return { items, next: list.rows.length > PAGE_SIZE ? encode(tab as TrustTab, rows.at(-1)!) : null, counts: counts?.rows[0] ?? null };
}

// ===== B70: the ban list and the WRC-reported list =====
// One row per value (a ban row holds a CRO number, an email domain or an email address, or several). Newest ban first; the page is 20 ban rows, so up to 60 values.
// "Who" is the officer who proposed the ban and the second officer who confirmed it (approval_request); the date is when it was applied.
export const BANS =
  "select b.id as ban_id, v.type, v.value, b.reason_code, b.strike_id as case_id, s.case_kind, s.organisation_id, o.display_name, " +
  "coalesce(a.applied_at, a.decided_at) as added_at, pu.name as proposed_by, cu.name as confirmed_by, " +
  "exists (select 1 from approval_request l where l.kind = 'ban_lift' and l.target_table = 'ban' and l.target_id = b.id::text and l.status = 'pending') as lift_pending " +
  `from (select * from ban where id < $1::bigint order by id desc limit ${PAGE_SIZE + 1}) b ` +
  "join strike s on s.id = b.strike_id join organisation o on o.id = s.organisation_id join approval_request a on a.id = b.approval_request_id " +
  "left join staff_user pu on pu.id = a.proposed_by_staff_user_id left join staff_user cu on cu.id = a.confirmed_by_staff_user_id " +
  "cross join lateral (values (1, 'cro_number', b.cro_number), (2, 'email_domain', b.email_domain), (3, 'email_address', b.email_address)) v(ord, type, value) " +
  "where v.value is not null order by b.id desc, v.ord";

/** Every ban, newest first, a page of 20 ban rows at a time (`after` is the `next` of the page before). */
export async function listBans(db: Q, staff: string, opts: { after?: string } = {}) {
  const from = opts.after === undefined ? "9223372036854775807" : decodeIdCursor("bans", opts.after);
  await checkTs(db, staff);
  const rows = (await db.query<Record<string, string> & { ban_id: string }>(BANS, [from])).rows;
  const ids = [...new Set(rows.map((r) => r.ban_id))];
  const keep = ids.slice(0, PAGE_SIZE);
  return {
    items: rows.filter((r) => keep.includes(r.ban_id)).map((r) => ({ ...camel(r), caseLabel: trustLabel("case", r.case_id!) })),
    next: ids.length > PAGE_SIZE ? encodeIdCursor("bans", keep.at(-1)!) : null,
  };
}

// The page of audit rows comes first (audit_event_action_idx: action, at, id), the cases and companies are joined to those rows only.
export const WRC_PAGE =
  "select id, at, object_id, actor_staff_user_id from audit_event where action = 'trust_safety.wrc_reported' and object_type = 'strike'";
export const WRC_ORDER = `order by at desc, id desc limit ${PAGE_SIZE + 1}`;
export const wrcSql = (paged: boolean) =>
  `select e.id::text as id, e.at::text as at_text, e.at as reported_at, s.id as case_id, s.organisation_id, o.display_name, o.kind as organisation_kind, s.reason_code, u.name as reported_by ` +
  `from (${WRC_PAGE}${paged ? " and (at, id) < ($1::timestamptz, $2::bigint)" : ""} ${WRC_ORDER}) e join strike s on s.id = e.object_id::bigint join organisation o on o.id = s.organisation_id ` +
  "left join staff_user u on u.id = e.actor_staff_user_id order by e.at desc, e.id desc";

/** The cases staff ticked off as reported to the WRC (#214 d), newest first, with the date. */
export async function listWrcReported(db: Q, staff: string, opts: { after?: string } = {}) {
  const cursor = opts.after === undefined ? undefined : decodeReviewCursor(opts.after);
  await checkTs(db, staff);
  const all = (await db.query<Record<string, string> & { id: string; at_text: string }>(
    wrcSql(cursor !== undefined), cursor)).rows;
  const rows = all.slice(0, PAGE_SIZE);
  const last = rows.at(-1);
  return {
    items: rows.map((r) => ({ ...camel(r, ["id", "at_text"]), caseLabel: trustLabel("case", r.case_id!) })),
    next: all.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({ t: last.at_text, i: last.id })).toString("base64url") : null,
  };
}
