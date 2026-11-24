// The signed-in candidate's own data (step 9, part 10): profile, saved jobs, the tracker and "Did you apply?", one closed job with similar live jobs,
// notification settings, and deleting the account. Every function takes the candidate's id from the session and puts it in every WHERE or INSERT:
// the database has no row level security, so a statement without it would read another candidate's rows. The routes are in apps/candidate.
import type pg from "pg";
import { hasControl, inTransaction, isObject, only, Refuse } from "./candidate-route";
import { getRules } from "./rules-data";
import { payScaleLine, salaryLine, validId } from "./search";
import { documentLabels } from "./case-document-codes";
import { REFERRAL_FIRM_SHOWN, timelineEvents } from "./services-board";

// ===== profile (#88, #105, #108) =====
// Stamps as the Immigration Service Delivery site lists them (irishimmigration.ie, read 12 November 2026). Any stamp starting with 4 allows work without a permit.
export const STAMPS = ["0", "1", "1A", "1G", "1H", "2", "2A", "3", "4", "4EUFAM", "4D", "4S", "5", "6"] as const;
export const isStamp4 = (stamp: string | null) => stamp !== null && stamp.startsWith("4");

const str = (max: number, re?: RegExp) => (v: unknown) => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length >= 1 && t.length <= max && !hasControl(t) && (!re || re.test(t)) ? t : undefined;
};
const oneOf = (...xs: readonly string[]) => (v: unknown) => (typeof v === "string" && xs.includes(v) ? v : undefined);
// [JSON key, column, check]. A key left out of a PUT is stored empty (null): PUT replaces the whole profile.
const PROFILE = (occupations: ReadonlySet<string>) => [
  ["fullName", "full_name", str(120)],
  ["phone", "phone", str(30, /^\+?[0-9 ()-]{5,30}$/)],
  ["occupationCode", "occupation_code", (v: unknown) => (typeof v === "string" && occupations.has(v) ? v : undefined)],
  ["yearsExperience", "years_experience", (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 60 ? v : undefined)],
  ["hasRelevantDegree", "has_relevant_degree", (v: unknown) => (typeof v === "boolean" ? v : undefined)],
  ["degreeField", "degree_field", str(120)],
  ["degreeAwardedMonth", "degree_awarded_month", str(10, /^(19[5-9]\d|20\d\d)-(0[1-9]|1[0-2])-01$/)], // the first day of the month (#108)
  ["registrationBody", "registration_body", str(120)],
  ["registrationNumber", "registration_number", str(60)],
  ["registrationStatus", "registration_status", oneOf("none", "in_progress", "registered")],
  ["locationKind", "location_kind", oneOf("abroad", "ireland")],
  ["currentStamp", "current_stamp", oneOf(...STAMPS)],
] as const;

export type ProfileBody = Record<string, string | number | boolean | null>;
/** Null means refuse. Unknown fields are refused; the same rules as the table's checks, so a bad body is a 400 and not a database error. */
export const checkProfile = (occupations: ReadonlySet<string>) => (b: unknown): ProfileBody | null => {
  const fields = PROFILE(occupations);
  if (!isObject(b) || !only(b, fields.map((f) => f[0]))) return null;
  const out: ProfileBody = {};
  for (const [key, col, check] of fields) {
    const v = b[key];
    if (v === undefined || v === null) { out[col] = null; continue; }
    const ok = check(v);
    if (ok === undefined) return null;
    out[col] = ok as string | number | boolean;
  }
  if (out.degree_awarded_month !== null && out.has_relevant_degree !== true) return null; // a degree date needs a degree
  if (out.current_stamp !== null && out.location_kind !== "ireland") return null; // a stamp needs Ireland
  return out;
};

const COLUMNS = PROFILE(new Set()).map((f) => [f[0], f[1]] as const);
export const SELECT_PROFILE = COLUMNS.map(([k, c]) => (c === "degree_awarded_month" ? `to_char(${c}, 'YYYY-MM-DD') as "${k}"` : `${c} as "${k}"`)).join(", ");

