// Staff approval of employer and agency accounts (#186, #187): list, look at, claim, release, approve, ask for more and reject the
// `account_review` items that claim_organisation and register_organisation make. Run as app_admin, mirroring admin-queue.ts.
// Every action takes the acting staff member's id and, in the first statement, checks the person is active staff WITH the account_reviewer role
// (no other role stands in for it) and sets app.staff_user_id for the transaction. Only the claimer decides, under row locks.
import type pg from "pg";
import { QueueRefused, RELEASE, STALE_AFTER, TAKE_OVER } from "./admin-queue";
import { isTime, PAGE_SIZE, validId } from "./search";
import { domainProblem, isFreeEmailDomain } from "./domain-check";

export { domainProblem, FREE_EMAIL_DOMAINS, isFreeEmailDomain } from "./domain-check";

type Db = Pick<pg.Pool, "query" | "connect">;

// ===== the list and one item =====
const COLS =
  "r.id, r.status, r.claimed_by_staff_user_id, r.created_at::text as created_text, r.reason, r.detail, o.id as organisation_id, o.display_name, o.kind, " +
  "o.status as organisation_status, o.signup_path, o.cro_number, o.wrc_licence_number, u.email as claimant_email, " +
  "r.detail->>'answer' as answer, r.detail->>'answered_at' as answered_at, r.decided_at::text as decided_text, r.outcome, " +
  // B61: what the review page shows beside the claimant. The ban test is the one REVIEW_LOCK makes at approval (the owner's domain or address, or a company CRO number).
  // The last permit year is the newest DETE year with permits across the company's names (null: none). A non-domain email is one the company has not saved as its domain.
  "u.name as claimant_name, o.permit_history, " +
  "(select max(p.year) from dete_permit_count p join organisation_name n on n.id = p.organisation_name_id where n.organisation_id = o.id and p.permits > 0) as last_permit_year, " +
  "exists (select 1 from ban b where b.email_domain = lower(split_part(u.email, '@', 2)) or b.email_address = lower(u.email) or b.cro_number in " +
  "(select o.cro_number union select n.cro_number from organisation_name n where n.organisation_id = o.id)) as banned, " +
  "(u.email is not null and not exists (select 1 from organisation_domain d where d.organisation_id = o.id and d.domain = lower(split_part(u.email, '@', 2)))) as non_domain_email, " +
  // P10: a saved company domain (any company's) within 2 edits of the owner's email domain, after 0 and 1 are read as o and l. None when the owner's
  // domain is itself saved for some company (a known real domain). ponytail: scans organisation_domain once per row (a few thousand rows at launch); a trigram prefilter if it grows.
  "(select d.domain from organisation_domain d where not exists (select 1 from organisation_domain s where s.domain = lower(split_part(u.email, '@', 2))) and " +
  // levenshtein refuses text over 255 bytes, so a longer email domain (it cannot be a real one) is never compared: the case keeps that order
  "abs(length(d.domain) - length(split_part(u.email, '@', 2))) <= 2 and " + // a cheap cut first: more than 2 letters apart in length is more than 2 edits
  "case when octet_length(lower(split_part(u.email, '@', 2))) <= 253 then extensions.levenshtein_less_equal(translate(d.domain, '01', 'ol'), " +
  "translate(lower(split_part(u.email, '@', 2)), '01', 'ol'), 2) end <= 2 limit 1) as lookalike_of " +
  "from review_item r join organisation o on o.id = r.organisation_id " +
  "left join membership m on m.organisation_id = o.id and m.role = 'account_owner' and m.status = 'active' left join portal_user u on u.id = m.portal_user_id";
