// Manual posting (step 13 part 13c; #232): an account reviewer posts a job for an existing employer or agency, recorded with posted_by_staff_id (source
// 'admin_manual'). It is listed only if it passes the checks an employer post runs (the occupation list, the contract, the rules chain, then the pay against the
// minimum for the stated hours, compared with >=), as "Critical Skills eligible"; otherwise it stays a draft and the reason is kept in the audit row. Never
// "Sponsor confirmed" when posted: that needs the employer's written confirmation and a second person (staff-uploads.ts, Q6). Staff may close their own manual posts.
// This file does not import from apps/portal: `manualVerdict` is the small check of apps/portal/lib/jobs.ts (`rulesFor`), written again on the same
// rules in force (#229, `freshRules`: never the cached copy, the answer is saved), with the same pay rule (#107, #150, #225). Every write sets the acting staff id for the transaction and checks the role in the database.
import type pg from "pg";
import { assess, chainRules, isSoc2010, minimumForHours, offScale, scamPhrase, type RulesSnapshot } from "@portal/rules";
import { QueueRefused, listAnswer } from "./admin-queue";
import { companyRefusal } from "./merges";
import { freshRules } from "./rules-data";
import { COUNTIES, PAGE_SIZE, validId } from "./search";
import { checkSearchText, like, SEARCH_LIMIT } from "./staff-search";
import { decodeIdCursor, encodeIdCursor } from "./wire";

type Db = Pick<pg.Pool, "query" | "connect">;

export const MAX_CLOSING_DAYS = 90; // the closing date is at most this many days ahead
const MAX_PAY = 1_000_000;


// ===== the body
export type ManualPost = {
  organisationId: string; title: string; description: string; county: (typeof COUNTIES)[number]; occupationCode: string; contractMonths: number | null;
  salaryLow: number | null; salaryHigh: number | null; payGrade: string | null; healthInsuranceEur: number | null; weeklyHours: number; closesOn: string; applyUrl: string;
};
const KEYS = ["organisationId", "title", "description", "county", "occupationCode", "contractMonths", "salaryLow", "salaryHigh", "payGrade", "healthInsuranceEur",
  "weeklyHours", "closesOn", "applyUrl"];

const BAD_LINE = /[\p{Cc}\p{Cf}]/u; // one line: no control or format characters (right-to-left overrides and zero-width characters included)
const BAD_TEXT = /[\p{Cf}]|[^\P{Cc}\n\r\t]/u; // a text: line breaks and tabs allowed
const line = (v: unknown, min: number, max: number) => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= min && t.length <= max && !BAD_LINE.test(t) ? t : null;
};
const int = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);
const opt = <T>(v: unknown, f: (x: unknown) => T | null): T | null | undefined => (v === undefined || v === null ? null : (f(v) ?? undefined));
const bad = (field: string): never => { throw new QueueRefused(`bad_${field}`); };

function checkUrl(v: unknown): string | null {
  const s = line(v, 10, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".") ? s : null;
  } catch { return null; }
}
const realDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d\d-\d\d$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** Checks a post body: every field known and in range, hostile text refused. Throws QueueRefused("bad_body" or "bad_<field>"). Pure. */
export function checkManualPost(b: unknown): ManualPost {
  if (b === null || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => !KEYS.includes(k))) return bad("body");
  const o = b as Record<string, unknown>;
  if (!validId(o.organisationId)) bad("organisation_id");
  const title = line(o.title, 2, 200) ?? bad("title");
  const applyUrl = checkUrl(o.applyUrl) ?? bad("apply_url");
  const description = typeof o.description === "string" ? o.description.trim() : "";
  if (description.length < 20 || description.length > 10_000 || BAD_TEXT.test(description)) bad("description");
  const county = COUNTIES.find((c) => c === o.county) ?? bad("county");
  const occupationCode = isSoc2010(o.occupationCode) ? o.occupationCode : bad("occupation_code");
  const contractMonths = opt(o.contractMonths, (v) => int(v, 1, 600));
  if (contractMonths === undefined) bad("contract_months");
  const salaryLow = opt(o.salaryLow, (v) => int(v, 1, MAX_PAY)), salaryHigh = opt(o.salaryHigh, (v) => int(v, 1, MAX_PAY));
  const payGrade = opt(o.payGrade, (v) => line(v, 1, 100)), healthInsuranceEur = opt(o.healthInsuranceEur, (v) => int(v, 0, 50_000));
  if (salaryLow === undefined || salaryHigh === undefined) bad("salary");
  if (payGrade === undefined) bad("pay_grade");
  if (healthInsuranceEur === undefined) bad("health_insurance");
  if (salaryLow === null && (salaryHigh !== null || payGrade === null)) bad("salary"); // pay or a public pay grade; a top needs a bottom
  if (salaryHigh !== null && salaryLow !== null && salaryHigh! < salaryLow!) bad("salary");
  const weeklyHours = int(o.weeklyHours, 1, 60) ?? bad("weekly_hours");
  if (!realDate(o.closesOn)) bad("closes_on");
  return {
    organisationId: o.organisationId as string, title, description, county, occupationCode, contractMonths: contractMonths ?? null, salaryLow: salaryLow ?? null,
    salaryHigh: salaryHigh ?? null, payGrade: payGrade ?? null, healthInsuranceEur: healthInsuranceEur ?? null, weeklyHours, closesOn: o.closesOn as string, applyUrl,
  };
}