// #69, #108: the degree box's three choices, derived from the stored award month. "last_12_months" until the same month a year on starts in
// Irish time (the award month is stored as its first day, so a degree from May 2025 counts as recent up to 30 April 2026). A degree with no
// date is "relevant". The box is only a pre-fill: the candidate can still pick another choice.
export type DegreeBox = "relevant" | "last_12_months" | "none";
const IRISH_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit" });
export function degreeBox(hasDegree: boolean | null, awardedMonth: string | null, now = new Date()): DegreeBox {
  if (hasDegree !== true) return "none";
  if (!awardedMonth) return "relevant";
  const year = Number(awardedMonth.slice(0, 4)) + 1;
  return IRISH_DAY.format(now) < `${year}${awardedMonth.slice(4)}` ? "last_12_months" : "relevant";
}

export async function getProfile(db: pg.Pool, userId: string) {
  const r = await db.query(`select ${SELECT_PROFILE} from candidate_profile where candidate_user_id = $1`, [userId]);
  const p = r.rows[0];
  return { profile: p ? { ...p, degreeBox: degreeBox(p.hasRelevantDegree, p.degreeAwardedMonth) } : null };
}

/** Replaces the profile. A Stamp 4 pauses every active alert in the same transaction and says deletion is offered (#105). */
export async function putProfile(db: pg.Pool, userId: string, p: ProfileBody) {
  const cols = COLUMNS.map((c) => c[1]);
  const marks = cols.map((c, i) => `$${i + 2}${c === "degree_awarded_month" ? "::date" : ""}`);
  return inTransaction(db, async (c) => {
    await c.query(
      `insert into candidate_profile(candidate_user_id, ${cols.join(", ")}) values ($1, ${marks.join(", ")})
       on conflict (candidate_user_id) do update set ${cols.map((x) => `${x} = excluded.${x}`).join(", ")}`, [userId, ...cols.map((x) => p[x])]);
    if (!isStamp4(p.current_stamp as string | null)) return { ok: true, deletionOffered: false, alertsPaused: 0 };
    const paused = await c.query("update alert set status = 'paused', pause_reason = 'stamp_4' where candidate_user_id = $1 and status = 'active'", [userId]);
    return { ok: true, deletionOffered: true, alertsPaused: paused.rowCount ?? 0 };
  });
}

// ===== saved jobs (#57, D5) =====
export const checkJobId = (b: unknown): { jobId: string } | null => (isObject(b) && only(b, ["jobId"]) && validId(b.jobId) ? { jobId: b.jobId } : null);

const CARD = "j.id::text as \"jobId\", j.title, j.employer_name as \"employerName\", j.county, j.salary_low as \"salaryLow\", j.salary_high as \"salaryHigh\", j.pay_grade as \"payGrade\", j.badge";
// The SmallJobCard of a saved, tracked or similar job (B7): the card plus what a job card shows. Needs SMALL_JOIN. The did-you-apply prompts keep the plain CARD.
const SMALL =
  `${CARD}, j.contract_months as "contractMonths", j.permit_history as "permitHistory", j.source, o.slug as "employerSlug", o.logo_url as "employerLogoUrl", ` +
  'j.pass_route as "passRoute", j.quota_full as "quotaFull", j.posted_at as "postedAt", js.last_ok_at as "lastCheckedAt"';
const SMALL_JOIN = "join organisation o on o.id = j.organisation_id left join job_source js on js.id = j.job_source_id";
type Priced = { salaryLow: number | null; salaryHigh: number | null; payGrade: string | null };
/** Adds salaryLine and payScaleLine to rows of SMALL. The rules are read only when a row has a pay grade (kept 5 minutes). */
async function priced<T extends Priced>(db: pg.Pool, rows: T[]) {
  const rules = rows.some((r) => r.payGrade !== null) ? await getRules(db) : null;
  return rows.map((r) => ({ ...r, salaryLine: salaryLine(r.salaryLow, r.salaryHigh, r.payGrade), payScaleLine: rules ? payScaleLine(rules, r.payGrade) : null }));
}
const LIVE = "(j.status = 'live' and j.closes_at > now())";
// S20: why a job is not shown, as a code the page words (placeholder wording later): null when live. Only the hidden reason's code is read,
// never the report, the reporter or staff notes. Anything else that is not live (closed, expired, hidden by staff or a suspension) is no_longer_available.
const REASON =
  `case when ${LIVE} then null when j.status = 'under_review' then 'under_review' when j.status = 'hidden' and j.hidden_reason = 'report' then 'hidden_after_report' ` +
  "else 'no_longer_available' end as reason";