// The tabs (B61). No tab: every open and claimed item, oldest first (the first version of this read). The decided tabs are newest decision first, on review_item_done_idx.
// A company asked for more stays an open item with the company in needs_info, so "waiting" and "needs_info" split the open items by the company's status.
const OPEN_ITEMS = "r.queue = 'account_review' and r.status in ('open','claimed')";
const TABS = {
  all: { where: OPEN_ITEMS, key: "r.created_at", dir: "" },
  waiting: { where: `${OPEN_ITEMS} and o.status <> 'needs_info'`, key: "r.created_at", dir: "" },
  needs_info: { where: `${OPEN_ITEMS} and o.status = 'needs_info'`, key: "r.created_at", dir: "" },
  approved: { where: "r.queue = 'account_review' and r.status = 'done' and r.outcome = 'approved'", key: "coalesce(r.decided_at, r.created_at)", dir: " desc" },
  rejected: { where: "r.queue = 'account_review' and r.status = 'done' and r.outcome = 'rejected'", key: "coalesce(r.decided_at, r.created_at)", dir: " desc" },
} as const;
export type ReviewTab = keyof typeof TABS;
export const REVIEW_TABS = Object.keys(TABS).filter((k) => k !== "all") as readonly ReviewTab[];
const listSql = (tab: ReviewTab, after: boolean) => {
  const t = TABS[tab];
  const cmp = t.dir ? "<" : ">";
  return `select ${COLS} where ${t.where}${after ? ` and (${t.key}, r.id) ${cmp} ($1::timestamptz, $2::bigint)` : ""} order by ${t.key}${t.dir}, r.id${t.dir} limit ${PAGE_SIZE + 1}`;
};
export const REVIEW_FIRST = listSql("all", false);
export const REVIEW_AFTER = listSql("all", true);
export const REVIEW_ITEM = `select ${COLS} where r.id = $1::bigint and r.queue = 'account_review'`;
// The number on each tab. The open ones read review_item_queue_idx, the decided ones review_item_done_queue_idx (0073), so neither walks the whole table.
export const REVIEW_COUNTS =
  "select o.waiting, o.needs_info, coalesce(d.approved, 0)::int as approved, coalesce(d.rejected, 0)::int as rejected from " +
  "(select count(*) filter (where org.status <> 'needs_info')::int as waiting, count(*) filter (where org.status = 'needs_info')::int as needs_info " +
  "from review_item r join organisation org on org.id = r.organisation_id where r.queue = 'account_review' and r.status in ('open','claimed')) o, " +
  "(select count(*) filter (where outcome = 'approved')::int as approved, count(*) filter (where outcome = 'rejected')::int as rejected " +
  "from review_item where queue = 'account_review' and status = 'done' and outcome in ('approved','rejected')) d";
export type ReviewCounts = { waiting: number; needsInfo: number; approved: number; rejected: number };

type Row = {
  id: string; status: string; claimed_by_staff_user_id: string | null; created_text: string; reason: string | null; detail: unknown; organisation_id: string;
  display_name: string; kind: string; organisation_status: string; signup_path: string | null; cro_number: string | null; wrc_licence_number: string | null;
  claimant_email: string | null; answer: string | null; answered_at: string | null; lookalike_of: string | null;
  decided_text: string | null; outcome: string | null; claimant_name: string | null; permit_history: string; last_permit_year: number | null; banned: boolean; non_domain_email: boolean;
};
export type ReviewItem = {
  id: string; status: string; claimedBy: string | null; createdAt: string;
  /** Why the item was made ("claim" or "new organisation") and what the register check found (`found`, `name_matches`), as the sign-up function wrote them. */
  reason: string | null; detail: unknown;
  organisationId: string; displayName: string; kind: string; organisationStatus: string;
  /** dete_claim (existing sponsor), first_time (new employer) or agency. */
  signupPath: string | null; croNumber: string | null; wrcLicenceNumber: string | null;
  /** The company owner's sign-up email and its domain (the one "add the domain" would save). null when the owner membership is gone. */
  claimantEmail: string | null; emailDomain: string | null;
  /** The owner's latest answer to "ask for more" (#197) and when it was sent (ISO text); null until they answer. Plain text: show it as text, never as HTML. */
  answer: string | null; answeredAt: string | null;
  /** P10: extra reasons to look closely, never a refusal: `shared_mailbox` (hr@, jobs@ and the like) and `lookalike_domain` (near a saved company domain, named in `lookalikeOf`). */
  flags: string[]; lookalikeOf: string | null;
  /** B61. The claimant's name as they gave it at sign-up (plain text, show it as text); null when the owner membership is gone. */
  claimantName: string | null;
  /** The email domain is a free provider (gmail.com and the like); false with no email. */
  freeEmail: boolean;
  /** The company has not saved the email's domain as its own (so the claimant is not on a company address yet); false with no email. */
  nonDomainEmail: boolean;
  /** The company's DETE label: has_history, first_time or not_linked, and the newest year it had permits (null: none on record). */
  permitHistory: string; lastPermitYear: number | null;
  /** The owner's email domain, the email address or one of the company's CRO numbers is on the ban list (the check approval makes again). */
  banned: boolean;
  /** When the item was decided (ISO text) and how (approved, rejected, needs_info); null while it waits. A needs_info item keeps the time it was last asked. */
  decidedAt: string | null; outcome: string | null;
};