// ===== the rules
export type Verdict = { ok: true; passRoute: "stated_pay" | "public_pay"; sector: string; stage: string } | { ok: false; code: string; stage?: string };

/** B72: one check of the dry run, as the employer form's (`apps/portal/lib/jobs.ts`): its facts in `detail`, and the refusal code when it blocks the listing. */
export type ManualCheck = { id: "occupation" | "contract" | "wording" | "money" | "pay"; state: "pass" | "blocked"; detail: Record<string, string | number | boolean | null>; code?: string };

/**
 * The rules on the structured fields, as an employer post runs them (apps/portal/lib/jobs.ts `rulesFor`): the occupation must be on the Critical Skills list (a
 * manual post is listed as "Critical Skills eligible"), the contract at least MIN_CONTRACT_MONTHS when it is fixed term, the rules chain on the text, then the
 * pay (the top of a range, with employer-paid health insurance) against the minimum for the stated hours, compared with >=. A post the chain sends to review is
 * not listed either (a staff post has no review queue): code `needs_review`. Every check is run and listed; the verdict is the first refusal in that order,
 * a review last.
 */
export async function manualChecks(p: ManualPost, employerName: string, r: RulesSnapshot): Promise<{ verdict: Verdict; checks: ManualCheck[] }> {
  const m = r.minimums;
  const onList = listAnswer(r.occupationLists, p.occupationCode);
  const occupation = onList === "no" ? "occupation_ineligible" : onList === null && !m.nonListRoute ? "occupation_not_on_list" : undefined;
  const contract = p.contractMonths !== null && p.contractMonths < m.minContractMonths ? "contract_too_short" : undefined;
  const a = await assess(
    { source: "employer", employer: employerName, title: p.title, location: `${p.county}, Ireland`, description: p.description, employmentType: "", salaryBox: "" },
    { deteNames: new Set(), ...chainRules(r), matcher: async () => ({ occupationCode: p.occupationCode, onCriticalSkillsList: "yes", confidence: "high" }) },
    // The contract is stated in its own field (checked above), so the chain's "contract unclear" stops do not apply; a short contract in the text still fails.
    { contractConfirmed: true, ...(p.salaryLow !== null ? { salary: { low: p.salaryLow, high: p.salaryHigh ?? p.salaryLow } } : {}) },
  );
  const failed = a.bucket === "rejected" && !a.stage.startsWith("8 "), held = a.bucket === "queue";
  // As an employer's post (#225, #150): a role off the Critical Skills list and not Ineligible qualifies at the non-list minimum.
  const minimum = minimumForHours(onList === "yes" ? m.criticalSkills : m.nonList, p.weeklyHours, m.standardWeekHours);
  const pay = p.salaryLow === null ? null : (p.salaryHigh ?? p.salaryLow) + (p.healthInsuranceEur ?? 0);
  let passRoute: "stated_pay" | "public_pay" | null = null, payCode: string | undefined;
  if (pay !== null && pay >= minimum) passRoute = "stated_pay";
  else if (a.publicPayTier > 0 && onList === "yes") { // a public pay-scale employer on a list role (#67); stated pay must sit on a listed grade's scale (#269)
    if (offScale(r, p.payGrade, p.salaryLow, p.salaryHigh)) payCode = "pay_not_on_scale"; else passRoute = "public_pay";
  } else payCode = pay === null ? "pay_required" : "pay_below_minimum";
  const check = (id: ManualCheck["id"], code: string | undefined, detail: ManualCheck["detail"]): ManualCheck => ({ id, state: code ? "blocked" : "pass", detail, ...(code ? { code } : {}) });
  const checks = [
    check("occupation", occupation, { occupationCode: p.occupationCode, list: onList === "yes" ? "critical_skills" : onList === "no" ? "ineligible" : null }),
    check("contract", contract, { months: p.contractMonths, minimumMonths: m.minContractMonths }),
    check("wording", failed ? "rules_failed" : held ? "needs_review" : undefined, { stage: a.stage }),
    check("money", a.scamFlag ? "needs_review" : undefined, { phrase: scamPhrase(p.description) }),
    check("pay", payCode, { minimumEur: minimum, countedEur: pay, healthInsuranceEur: p.healthInsuranceEur ?? 0, weeklyHours: p.weeklyHours, route: passRoute }),
  ];
  const first = occupation ?? contract;
  const verdict: Verdict = first ? { ok: false, code: first }
    : failed ? { ok: false, code: "rules_failed", stage: a.stage }
    : payCode ? { ok: false, code: payCode }
    : held || a.scamFlag ? { ok: false, code: "needs_review", stage: a.stage }
    : { ok: true, passRoute: passRoute!, sector: a.sector, stage: a.stage };
  return { verdict, checks };
}
export const manualVerdict = async (p: ManualPost, employerName: string, r: RulesSnapshot): Promise<Verdict> => (await manualChecks(p, employerName, r)).verdict;