// A job that is no longer live shows only what the candidate saw when saving: its title and employer, and the reason.
const stripIfClosed = <T extends { live: boolean; jobId: string; title: string; employerName: string; reason: string | null }>(r: T) =>
  r.live ? r : ({ jobId: r.jobId, title: r.title, employerName: r.employerName, live: false, reason: r.reason } as T);

/** Newest first, closed jobs included and marked live: false. At most 200 rows (the cap), so no paging. */
export async function listSaved(db: pg.Pool, userId: string) {
  const r = await db.query(
    `select ${SMALL}, ${LIVE} as live, ${REASON}, s.created_at as "savedAt" from saved_job s join job j on j.id = s.job_id ${SMALL_JOIN}
     where s.candidate_user_id = $1 order by s.created_at desc, s.id desc limit 200`, [userId]);
  return { saved: (await priced(db, r.rows)).map((x) => ({ ...stripIfClosed(x), savedAt: x.savedAt })) };
}

// The database refuses a job that was never live and the 201st save (migration 0020). Saving again is not an error.
export async function saveJob(db: pg.Pool, userId: string, b: { jobId: string }) {
  await db.query(
    `insert into saved_job(candidate_user_id, job_id) select $1, $2::bigint
     where not exists (select 1 from saved_job where candidate_user_id = $1 and job_id = $2::bigint) on conflict do nothing`, [userId, b.jobId]);
  return { ok: true };
}
export async function unsaveJob(db: pg.Pool, userId: string, b: { jobId: string }) {
  const r = await db.query("delete from saved_job where candidate_user_id = $1 and job_id = $2::bigint", [userId, b.jobId]);
  return { ok: true, removed: r.rowCount ?? 0 };
}

// ===== the tracker and "Did you apply?" (#49, #86) =====
export const STAGES = ["applied", "interview", "viewed", "shortlisted", "offer", "hired", "rejected", "withdrawn"] as const;
export const ANSWERS = ["yes", "not_yet", "no"] as const;
export const ASK_DAYS = 14; // the apply_click retention setting (migration 0001); the candidate role cannot read settings
export const MAX_ASKS = 2;
const PROMPTS = 5; // most prompts one read returns

/** The click on "Apply" that leaves for the employer's own page: the open click row (a new click starts the asks again) and today's count, one statement each. */
export async function applyClick(db: pg.Pool, userId: string, b: { jobId: string }) {
  return inTransaction(db, async (c) => {
    const job = await c.query("select own_page_url as url from job where id = $1::bigint and status = 'live' and closes_at > now() and application_route = 'own_page'", [b.jobId]);
    if (!job.rowCount) throw new Refuse(404, "JOB_NOT_FOUND");
    await c.query(
      `insert into apply_click(candidate_user_id, job_id) values ($1, $2::bigint)
       on conflict (candidate_user_id, job_id) where status in ('pending', 'not_yet') do update set clicked_at = now(), status = 'pending', times_asked = 0, answered_at = null`, [userId, b.jobId]);
    await c.query(
      `insert into job_daily_stat(job_id, day, apply_clicks) values ($1::bigint, current_date, 1)
       on conflict (job_id, day) do update set apply_clicks = job_daily_stat.apply_clicks + 1`, [b.jobId]);
    return { ok: true, url: job.rows[0].url as string };
  });
}