/** The part of an email after the first "@", lower case: the same cut the sign-up functions make (split_part(email, '@', 2)). */
export const domainOf = (email: string | null): string | null => (email === null ? null : (email.toLowerCase().split("@")[1] ?? "") || null);

/** P10: a mailbox many people read, not one person's: the part before "@" is one of these. */
export const SHARED_MAILBOXES: ReadonlySet<string> = new Set(["hr", "jobs", "careers", "info", "admin", "recruitment", "office"]);
export function reviewFlags(email: string | null, lookalikeOf: string | null): string[] {
  const local = email?.toLowerCase().split("@")[0];
  return [...(local !== undefined && SHARED_MAILBOXES.has(local) ? ["shared_mailbox"] : []), ...(lookalikeOf !== null ? ["lookalike_domain"] : [])];
}

const item = (r: Row): ReviewItem => ({
  id: r.id, status: r.status, claimedBy: r.claimed_by_staff_user_id, createdAt: r.created_text, reason: r.reason, detail: r.detail,
  organisationId: r.organisation_id, displayName: r.display_name, kind: r.kind, organisationStatus: r.organisation_status, signupPath: r.signup_path,
  croNumber: r.cro_number, wrcLicenceNumber: r.wrc_licence_number, claimantEmail: r.claimant_email, emailDomain: domainOf(r.claimant_email),
  answer: r.answer, answeredAt: r.answered_at, flags: reviewFlags(r.claimant_email, r.lookalike_of), lookalikeOf: r.lookalike_of,
  claimantName: r.claimant_name, freeEmail: isFreeEmailDomain(domainOf(r.claimant_email) ?? ""), nonDomainEmail: r.non_domain_email, permitHistory: r.permit_history,
  lastPermitYear: r.last_permit_year, banned: r.banned, decidedAt: r.decided_text, outcome: r.outcome,
});

// the cursor time is the one the tab sorts on: when it was decided for the decided tabs, else when it was made
const encode = (r: Row, tab: ReviewTab = "all") => Buffer.from(JSON.stringify({ t: TABS[tab].dir ? (r.decided_text ?? r.created_text) : r.created_text, i: r.id })).toString("base64url");
/** A page token from `encode` back to [time, id]; anything else is refused. Same token shape as the fetched-job queue's. */
export function decodeReviewCursor(token: unknown): [string, string] {
  const bad = new QueueRefused("bad_cursor");
  if (typeof token !== "string" || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) throw bad;
  let o: { t?: unknown; i?: unknown };
  try {
    o = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw bad;
  }
  if (o === null || typeof o !== "object" || typeof o.t !== "string" || !isTime(o.t) || !validId(o.i)) throw bad;
  return [o.t, o.i];
}

// ===== the role check =====
// One statement: sets the acting id for the transaction and answers two questions. A role is not implied by another (administrator is not a reviewer).
export const ACT =
  "select set_config('app.staff_user_id', $1, true), exists (select 1 from staff_user where id = $1 and status = 'active') as active, " +
  "exists (select 1 from staff_user u join staff_role r on r.staff_user_id = u.id where u.id = $1 and u.status = 'active' and r.role = 'account_reviewer') as reviewer";

async function checkReviewer(db: Pick<pg.Pool, "query">, staffUserId: string): Promise<void> {
  if (typeof staffUserId !== "string" || staffUserId.length === 0 || staffUserId.length > 200) throw new QueueRefused("not_active_staff");
  const r = (await db.query<{ active: boolean; reviewer: boolean }>(ACT, [staffUserId])).rows[0]!;
  if (!r.active) throw new QueueRefused("not_active_staff");
  if (!r.reviewer) throw new QueueRefused("not_reviewer");
}