// ===== the writes
async function acting<T>(db: Db, staff: string, roles: string[], code: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  if (typeof staff !== "string" || staff.length === 0 || staff.length > 200) throw new QueueRefused("not_active_staff");
  const c = await db.connect();
  try {
    await c.query("begin");
    // The first statement sets the acting id for the audit guard and checks the staff member (active, and one of the roles) in the database.
    await c.query("select set_config('app.staff_user_id', $1, true), private.companies_staff_check($1, $2::text[], $3)", [staff, roles, code]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    return companyRefusal(e);
  } finally {
    c.release();
  }
}

const ORG = "select display_name, kind, status, merged_into_id is not null as merged from organisation where id = $1::bigint"; // a post adds " for share": a merge waits for it
const CLOSES = "select t as closes_at, t > now() as future, t <= now() + make_interval(days => $2::int) as near from (select (($1::date + time '23:59:59') at time zone 'Europe/Dublin') as t) s";
// search_vector is built the way packages/fetcher/src/store.ts and apps/portal/lib/jobs.ts build it: title, employer name and advert text.
const INSERT_JOB =
  "insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, contract_type, contract_months, permit_type, badge, " +
  "salary_low, salary_high, health_insurance_eur, pay_grade, weekly_hours, pass_route, status, closes_at, search_vector, own_page_url, posted_by_staff_id) " +
  "values ($1::bigint, 'admin_manual', (select id from job_source where kind = 'admin' and board = 'manual'), $2::text, $3::text, $4, $5, $6, $7, $8::smallint, 'critical_skills', $9, " +
  "$10::int, $11::int, $12::int, $13, $14::smallint, $15, $16, $17::timestamptz, to_tsvector('english', $2::text || ' ' || $3::text || ' ' || $18::text), $19, $20) returning id::text as id";
const INSERT_TEXT = "insert into job_text(job_id, advert_text) values ($1::bigint, $2)";
const AUDIT =
  "insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, after, reason_code, source) values ('admin_action', $1, $2, 'job', $3, $4::jsonb, $5, 'panel')";

export type Posted = { jobId: string; status: "live" | "draft"; passRoute: string | null; reason: { code: string; stage?: string } | null };
const NOT_POSTABLE = ["rejected", "closed", "banned", "suspended"];

/** What a post and its dry run share: the company (which must be one a post can be made for), the closing date and the rules. */
async function tried(c: pg.PoolClient, p: ManualPost, lock: "" | " for share") {
  const org = (await c.query<{ display_name: string; kind: string; status: string; merged: boolean }>(ORG + lock, [p.organisationId])).rows[0];
  if (!org) throw new QueueRefused("company_not_found");
  if ((org.kind !== "employer" && org.kind !== "agency") || org.merged || NOT_POSTABLE.includes(org.status)) throw new QueueRefused("company_not_postable");
  const when = (await c.query<{ closes_at: Date; future: boolean; near: boolean }>(CLOSES, [p.closesOn, MAX_CLOSING_DAYS])).rows[0]!;
  if (!when.future || !when.near) throw new QueueRefused("bad_closing_date");
  return { org, when, ...(await manualChecks(p, org.display_name, await freshRules(c))) };
}
const reasonOf = (v: Verdict) => (v.ok ? null : { code: v.code, ...(v.stage ? { stage: v.stage } : {}) });

export type ManualDryRun = { status: "live" | "draft"; badge: "critical_skills_eligible" | null; passRoute: string | null; reason: { code: string; stage?: string } | null; closesAt: string; checks: ManualCheck[] };
/** B72: what `createManualPost` would do with this body, every check listed and nothing written. The same role and refusals as the post. */
export async function dryRunManualPost(db: Db, staff: string, input: unknown): Promise<ManualDryRun> {
  const p = checkManualPost(input);
  return acting(db, staff, ["account_reviewer"], "NOT_ACCOUNT_REVIEWER", async (c) => {
    const { when, verdict: v, checks } = await tried(c, p, "");
    return { status: v.ok ? "live" : "draft", badge: v.ok ? "critical_skills_eligible" : null, passRoute: v.ok ? v.passRoute : null, reason: reasonOf(v), closesAt: when.closes_at.toISOString(), checks };
  });
}

// B72: the employer picker: the companies a post can be made for, by any of their names (inside it) or CRO number (from its start). No login, member or email column.
// ponytail: a scan of organisation and its names, as B58's search; a trigram index on display_name when the table passes about 50,000 rows.
export const MANUAL_COMPANIES =
  "select o.id::text as id, o.display_name, o.kind, o.cro_number, o.status, o.county from organisation o where o.merged_into_id is null and o.kind in ('employer','agency') " +
  "and o.status <> all($3::text[]) and (o.display_name ilike $1 escape '\\' or o.cro_number like $2 escape '\\' or exists (select 1 from organisation_name n " +
  `where n.organisation_id = o.id and n.name ilike $1 escape '\\')) order by o.display_name, o.id limit ${SEARCH_LIMIT + 1}`;
export type ManualCompany = { id: string; displayName: string; kind: string; croNumber: string | null; status: string; county: string | null };
/** At most SEARCH_LIMIT companies an account reviewer can post for; `more` when there are others. bad_query for a text under 3 or over 100 characters. */
export async function searchManualCompanies(db: Pick<pg.Pool, "query">, staff: string, q: unknown): Promise<{ items: ManualCompany[]; more: boolean }> {
  const t = checkSearchText(q);
  try {
    await db.query("select private.companies_staff_check($1, $2::text[], 'NOT_ACCOUNT_REVIEWER')", [staff, ["account_reviewer"]]);
  } catch (e) {
    return companyRefusal(e);
  }
  const rows = (await db.query(MANUAL_COMPANIES, [like(t, "inside"), like(t, "start"), NOT_POSTABLE])).rows;
  return { items: rows.slice(0, SEARCH_LIMIT).map((x) => ({ id: x.id, displayName: x.display_name, kind: x.kind, croNumber: x.cro_number, status: x.status, county: x.county })), more: rows.length > SEARCH_LIMIT };
}

/**
 * Posts a job for an existing employer or agency. Listed ("live", badge critical_skills_eligible) only when `manualVerdict` passes; otherwise a draft with the reason
 * (returned, and kept as the audit row's reason code). Account reviewers only. Refusals: not_active_staff, not_account_reviewer, company_not_found, company_not_postable,
 * bad_closing_date, and the bad_* codes of `checkManualPost`.
 */
export async function createManualPost(db: Db, staff: string, input: unknown): Promise<Posted> {
  const p = checkManualPost(input);
  return acting(db, staff, ["account_reviewer"], "NOT_ACCOUNT_REVIEWER", async (c) => {
    const { org, when, verdict: v } = await tried(c, p, " for share");
    const live = v.ok;
    const r = (await c.query<{ id: string }>(INSERT_JOB, [
      p.organisationId, p.title, org.display_name, p.county, v.ok ? v.sector : "other", p.occupationCode, p.contractMonths === null ? "permanent" : "fixed_term", p.contractMonths,
      live ? "critical_skills_eligible" : null, p.salaryLow, p.salaryHigh, p.healthInsuranceEur, p.payGrade, p.weeklyHours, v.ok ? v.passRoute : null, live ? "live" : "draft",
      when.closes_at, p.description, p.applyUrl, staff])).rows[0]!;
    await c.query(INSERT_TEXT, [r.id, p.description]);
    const reason = reasonOf(v);
    await c.query(AUDIT, [staff, "job.manual_post", r.id, JSON.stringify({ organisation_id: p.organisationId, status: live ? "live" : "draft", pass_route: v.ok ? v.passRoute : null, ...(reason?.stage ? { stage: reason.stage } : {}) }),
      reason?.code ?? null]);
    return { jobId: r.id, status: live ? "live" : "draft", passRoute: v.ok ? v.passRoute : null, reason };
  });
}

const CLOSE =
  "update job set status = 'closed', closed_at = now(), close_reason = 'closed' where id = $1::bigint and source = 'admin_manual' and posted_by_staff_id = $2 " +
  "and status in ('draft','in_review','live','under_review') returning id";
const WHY_NOT = "select posted_by_staff_id from job where id = $1::bigint and source = 'admin_manual'";

/** Closes a manual post the staff member posted. Refusals: not_found (also a job that is not a manual post), not_poster (somebody else's post), bad_state (closed or hidden already). */
export async function closeManualPost(db: Db, staff: string, jobId: string): Promise<{ jobId: string }> {
  if (!validId(jobId)) throw new QueueRefused("bad_input");
  return acting(db, staff, ["account_reviewer"], "NOT_ACCOUNT_REVIEWER", async (c) => {
    if ((await c.query(CLOSE, [jobId, staff])).rowCount === 1) {
      await c.query(AUDIT, [staff, "job.manual_close", jobId, JSON.stringify({ status: "closed", close_reason: "closed" }), null]);
      return { jobId };
    }
    const j = (await c.query<{ posted_by_staff_id: string | null }>(WHY_NOT, [jobId])).rows[0];
    throw new QueueRefused(!j ? "not_found" : j.posted_by_staff_id !== staff ? "not_poster" : "bad_state");
  });
}

// Matrix 20c "Manual posting": the account reviewer edits, the trust and safety officer and the administrator view; the rest have no access.
export const MANUAL_VIEWERS = ["account_reviewer", "trust_and_safety", "administrator"];
const LIST_COLS =
  "select j.id::text as id, j.organisation_id::text as organisation_id, o.display_name, j.title, j.status, j.badge, j.pass_route, j.posted_by_staff_id, j.posted_at::text as posted_at, " +
  "j.closes_at::text as closes_at, j.closed_at::text as closed_at, " +
  "(select a.reason_code from audit_event a where a.object_type = 'job' and a.object_id = j.id::text and a.action = 'job.manual_post' order by a.id limit 1) as reason, " +
  // the "Sponsor confirmed" request waiting on the post (Q6), if any: with the badge, where the post stands in the later two-person step (#232)
  "(select q.id::text from approval_request q where q.kind = 'manual_post_sponsor_confirmed' and q.target_table = 'sponsorship_statement' and q.target_id = j.id::text and q.status = 'pending') as sponsor_request_id " +
  "from job j join organisation o on o.id = j.organisation_id where j.source = 'admin_manual'";
const MINE = " and ($1::text is null or j.posted_by_staff_id = $1)";
export const MANUAL_LIST_FIRST = `${LIST_COLS}${MINE} order by j.id desc limit ${PAGE_SIZE + 1}`;
export const MANUAL_LIST_AFTER = `${LIST_COLS}${MINE} and j.id < $2::bigint order by j.id desc limit ${PAGE_SIZE + 1}`;
export type ManualRow = {
  id: string; organisation_id: string; display_name: string; title: string; status: string; badge: string | null; pass_route: string | null; posted_by_staff_id: string | null;
  posted_at: string; closes_at: string; closed_at: string | null; reason: string | null; sponsor_request_id: string | null;
};

/** The manual posts, newest first, a page of PAGE_SIZE; `after` is the `next` of the page before, `mine` only the staff member's own. `reason` is why a draft is not listed. */
export async function listManualPosts(db: Pick<pg.Pool, "query">, staff: string, opts: { after?: string; mine?: boolean } = {}): Promise<{ items: ManualRow[]; next: string | null }> {
  const after = opts.after === undefined ? undefined : decodeIdCursor("manual_jobs", opts.after);
  try {
    await db.query("select private.companies_staff_check($1, $2::text[], 'NOT_MANUAL_VIEWER')", [staff, MANUAL_VIEWERS]);
  } catch (e) {
    return companyRefusal(e);
  }
  const all = (after === undefined ? await db.query<ManualRow>(MANUAL_LIST_FIRST, [opts.mine ? staff : null]) : await db.query<ManualRow>(MANUAL_LIST_AFTER, [opts.mine ? staff : null, after])).rows;
  const rows = all.slice(0, PAGE_SIZE);
  return { items: rows, next: all.length > PAGE_SIZE ? encodeIdCursor("manual_jobs", rows.at(-1)!.id) : null };
}