/** The clicks to ask about now: open, asked fewer than twice, clicked within 14 days. Reading changes nothing, so a reload costs no ask. */
export async function didYouApplyPrompts(db: pg.Pool, userId: string) {
  const r = await db.query(
    `select c.id::text as "clickId", ${CARD}, c.clicked_at as "clickedAt" from apply_click c join job j on j.id = c.job_id
     where c.candidate_user_id = $1 and c.status in ('pending', 'not_yet') and c.times_asked < $2 and c.clicked_at > now() - make_interval(days => $3)
     order by c.clicked_at desc limit ${PROMPTS}`, [userId, MAX_ASKS, ASK_DAYS]);
  return { prompts: r.rows };
}

export const checkAnswer = (b: unknown): { clickId: string; answer: (typeof ANSWERS)[number] } | null =>
  isObject(b) && only(b, ["clickId", "answer"]) && validId(b.clickId) && typeof b.answer === "string" && (ANSWERS as readonly string[]).includes(b.answer)
    ? { clickId: b.clickId, answer: b.answer as (typeof ANSWERS)[number] } : null;

/** Every answer is one ask. Yes writes the tracker row (origin did_you_apply_yes) in the same transaction; a second "not yet" ends the asking. */
export async function answerClick(db: pg.Pool, userId: string, b: { clickId: string; answer: string }) {
  return inTransaction(db, async (c) => {
    const r = await c.query(
      `update apply_click set times_asked = least(times_asked + 1, $3),
         status = case $4::text when 'yes' then 'yes' when 'no' then 'no' when 'not_yet' then (case when times_asked + 1 >= $3 then 'expired' else 'not_yet' end) end,
         answered_at = case when $4::text = 'not_yet' then answered_at else now() end
       where id = $1::bigint and candidate_user_id = $2 and status in ('pending', 'not_yet') returning job_id::text as "jobId"`, [b.clickId, userId, MAX_ASKS, b.answer]);
    if (!r.rowCount) throw new Refuse(404, "CLICK_NOT_FOUND");
    if (b.answer === "yes")
      await c.query(
        `insert into tracker_entry(candidate_user_id, job_id, route, origin, stage) values ($1, $2::bigint, 'redirect', 'did_you_apply_yes', 'applied')
         on conflict (candidate_user_id, job_id) do nothing`, [userId, r.rows[0].jobId]);
    return { ok: true };
  });
}

/** "Mark applied": a redirect tracker row at applied, and any open "Did you apply?" for the job is closed as yes. Marking twice changes nothing. */
export async function markApplied(db: pg.Pool, userId: string, b: { jobId: string }) {
  return inTransaction(db, async (c) => {
    const r = await c.query(
      `insert into tracker_entry(candidate_user_id, job_id, route, origin, stage) values ($1, $2::bigint, 'redirect', 'mark_applied', 'applied')
       on conflict (candidate_user_id, job_id) do nothing`, [userId, b.jobId]);
    await c.query(
      `update apply_click set status = 'yes', times_asked = least(times_asked + 1, $3), answered_at = now()
       where candidate_user_id = $1 and job_id = $2::bigint and status in ('pending', 'not_yet')`, [userId, b.jobId, MAX_ASKS]);
    return { ok: true, created: r.rowCount === 1 };
  });
}

export const checkStage = (b: unknown): { jobId: string; stage: (typeof STAGES)[number] } | null =>
  isObject(b) && only(b, ["jobId", "stage"]) && validId(b.jobId) && typeof b.stage === "string" && (STAGES as readonly string[]).includes(b.stage)
    ? { jobId: b.jobId, stage: b.stage as (typeof STAGES)[number] } : null;

/** A stage the table allows for this row's route (a redirect row: applied, interview, offer, rejected, withdrawn; an on-site row: only withdrawn, by the tracker guard). */
export async function setStage(db: pg.Pool, userId: string, b: { jobId: string; stage: string }) {
  const r = await db.query("update tracker_entry set stage = $3, updated_at = now() where candidate_user_id = $1 and job_id = $2::bigint", [userId, b.jobId, b.stage]);
  if (!r.rowCount) throw new Refuse(404, "NOT_TRACKED");
  return { ok: true, offerHint: b.stage === "offer" }; // #86: "Got an offer? We can handle your permit"
}