/**
 * account_review items a page at a time: with no tab the open and claimed ones oldest first; with a tab (waiting, needs_info, approved, rejected) that tab's, the
 * decided ones newest decision first. Always with the four tab counts. Reviewers only: it shows the claimant's email.
 */
export async function listAccountReviews(
  db: Pick<pg.Pool, "query">, staffUserId: string, opts: { after?: string; tab?: string } = {},
): Promise<{ items: ReviewItem[]; next: string | null; counts: ReviewCounts }> {
  if (opts.tab !== undefined && !(REVIEW_TABS as readonly string[]).includes(opts.tab)) throw new QueueRefused("bad_tab");
  const tab = (opts.tab ?? "all") as ReviewTab;
  const cursor = opts.after === undefined ? undefined : decodeReviewCursor(opts.after);
  await checkReviewer(db, staffUserId);
  const all = (cursor ? await db.query<Row>(listSql(tab, true), cursor) : await db.query<Row>(listSql(tab, false))).rows;
  const c = (await db.query<{ waiting: number; needs_info: number; approved: number; rejected: number }>(REVIEW_COUNTS)).rows[0]!;
  const rows = all.slice(0, PAGE_SIZE);
  return { items: rows.map(item), next: all.length > PAGE_SIZE ? encode(rows.at(-1)!, tab) : null, counts: { waiting: c.waiting, needsInfo: c.needs_info, approved: c.approved, rejected: c.rejected } };
}

/** One account_review item, whatever its status. null when the id is not an account_review item. */
export async function getAccountReview(db: Pick<pg.Pool, "query">, staffUserId: string, id: string | number): Promise<ReviewItem | null> {
  await checkReviewer(db, staffUserId);
  const key = String(id);
  if (!validId(key)) return null;
  const r = (await db.query<Row>(REVIEW_ITEM, [key])).rows[0];
  return r ? item(r) : null;
}