/** B31 (#86): everything the candidate tracks, newest change first, at most 200 rows (`count` is the number tracked in all). A job that is no longer live
 *  shows only title, employer and reason, as in the saved list; route, stage and updatedAt always stay. Stages: redirect applied, interview, offer,
 *  rejected, withdrawn; on site applied, viewed, shortlisted, rejected, offer, hired, withdrawn. One statement on the (candidate, job) key. */
export async function listTracker(db: pg.Pool, userId: string) {
  const r = await db.query(
    `select ${CARD}, ${LIVE} as live, ${REASON}, t.route, t.stage, t.updated_at as "updatedAt", count(*) over ()::int as count
     from tracker_entry t join job j on j.id = t.job_id where t.candidate_user_id = $1 order by t.updated_at desc, t.id desc limit 200`, [userId]);
  const count: number = r.rows[0]?.count ?? 0;
  const tracker = r.rows.map((x) => { delete x.count; return { ...stripIfClosed(x), route: x.route, stage: x.stage, updatedAt: x.updatedAt }; });
  return { tracker, count };
}

// ===== one saved or tracked job, even when closed (#57, D4) =====
const SIMILAR = 5;
export const LIVE_SIMILAR = 6; // S9: "more jobs like this" under a live job
export const similarSql = (occ: boolean, limit = SIMILAR) =>
  `select ${SMALL} from job j ${SMALL_JOIN} where j.status = 'live' and j.closes_at > now() and j.sector = $1 and j.id <> $2::bigint ${occ ? "and j.occupation_code = $3" : ""}
   order by (not j.quota_full) desc, j.posted_at desc, j.id desc limit ${limit}`;
// The live jobs of the same occupation, else of the same sector, newest first (full-quota last, as on the site; the sector index serves this order). Never the job itself.
async function similarTo(db: pg.Pool, id: string, sector: string | null, occupationCode: string | null, limit = SIMILAR) {
  const similar = (occ: boolean) => db.query(similarSql(occ, limit), occ ? [sector, id, occupationCode] : [sector, id]);
  let s = occupationCode ? await similar(true) : null;
  if (!s?.rowCount) s = await similar(false);
  return priced(db, s.rows);
}
/** S9: up to 6 live jobs like a live job, public cards only. null (404) when the id is bad or the job is not live. */
export async function similarLiveJobs(db: pg.Pool, id: string) {
  if (!validId(id)) return null;
  const j = (await db.query(`select j.sector, j.occupation_code as "occupationCode" from job j where j.id = $1::bigint and ${LIVE}`, [id])).rows[0];
  return j ? { jobs: await similarTo(db, id, j.sector, j.occupationCode, LIVE_SIMILAR) } : null;
}
/** B27 (#57, #227 D4, S20): the closed-job page for anyone with the link. Only a job closed by its employer or by the day-30 run (close_reason closed or expired);
 *  a hidden, under review, removed, draft or live job, an unknown id or a bad id is null (404). Title, employer and county only, plus up to 5 live jobs like it. */
export const CLOSED_JOB_SQL =
  `select j.id::text as "jobId", j.title, j.employer_name as "employerName", j.county, j.close_reason as reason, j.closed_at as "closedAt", j.sector, j.occupation_code as "occupationCode"
   from job j where j.id = $1::bigint and j.status = 'closed' and j.close_reason in ('closed','expired')`;