// ===== the actions =====
async function acting<T>(db: Db, staffUserId: string, itemId: string | number, fn: (c: pg.PoolClient, item: string) => Promise<T>): Promise<T> {
  if (typeof staffUserId !== "string" || staffUserId.length === 0 || staffUserId.length > 200) throw new QueueRefused("not_active_staff");
  const key = String(itemId);
  if (!validId(key)) throw new QueueRefused("not_found");
  const c = await db.connect();
  try {
    await c.query("begin");
    const r = (await c.query<{ active: boolean; reviewer: boolean }>(ACT, [staffUserId])).rows[0]!;
    if (!r.active) throw new QueueRefused("not_active_staff");
    if (!r.reviewer) throw new QueueRefused("not_reviewer");
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

const CLAIM =
  "update review_item set status = 'claimed', claimed_by_staff_user_id = $2, claimed_at = now() " +
  "where id = $1::bigint and queue = 'account_review' and status = 'open' returning id";
const STATE = "select status, claimed_by_staff_user_id from review_item where id = $1::bigint and queue = 'account_review'";
// The fetched-job queue's take-over and release statements, pointed at this queue: they differ only by the queue name, so a change there is a change here.
const TAKE_OVER_REVIEW = TAKE_OVER.replaceAll("'fetched_job'", "'account_review'");
const RELEASE_REVIEW = RELEASE.replaceAll("'fetched_job'", "'account_review'");

/** Open to claimed by this reviewer. Same rules as the fetched-job queue: a stale claim (over STALE_AFTER, or its holder no longer active) can be taken over. */
export async function claimReview(db: Db, staffUserId: string, itemId: string | number): Promise<void> {
  await acting(db, staffUserId, itemId, async (c, id) => {
    if ((await c.query(CLAIM, [id, staffUserId])).rowCount === 1) return;
    const s = (await c.query<{ status: string; claimed_by_staff_user_id: string | null }>(STATE, [id])).rows[0];
    if (!s) throw new QueueRefused("not_found");
    if (s.status === "claimed" && s.claimed_by_staff_user_id === staffUserId) return;
    if (s.status !== "claimed") throw new QueueRefused("already_decided");
    if ((await c.query(TAKE_OVER_REVIEW, [id, staffUserId, "account_review.take_over", STALE_AFTER])).rowCount === 1) return;
    throw new QueueRefused("claimed_by_other");
  });
}

/** Claimed back to open, by the claimer only. */
export async function releaseReview(db: Db, staffUserId: string, itemId: string | number): Promise<void> {
  await acting(db, staffUserId, itemId, async (c, id) => {
    if ((await c.query(RELEASE_REVIEW, [id, staffUserId, "account_review.release"])).rowCount === 1) return;
    const s = (await c.query<{ status: string; claimed_by_staff_user_id: string | null }>(STATE, [id])).rows[0];
    if (!s) throw new QueueRefused("not_found");
    throw new QueueRefused(s.status === "open" ? "not_claimed" : s.status === "claimed" ? "not_claimer" : "already_decided");
  });
}

// The item and its organisation, locked, so two reviewers cannot decide one item at once. The claimant is the active account owner.
export const REVIEW_LOCK =
  "select r.status, r.claimed_by_staff_user_id, o.id as organisation_id, o.status as organisation_status, o.signup_path, u.id as claimant_id, u.email as claimant_email, " +
  "u.status as claimant_status, u.deleted_at is not null as claimant_deleted, " +
  // a ban added after the claim: the owner's email domain, or one of the company's CRO numbers (the same two checks claim_organisation makes)
  "exists (select 1 from ban b where b.email_domain = lower(split_part(u.email, '@', 2)) or b.email_address = lower(u.email) or b.cro_number in " +
  "(select o.cro_number union select n.cro_number from organisation_name n where n.organisation_id = o.id)) as claimant_banned " +
  "from review_item r join organisation o on o.id = r.organisation_id " +
  "left join membership m on m.organisation_id = o.id and m.role = 'account_owner' and m.status = 'active' left join portal_user u on u.id = m.portal_user_id " +
  "where r.id = $1::bigint and r.queue = 'account_review' for update of r, o";
type Locked = {
  status: string; claimed_by_staff_user_id: string | null; organisation_id: string; organisation_status: string; signup_path: string | null; claimant_id: string | null; claimant_email: string | null;
  claimant_status: string | null; claimant_deleted: boolean | null; claimant_banned: boolean;
};

// One statement for the organisation, the item, the audit row and (N4) the owner's portal notice and queued email. $1 item, $2 organisation, $3 staff,
// $4 new organisation status, $5 outcome, $6 action, $7 reason code, $8 audit "after", $9 the organisation's status as locked (the audit "before"),
// $10 the owner's portal user id (null: no owner, so no notice), $11 the template, $12 the notice params (decisionNotice). Reason codes only in the audit
// row, never free text (#182). One statement, so the notice and the email are written with the decision or not at all.
// The organisation must still be pending_review or needs_info. Ask for more ($5 = needs_info) leaves the item open and unclaimed: it stays the one
// open item, so a reviewer can claim it again and approve or reject; every other outcome closes it.
export const REVIEW_DECIDE =
  "with o as (update organisation set status = $4::text, verified_at = case when $4::text = 'verified' then now() else verified_at end " +
  "where id = $2::bigint and status in ('pending_review','needs_info') returning id), " +
  "r as (update review_item set status = case when $5::text = 'needs_info' then 'open' else 'done' end, " +
  "claimed_by_staff_user_id = case when $5::text = 'needs_info' then null else claimed_by_staff_user_id end, " +
  "claimed_at = case when $5::text = 'needs_info' then null else claimed_at end, " +
  // a new question clears the owner's earlier answer (#197), so staff never read an answer to a question that was since replaced
  "detail = case when $5::text = 'needs_info' then detail - 'answer' - 'answered_at' else detail end, decided_by_staff_user_id = $3, decided_at = now(), outcome = $5 " +
  "where id = $1::bigint and status = 'claimed' and claimed_by_staff_user_id = $3 and exists (select 1 from o) returning id), " +
  // #93's writers notify the account owner only; these do the same. No dedupe key: the locks make each decision happen once, and ask for more may repeat.
  "n as (insert into notification(portal_user_id, category, template_key, params) select $10::text, 'account', $11::text, $12::jsonb from r where $10::text is not null), " +
  "e as (insert into email_outbox(template, portal_user_id, params) select $11::text, $10::text, $12::jsonb from r where $10::text is not null) " +
  "insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, changed_columns, before, after, reason_code, source) " +
  "select 'admin_action', $3, $6, 'organisation', $2::text, '{status}', jsonb_build_object('status', $9::text), $8::jsonb, $7, 'panel' from r returning id";

async function lockForDecision(c: pg.PoolClient, id: string, staffUserId: string): Promise<Locked> {
  const r = (await c.query<Locked>(REVIEW_LOCK, [id])).rows[0];
  if (!r) throw new QueueRefused("not_found");
  if (r.status !== "claimed") throw new QueueRefused(r.status === "open" ? "not_claimed" : "already_decided");
  if (r.claimed_by_staff_user_id !== staffUserId) throw new QueueRefused("not_claimer");
  if (r.organisation_status !== "pending_review" && r.organisation_status !== "needs_info") throw new QueueRefused("organisation_not_pending");
  return r;
}

export type Decided = { organisationId: string; organisationStatus: string; domainAdded: string | null };
// N4: the template and params of the notice and email for each decision. Approve names the company; ask for more adds the reason code and the
// reviewer's question (written for the employer); reject adds the reason code only. Nothing else from staff goes in (no notes).
export const DECISION_TEMPLATE = { approved: "account_approved", needs_info: "account_needs_info", rejected: "account_rejected" } as const;
export type Outcome = keyof typeof DECISION_TEMPLATE;
export function decisionNotice(outcome: Outcome, organisationId: string, reason: string, question?: string): { template: string; params: Record<string, string> } {
  const params: Record<string, string> = { organisationId };
  if (outcome !== "approved") params.reason = reason;
  if (outcome === "needs_info" && question !== undefined) params.question = question;
  return { template: DECISION_TEMPLATE[outcome], params };
}

async function decide(
  c: pg.PoolClient, id: string, staffUserId: string, r: Locked, status: string, outcome: Outcome, reason: string, extraAfter: object = {}, question?: string,
): Promise<void> {
  const after = JSON.stringify({ status, ...extraAfter });
  const n = decisionNotice(outcome, r.organisation_id, reason, question);
  const w = await c.query(REVIEW_DECIDE, [
    id, r.organisation_id, staffUserId, status, outcome, `account_review.${outcome}`, reason, after, r.organisation_status, r.claimant_id, n.template, JSON.stringify(n.params),
  ]);
  if (w.rowCount !== 1) throw new Error("the decision did not write exactly one audit row"); // rolls back; the locks above make this unreachable
}

// ===== approve =====
export const DOMAIN_LOCK = "select pg_advisory_xact_lock(hashtext($1))"; // two reviewers adding one domain to two companies at once: the second waits and then sees the first
const DOMAIN_OTHER = "select exists (select 1 from organisation_domain where domain = $1 and organisation_id <> $2::bigint) as other";
const DOMAIN_ADD =
  "insert into organisation_domain(organisation_id, domain, source, added_by_staff_id) values ($1::bigint, $2, 'admin', $3) on conflict (organisation_id, domain) do nothing";

const MARK_FIRST_TIME = "select private.mark_first_time($1::bigint)";

/**
 * Approve: the organisation becomes verified. With `addDomain`, the claimant's own email domain is saved for the company (#186), so colleagues on it
 * pass without review next time; refused for a free email provider and for a domain another company holds.
 */
export async function approveAccount(db: Db, staffUserId: string, itemId: string | number, opts: { addDomain?: boolean } = {}): Promise<Decided> {
  if (opts.addDomain !== undefined && typeof opts.addDomain !== "boolean") throw new QueueRefused("bad_input");
  return acting(db, staffUserId, itemId, async (c, id) => {
    const r = await lockForDecision(c, id, staffUserId);
    // the claimant is checked again at approval: they may have been blocked, erased or banned (by domain or company number) since the claim was made
    if (r.claimant_email === null) throw new QueueRefused("no_claimant");
    if (r.claimant_status !== "active" || r.claimant_deleted || r.claimant_banned) throw new QueueRefused("claimant_not_active");
    let domain: string | null = null;
    if (opts.addDomain === true) {
      domain = domainOf(r.claimant_email);
      if (domain === null) throw new QueueRefused("no_claimant");
      const why = domainProblem(domain);
      if (why) throw new QueueRefused(why);
      await c.query(DOMAIN_LOCK, [domain]);
      if ((await c.query<{ other: boolean }>(DOMAIN_OTHER, [domain, r.organisation_id])).rows[0]!.other) throw new QueueRefused("domain_owned_by_other");
      await c.query(DOMAIN_ADD, [r.organisation_id, domain, staffUserId]);
    }
    // a first-time employer gets the "First-time sponsor" label (#73), in this transaction so a refusal undoes everything; agencies and DETE claims do not
    if (r.signup_path === "first_time") {
      try {
        await c.query(MARK_FIRST_TIME, [r.organisation_id]);
      } catch (e) {
        if (e instanceof Error && e.message.includes("has a DETE permit record")) throw new QueueRefused("has_permit_history");
        throw e;
      }
    }
    await decide(c, id, staffUserId, r, "verified", "approved", "approved", { domain_added: domain !== null, ...(r.signup_path === "first_time" ? { first_time_label: true } : {}) });
    return { organisationId: r.organisation_id, organisationStatus: "verified", domainAdded: domain };
  });
}

// ===== ask for more, reject =====
export const REASON = /^[a-z][a-z0-9_]{0,62}$/; // a reason code, never free text: the audit log holds no free text (#182)
const checkReason = (reason: unknown): string => {
  if (typeof reason !== "string" || !REASON.test(reason)) throw new QueueRefused("bad_reason");
  return reason;
};
export const QUESTION_MAX = 1000; // characters, the same cap and rule as the employer's answer (#219)
/** The reviewer's question for "ask for more": trimmed, 1 to QUESTION_MAX characters, no control or format character. Missing is allowed (undefined). */
export function checkQuestion(q: unknown): string | undefined {
  if (q === undefined) return undefined;
  const t = typeof q === "string" ? q.trim() : "";
  if (t.length < 1 || [...t].length > QUESTION_MAX || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(t)) throw new QueueRefused("bad_question");
  return t;
}

/**
 * Ask for more information: the organisation becomes needs_info and the item goes back to open (unclaimed). It stays the company's one open item, so
 * a reviewer can claim it again and approve or reject at any time, and the answer path (not built yet) reuses it. A needs_info company that never
 * answers is dealt with by the 30 day claim_needs_info retention rule (migration 0011), which also drops the item. The reason is a code; the default is "needs_info".
 * The question (plain text for the employer, checkQuestion) goes in the owner's notice and queued email only, never the audit row.
 */
export async function askForMoreInfo(db: Db, staffUserId: string, itemId: string | number, reason: string = "needs_info", question?: string): Promise<Decided> {
  const code = checkReason(reason);
  const text = checkQuestion(question);
  return acting(db, staffUserId, itemId, async (c, id) => {
    const r = await lockForDecision(c, id, staffUserId);
    await decide(c, id, staffUserId, r, "needs_info", "needs_info", code, {}, text);
    return { organisationId: r.organisation_id, organisationStatus: "needs_info", domainAdded: null };
  });
}

/**
 * Reject. A claim of an existing sponsor (signup_path dete_claim) returns the company to unclaimed, so the right person can still claim it; the
 * database removes the claimant's membership. A new registration becomes rejected. The reason is a code and is required.
 */
export async function rejectAccount(db: Db, staffUserId: string, itemId: string | number, reason: string): Promise<Decided> {
  const code = checkReason(reason);
  return acting(db, staffUserId, itemId, async (c, id) => {
    const r = await lockForDecision(c, id, staffUserId);
    const status = r.signup_path === "dete_claim" ? "unclaimed" : "rejected";
    await decide(c, id, staffUserId, r, status, "rejected", code);
    return { organisationId: r.organisation_id, organisationStatus: status, domainAdded: null };
  });
}