export async function closedJob(db: pg.Pool, id: string) {
  if (!validId(id)) return null;
  const j = (await db.query(CLOSED_JOB_SQL, [id])).rows[0];
  if (!j) return null;
  const { sector, occupationCode, ...job } = j;
  return { closed: true as const, reason: job.reason as "closed" | "expired", job, similar: await similarTo(db, id, sector, occupationCode) };
}
export async function savedJob(db: pg.Pool, userId: string, url: URL) {
  const id = url.searchParams.get("id");
  if (!validId(id)) throw new Refuse(400, "BAD_REQUEST");
  const r = await db.query(
    `select ${SMALL}, j.sector, j.occupation_code as "occupationCode", j.own_page_url as "ownPageUrl", ${LIVE} as live, ${REASON}, j.closed_at as "closedAt",
       (s.id is not null) as saved, t.stage
     from job j ${SMALL_JOIN} left join saved_job s on s.candidate_user_id = $1 and s.job_id = j.id left join tracker_entry t on t.candidate_user_id = $1 and t.job_id = j.id
     where j.id = $2::bigint and (s.id is not null or t.id is not null)`, [userId, id]);
  const j = (await priced(db, r.rows))[0];
  if (!j) throw new Refuse(404, "JOB_NOT_FOUND"); // not the candidate's own, whatever the job is
  const { sector, occupationCode, ownPageUrl, closedAt, ...card } = j;
  if (j.live) return { job: { ...card, ownPageUrl, saved: j.saved, stage: j.stage } };
  return { job: { ...stripIfClosed(card), closedAt, saved: j.saved, stage: j.stage }, similar: await similarTo(db, id, sector, occupationCode) };
}

// ===== notification settings (D3) =====
// One switch per category, for the email channel. The account category (security and service messages) is always on.
export const CATEGORIES = ["job_alerts", "account"] as const; // apply_reminders dropped (#260, 0049): no "Did you apply?" email
export const checkSettings = (b: unknown): Record<string, boolean> | null => {
  if (!isObject(b) || !only(b, CATEGORIES) || !Object.keys(b).length) return null;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(b)) if (typeof v === "boolean") out[k] = v; else return null;
  return out.account === false ? null : out;
};

export async function getSettings(db: pg.Pool, userId: string) {
  const r = await db.query("select category, enabled from candidate_notification_preference where candidate_user_id = $1 and channel = 'email'", [userId]);
  const set = new Map(r.rows.map((x) => [x.category as string, x.enabled as boolean]));
  return { settings: Object.fromEntries(CATEGORIES.map((k) => [k, k === "account" ? true : (set.get(k) ?? true)])) };
}
export async function putSettings(db: pg.Pool, userId: string, s: Record<string, boolean>) {
  const keys = Object.keys(s);
  await db.query(
    `insert into candidate_notification_preference(candidate_user_id, category, channel, enabled) select $1, k, 'email', v from unnest($2::text[], $3::boolean[]) as t(k, v)
     on conflict (candidate_user_id, category, channel) where candidate_user_id is not null do update set enabled = excluded.enabled`, [userId, keys, keys.map((k) => s[k])]);
  return getSettings(db, userId);
}

/** B41: who accessed or received this candidate's data (the same list as the export's `whoAccessedOrReceivedYourData`: an organisation's name, "Portal staff"
 *  or "Portal system", the action and the time), newest first, at most 200. Never an id or a staff name; an access the candidate made themselves is not in it.
 *  Launch B writes the rows, so it is empty at Launch A. ponytail: runs the export's private function (migration 0025) and keeps one key, no new migration;
 *  a dedicated function with a SQL limit if the other two lists grow. */
export async function dataAccessLog(db: pg.Pool, userId: string) {
  const r = await db.query("select private.candidate_export_extras($1) -> 'whoAccessedOrReceivedYourData' as log", [userId]);
  return { log: (r.rows[0].log as { by: string; action: string; at: string }[]).slice(0, 200) };
}

/** B40: when the password last changed (null for a login with no password, Google only) and the sign-in methods on the account (`credential`, `google`).
 *  Better Auth stamps `candidate_account.updated_at` when the password is changed or reset. */
export async function getSecurity(db: pg.Pool, userId: string) {
  const r = await db.query(
    `select (select a.updated_at from candidate_account a where a.user_id = $1 and a.provider_id = 'credential') as "passwordChangedAt",
            (select coalesce(array_agg(distinct a.provider_id order by a.provider_id), '{}') from candidate_account a where a.user_id = $1) as "signInMethods"`, [userId]);
  return r.rows[0] as { passwordChangedAt: Date | null; signInMethods: string[] };
}

// ===== delete the account (D2) =====
export const checkDelete = (b: unknown): { confirm: true } | null => (isObject(b) && only(b, ["confirm"]) && b.confirm === true ? { confirm: true } : null);

/** Final at once: the login is refused from now on, every session ends, one confirmation email is queued (nothing is sent here). The data goes with the
 *  30-day retention rule. The address is copied into the row because the sender looks addresses up only for logins that are not deleted. */
export async function deleteAccount(db: pg.Pool, userId: string) {
  return inTransaction(db, async (c) => {
    const r = await c.query("update candidate_user set deleted_at = now(), updated_at = now() where id = $1 and deleted_at is null", [userId]);
    if (!r.rowCount) throw new Refuse(403, "REFUSED");
    await c.query("delete from candidate_session where user_id = $1", [userId]);
    await c.query(
      `insert into email_outbox(template, candidate_user_id, params, dedupe_key) select 'account_deleted', u.id, jsonb_build_object('email', u.email), 'account_deleted:' || u.id
       from candidate_user u where u.id = $1 on conflict do nothing`, [userId]);
    return { ok: true };
  });
}

// ===== the data export (GDPR access and portability, 20d line 154) =====
// Two statements: EXPORT_SQL (the tables app_candidate may read, and the audit row of this export) and private.candidate_export_extras (migration 0025: the
// candidate's emails, their own actions and who accessed their data, which app_candidate cannot select). The extras run second, so this export is in "your actions".
// Applications and contact requests are Launch B: the candidate role cannot create either at Launch A, so they are empty lists.
export const exportFilename = (now: Date) => `my-data-${now.toISOString().slice(0, 10)}.json`;
// Still truly missing: the candidate role may read neither table (select on id only). Named, not shown as empty lists, which would be untrue.
const NOT_INCLUDED = ["contactFormMessages", "reportsYouMade"].map((section) => ({
  section, reason: "not available in this file yet; ask for it through the contact form (topic: data request)",
}));
const list = (select: string, from: string, order: string) => `(select coalesce(jsonb_agg(to_jsonb(t) order by ${order}), '[]') from (select ${select} from ${from}) t)`;
// Every statement part filters by $1, the signed-in candidate. Left out on purpose: password and token columns, unsubscribe tokens, dedupe keys, storage keys.
// servicesCases: the candidate's own permit services cases (G1, 20d right of access), each with its timeline through the candidate's wrapper (0061):
// at, kind, status and codes only, never a staff id, name or note; exportData adds the labels, and the firm only when REFERRAL_FIRM_SHOWN ($2).
export const EXPORT_SQL = `with logged as (
  insert into audit_event(kind, actor_candidate_user_id, action, object_type, object_id, subject_candidate_user_id, source)
  values ('data_access', $1, 'candidate.export', 'candidate_user', $1, $1, 'site') returning 1)
select (select count(*) from logged) as logged, jsonb_build_object(
  'account', (select jsonb_build_object('name', u.name, 'email', u.email, 'emailConfirmed', u.email_verified, 'createdAt', u.created_at, 'lastActiveAt', u.last_active_at,
      'signInMethods', (select coalesce(jsonb_agg(distinct a.provider_id), '[]') from candidate_account a where a.user_id = u.id)) from candidate_user u where u.id = $1),
  'profile', (select to_jsonb(t) from (select ${SELECT_PROFILE}, visible_to_employers as "visibleToEmployers", visible_fields as "visibleFields" from candidate_profile where candidate_user_id = $1) t),
  'cv', ${list('c.file_name as "fileName", c.content_type as "contentType", c.size_bytes as "sizeBytes", c.uploaded_at as "uploadedAt"', "candidate_cv c where c.candidate_user_id = $1", '"uploadedAt"')},
  'savedJobs', ${list('j.id::text as "jobId", j.title, j.employer_name as "employerName", s.created_at as "savedAt"', "saved_job s join job j on j.id = s.job_id where s.candidate_user_id = $1", '"savedAt" desc')},
  'tracker', ${list('j.id::text as "jobId", j.title, j.employer_name as "employerName", t.route, t.origin, t.stage, t.updated_at as "updatedAt"', "tracker_entry t join job j on j.id = t.job_id where t.candidate_user_id = $1", '"updatedAt" desc')},
  'didYouApply', ${list('k.id::text as "clickId", j.id::text as "jobId", j.title, j.employer_name as "employerName", k.clicked_at as "clickedAt", k.status, k.times_asked as "timesAsked", k.answered_at as "answeredAt"', "apply_click k join job j on j.id = k.job_id where k.candidate_user_id = $1", '"clickedAt" desc')},
  'alerts', ${list('a.id::text as id, a.occupation_code as "occupationCode", a.sector, a.county, a.badge, a.salary_min as "salaryMin", a.search_text as "searchText", a.frequency, a.status, a.pause_reason as "pauseReason", a.created_at as "createdAt", a.last_sent_at as "lastSentAt"', "alert a where a.candidate_user_id = $1", "id::bigint")},
  'consents', ${list('x.purpose, x.version as "textVersion", c.given_at as "givenAt", c.withdrawn_at as "withdrawnAt", c.details, o.display_name as "organisation"', "candidate_consent_record c join consent_text x on x.id = c.consent_text_id left join organisation o on o.id = c.organisation_id where c.candidate_user_id = $1", '"givenAt"')},
  'notificationSettings', ${list("p.category, p.channel, p.enabled", "candidate_notification_preference p where p.candidate_user_id = $1", "category, channel")},
  'notifications', ${list('n.category, n.template_key as "templateKey", n.params, n.created_at as "createdAt", n.read_at as "readAt"', "candidate_notification n where n.candidate_user_id = $1", '"createdAt" desc')},
  'documentsYouUploaded', ${list('d.services_case_id::text as "caseId", d.file_name as "fileName", d.content_type as "contentType", d.byte_size as "byteSize", d.uploaded_at as "uploadedAt", d.copy_deleted_at as "copyDeletedAt"', "candidate_case_document d where d.candidate_user_id = $1", '"uploadedAt" desc')},
  'servicesCases', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id::text, 'permitType', c.permit_type, 'jobId', c.job_id::text, 'jobTitle', j.title, 'status', c.status,
      'decisionOutcome', c.decision_outcome, 'documentsNeeded', to_jsonb(c.documents_needed), 'payer', c.payer, 'createdAt', c.created_at, 'decidedAt', c.decided_at,
      'closedAt', c.closed_at, 'closeReason', c.close_reason, 'offerDetails', c.offer_details,
      'firm', case when $2::boolean then private.candidate_case_referral_firm($1, c.id) end,
      'events', (select coalesce(jsonb_agg(jsonb_build_object('at', t.at, 'kind', t.kind, 'status', t.status, 'detail', t.detail)), '[]') from private.candidate_case_timeline($1, c.id) t))
      order by c.created_at desc, c.id desc), '[]') from candidate_services_case c left join job j on j.id = c.job_id where c.candidate_user_id = $1),
  'applications', '[]'::jsonb, 'contactRequests', '[]'::jsonb) as data`;
type ExportCase = { firm: string | null; events: Parameters<typeof timelineEvents>[0]; documentsNeeded: string[] } & Record<string, unknown>;
export async function exportData(db: Pick<pg.Pool, "query">, userId: string) {
  const r = await db.query(EXPORT_SQL, [userId, REFERRAL_FIRM_SHOWN]);
  const data = r.rows[0].data;
  data.servicesCases = data.servicesCases.map(({ firm, events, documentsNeeded, ...c }: ExportCase) =>
    ({ ...c, documentsNeeded: documentLabels(documentsNeeded), timeline: timelineEvents(events, firm) }));
  const x = await db.query("select private.candidate_export_extras($1) as extras", [userId]);
  return { exportedAt: new Date().toISOString(), ...data, ...x.rows[0].extras, notIncluded: NOT_INCLUDED };
}
