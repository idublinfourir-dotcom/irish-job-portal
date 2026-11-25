// Employer and agency job posting (#224 to #227, #44, #48, #49): post (draft or live), edit, renew, close, and the company's own list.
// The acting login and its membership always come from the session, never the body. The rules package runs the same checks as on fetched
// adverts, on the structured fields the employer typed; the database has the last word (job_guard, signer_check, job_org_live, the deferred
// statement check). There is no row level security: every read and write here is filtered by the login's own company.
import { freshRules, getPool, getRules, listAnswer, validId } from "@portal/db";
import { suggestCodes } from "@portal/matcher/rules";
import { assess, chainRules, CONDITIONS, isSoc2010, minimumForHours, offScale, scamPhrase, socTitle, type RulesSnapshot } from "@portal/rules";
import type pg from "pg";
import { isObject, no, ok, only, portalLogin, readPost, withinLimit, type Refusal } from "./company";

export const JOBS_RATE = { windowMs: 10 * 60_000, max: 30 }; // posts, edits, renewals and closes together, per login
export const CHECK_RATE = { windowMs: 10 * 60_000, max: 120 }; // dry-run rule checks, per login (the form calls it while the employer types)
export const MAX_JOB_BODY = 24_000; // characters: a 10,000-character advert with its JSON escaping and the other fields
const MAX_PAY = 1_000_000;

// The 26 counties of the Republic (the same list as packages/fetcher/src/county.ts, which does not export it).
export const COUNTIES = [
  "Carlow", "Cavan", "Clare", "Cork", "Donegal", "Dublin", "Galway", "Kerry", "Kildare", "Kilkenny", "Laois", "Leitrim", "Limerick",
  "Longford", "Louth", "Mayo", "Meath", "Monaghan", "Offaly", "Roscommon", "Sligo", "Tipperary", "Waterford", "Westmeath", "Wexford", "Wicklow",
] as const;

// DETE's minimums assume a 39-hour week: minimumForHours (packages/rules/src/thresholds.ts) applies the hourly rate over 39 hours.
export { minimumForHours };

// ===== the body
export type Statement = { signerName: string; signerTitle: string; writtenAuthority: boolean };
export type Post = {
  status: "draft" | "live"; title: string; description: string; county: (typeof COUNTIES)[number]; occupationCode: string;
  contractType: "permanent" | "fixed_term"; contractMonths: number | null; salaryLow: number | null; salaryHigh: number | null;
  payGrade: string | null; healthInsuranceEur: number | null; weeklyHours: number; ownPageUrl: string; clientName: string | null; statement: Statement | null;
  permitType: "critical_skills" | "general";
  /** The employer ticked the exception wording of an Ineligible entry ("with the exception of ...") or a CONDITIONS entry. Stored on the job (exception_confirmed_at) when the rules pass with it. */
  exceptionConfirmed: boolean;
};
const POST_KEYS = ["status", "title", "description", "county", "occupationCode", "contractType", "contractMonths", "salaryLow", "salaryHigh", "payGrade",
  "healthInsuranceEur", "weeklyHours", "ownPageUrl", "clientName", "statement", "permitType", "exceptionConfirmed"];

const BAD_LINE = /[\p{Cc}\p{Cf}]/u; // one line: no control or format characters (right-to-left overrides and zero-width characters included)
const BAD_TEXT = /[\p{Cf}]|[^\P{Cc}\n\r\t]/u; // a text: line breaks and tabs allowed
const line = (v: unknown, min: number, max: number) => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= min && t.length <= max && !BAD_LINE.test(t) ? t : null;
};
const int = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);
const opt = <T>(v: unknown, f: (x: unknown) => T | null): T | null | undefined => (v === undefined || v === null ? null : (f(v) ?? undefined));

function checkStatement(b: unknown): Statement | null {
  if (!isObject(b) || !only(b, ["signerName", "signerTitle", "writtenAuthority"])) return null;
  const signerName = line(b.signerName, 2, 120), signerTitle = line(b.signerTitle, 2, 120);
  if (!signerName || !signerTitle || (b.writtenAuthority !== undefined && typeof b.writtenAuthority !== "boolean")) return null;
  return { signerName, signerTitle, writtenAuthority: b.writtenAuthority === true };
}
export function checkUrl(v: unknown): string | null {
  const s = line(v, 10, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".") ? s : null;
  } catch { return null; }
}

/** Checks a post body: every field known and in range, hostile text refused. Pure. */
export function checkPost(b: unknown, keys = POST_KEYS): Post | null {
  if (!isObject(b) || !only(b, keys)) return null;
  const status = b.status, contractType = b.contractType;
  if (status !== "draft" && status !== "live") return null;
  if (contractType !== "permanent" && contractType !== "fixed_term") return null;
  const title = line(b.title, 2, 200), ownPageUrl = checkUrl(b.ownPageUrl);
  const description = typeof b.description === "string" ? b.description.trim() : "";
  if (!title || !ownPageUrl || description.length < 20 || description.length > 10_000 || BAD_TEXT.test(description)) return null;
  const county = COUNTIES.find((c) => c === b.county);
  const occupationCode = isSoc2010(b.occupationCode) ? b.occupationCode : null;
  if (!county || !occupationCode) return null;
  const contractMonths = opt(b.contractMonths, (v) => int(v, 1, 600));
  if (contractMonths === undefined || (contractType === "fixed_term") !== (contractMonths !== null)) return null;
  const salaryLow = opt(b.salaryLow, (v) => int(v, 1, MAX_PAY)), salaryHigh = opt(b.salaryHigh, (v) => int(v, 1, MAX_PAY));
  const payGrade = opt(b.payGrade, (v) => line(v, 1, 100)), healthInsuranceEur = opt(b.healthInsuranceEur, (v) => int(v, 0, 50_000));
  const weeklyHours = b.weeklyHours === undefined ? 39 : int(b.weeklyHours, 1, 60);
  const clientName = opt(b.clientName, (v) => line(v, 2, 160));
  const statement = opt(b.statement, checkStatement);
  const permitType = b.permitType === undefined ? "critical_skills" : b.permitType;
  if ((permitType !== "critical_skills" && permitType !== "general") || (b.exceptionConfirmed !== undefined && typeof b.exceptionConfirmed !== "boolean")) return null;
  if (salaryLow === undefined || salaryHigh === undefined || payGrade === undefined || healthInsuranceEur === undefined || weeklyHours === null
    || clientName === undefined || statement === undefined) return null;
  if (salaryLow === null && (salaryHigh !== null || payGrade === null)) return null; // pay or a public pay grade; a top needs a bottom
  if (salaryHigh !== null && salaryLow !== null && salaryHigh < salaryLow) return null;
  return { status, title, description, county, occupationCode, contractType, contractMonths, salaryLow, salaryHigh, payGrade, healthInsuranceEur,
    weeklyHours, ownPageUrl, clientName, statement, permitType, exceptionConfirmed: b.exceptionConfirmed === true };
}

/** A draft being worked on (B49): only the title is required, every other field may be missing, but one that is given is checked as in a live post. */
export type Draft = Omit<Post, "county" | "occupationCode" | "contractType" | "ownPageUrl"> & {
  status: "draft"; county: Post["county"] | null; occupationCode: string | null; contractType: Post["contractType"] | null; ownPageUrl: string | null;
};
export function checkDraft(b: unknown): Draft | null {
  if (!isObject(b) || !only(b, POST_KEYS) || b.status !== "draft") return null;
  const title = line(b.title, 2, 200);
  const text = b.description === undefined || b.description === null ? "" : typeof b.description === "string" ? b.description.trim() : null;
  if (!title || text === null || text.length > 10_000 || BAD_TEXT.test(text)) return null;
  const county = opt(b.county, (v) => COUNTIES.find((c) => c === v) ?? null), occupationCode = opt(b.occupationCode, (v) => (isSoc2010(v) ? v : null));
  const contractType = opt(b.contractType, (v) => (v === "permanent" || v === "fixed_term" ? v : null)), contractMonths = opt(b.contractMonths, (v) => int(v, 1, 600));
  const salaryLow = opt(b.salaryLow, (v) => int(v, 1, MAX_PAY)), salaryHigh = opt(b.salaryHigh, (v) => int(v, 1, MAX_PAY));
  const payGrade = opt(b.payGrade, (v) => line(v, 1, 100)), healthInsuranceEur = opt(b.healthInsuranceEur, (v) => int(v, 0, 50_000));
  const weeklyHours = b.weeklyHours === undefined ? 39 : int(b.weeklyHours, 1, 60);
  const ownPageUrl = opt(b.ownPageUrl, checkUrl), clientName = opt(b.clientName, (v) => line(v, 2, 160)), statement = opt(b.statement, checkStatement);
  const permitType = b.permitType === undefined ? "critical_skills" : b.permitType;
  if ((permitType !== "critical_skills" && permitType !== "general") || (b.exceptionConfirmed !== undefined && typeof b.exceptionConfirmed !== "boolean")) return null;
  if (county === undefined || occupationCode === undefined || contractType === undefined || contractMonths === undefined || salaryLow === undefined || salaryHigh === undefined
    || payGrade === undefined || healthInsuranceEur === undefined || weeklyHours === null || ownPageUrl === undefined || clientName === undefined || statement === undefined) return null;
  if (contractType === "permanent" && contractMonths !== null) return null;
  if (salaryLow === null && salaryHigh !== null) return null;
  if (salaryHigh !== null && salaryLow !== null && salaryHigh < salaryLow) return null;
  return { status: "draft", title, description: text, county, occupationCode, contractType, contractMonths, salaryLow, salaryHigh, payGrade, healthInsuranceEur, weeklyHours,
    ownPageUrl, clientName, statement, permitType, exceptionConfirmed: b.exceptionConfirmed === true };
}
/** A post or edit body: a draft is checked loosely, anything else as a live post. */
export const checkBody = (b: unknown): Post | Draft | null => (isObject(b) && b.status === "draft" ? checkDraft(b) : checkPost(b));
/** A body that carries every field a live post needs (a draft that has them all is one too). */
export const isFull = (p: Post | Draft): p is Post => p.county !== null && p.occupationCode !== null && p.contractType !== null && p.ownPageUrl !== null;

const id = (v: unknown) => (validId(v) ? v : null);
export function checkEdit(b: unknown): ((Post | Draft) & { jobId: string }) | null {
  if (!isObject(b)) return null;
  const jobId = id(b.jobId);
  const post = checkBody(Object.fromEntries(Object.entries(b).filter(([k]) => k !== "jobId")));
  return jobId && post ? { ...post, jobId } : null;
}
export type Hire = "yes" | "no";
function checkHire(b: unknown, keys: string[]): { jobId: string; hireAnswer: Hire | null } | null {
  if (!isObject(b) || !only(b, keys)) return null;
  const jobId = id(b.jobId), h = b.hireAnswer;
  if (!jobId || (h !== undefined && h !== "yes" && h !== "no")) return null;
  return { jobId, hireAnswer: h ?? null };
}
/** The renewal body: the job, the optional hire answer (#49) and the optional exception tick, asked again when the role is an Ineligible entry with an exception. */
export function checkRenew(b: unknown): { jobId: string; hireAnswer: Hire | null; exceptionConfirmed: boolean } | null {
  const r = checkHire(b, ["jobId", "hireAnswer", "exceptionConfirmed"]);
  const e = (b as { exceptionConfirmed?: unknown } | null)?.exceptionConfirmed;
  return r && (e === undefined || typeof e === "boolean") ? { ...r, exceptionConfirmed: e === true } : null;
}
/** The close body: the job and "Did you hire someone through us?" (#49). The answer is needed to close a job past draft; a draft close skips the question (B52), so the check cannot tell and the route decides. */
export const checkClose = (b: unknown) => checkHire(b, ["jobId", "hireAnswer"]);

// ===== the rules
// CONDITIONS (the role conditions a code carries, P6) live in @portal/rules so the public job read can show them too.
export { CONDITIONS };
/** `ticked`: the pass needed the exception tick (the job stores it, so a renewal does not ask again). */
export type Verdict = { ok: true; passRoute: "stated_pay" | "public_pay"; status: "live" | "in_review"; sector: string; stage: string; ticked: boolean }
  | { ok: false; code: string; stage?: string; exception?: string };
/** One line of the rules for the posting form (B50). `blocked` carries the refusal `code`; `note` passes but needs a look; `detail` holds facts, no wording. */
export type Check = { id: string; state: "pass" | "note" | "blocked"; code?: string; detail: Record<string, unknown> };

/**
 * The rules on the structured fields: the occupation list, the contract, the rules chain (Ireland, "no sponsorship", Irish employer, contract text, scam wording), then the pay.
 * A General Employment Permit post (4.2): no occupation list or contract length, a quota check, the General minimum (a lower rate for some codes), stated pay only,
 * and the sponsorship statement always. The General figures are optional in the minimums, so a version without them refuses with GENERAL_RULES_NOT_SET.
 * `rules`: the minimums and lists in force (#229, `getRules(db)` from the database); the DETE names are not loaded: the chain uses them only for LinkedIn adverts (assess.ts, `known`).
 * Returns every check in order. With `all` false it stops at the first blocked one (a save: the verdict is that check's code); with `all` true it runs them all (the posting form's list).
 * The verdict is always the first blocked check, so both modes give the same answer.
 */
export async function evaluate(p: Post, employerName: string, r: RulesSnapshot, all = false): Promise<{ checks: Check[]; verdict: Verdict }> {
  const m = r.minimums;
  const general = p.permitType === "general";
  const checks: Check[] = [];
  const add = (id: string, state: Check["state"], detail: Record<string, unknown>, code?: string) => { checks.push({ id, state, ...(code ? { code } : {}), detail }); };
  const stop = () => !all && checks.some((c) => c.state === "blocked");
  let ticked = false, passRoute: "stated_pay" | "public_pay" | undefined;
  const done = (a?: Awaited<ReturnType<typeof assess>>): { checks: Check[]; verdict: Verdict } => {
    const b = checks.find((c) => c.state === "blocked");
    if (b) {
      const { stage, exception } = b.detail as { stage?: string; exception?: string };
      return { checks, verdict: { ok: false, code: b.code!, ...(stage ? { stage } : {}), ...(exception ? { exception } : {}) } };
    }
    return { checks, verdict: { ok: true, passRoute: passRoute!, status: a!.bucket === "queue" || a!.scamFlag ? "in_review" : "live", sector: a!.sector, stage: a!.stage, ticked } };
  };
  if (general && (m.general === undefined || m.generalLower === undefined || !m.generalLowerCodes || !m.generalQuotaFullCodes)) {
    add("permit_rules", "blocked", {}, "GENERAL_RULES_NOT_SET");
    return done();
  }
  const onList = listAnswer(r.occupationLists, p.occupationCode);
  const listStatus = onList === "yes" ? "critical_skills" : onList === "no" ? "ineligible" : "not_listed";
  // an Ineligible entry that names an exception passes when the employer confirmed they meet it; the reply carries the wording so the page can show it
  const title = r.occupationLists.find((e) => e.code === p.occupationCode && e.list === "ineligible")?.title;
  const exception = onList === "no" && title?.includes("with the exception of") ? title : undefined;
  if (onList === "no" && !exception) add("occupation", "blocked", { code: p.occupationCode, listStatus }, "OCCUPATION_INELIGIBLE");
  else add("occupation", onList === "no" ? "note" : "pass", { code: p.occupationCode, listStatus });
  if (stop()) return done();
  const condition = exception ?? CONDITIONS[p.occupationCode];
  if (condition) {
    ticked = p.exceptionConfirmed;
    add("condition", ticked ? "pass" : "blocked", { exception: condition, confirmed: ticked }, ticked ? undefined : "OCCUPATION_INELIGIBLE");
  }
  if (stop()) return done();
  if (general) add("quota", m.generalQuotaFullCodes!.includes(p.occupationCode) ? "blocked" : "pass", { full: m.generalQuotaFullCodes!.includes(p.occupationCode) }, // #85: a full quota blocks new postings
    m.generalQuotaFullCodes!.includes(p.occupationCode) ? "QUOTA_FULL" : undefined);
  else {
    if (onList === null) add("list", m.nonListRoute ? "note" : "blocked", { listStatus, nonListRoute: !!m.nonListRoute }, m.nonListRoute ? undefined : "OCCUPATION_NOT_ON_LIST");
    if (stop()) return done();
    // a Critical Skills post needs a contract of at least 2 years (#32); a General post has no minimum length
    const short = p.contractType === "fixed_term" && p.contractMonths! < m.minContractMonths;
    add("contract", short ? "blocked" : "pass", { months: p.contractMonths, minimumMonths: m.minContractMonths }, short ? "CONTRACT_TOO_SHORT" : undefined);
  }
  if (stop()) return done();
  // ponytail: for a General post the chain's text reader gets a 1-month minimum, so "6 months" in the advert is not "short" (maternity, intern and temporary wording still stop it)
  const chain = chainRules(r);
  if (general) chain.minimums = { ...m, minContractMonths: 1 };
  const a = await assess(
    { source: "employer", employer: employerName, title: p.title, location: `${p.county}, Ireland`, description: p.description, employmentType: "", salaryBox: "" },
    { deteNames: new Set(), ...chain, matcher: async () => ({ occupationCode: p.occupationCode, onCriticalSkillsList: "yes", confidence: "high" }) },
    // The contract is stated in its own fields (checked above), so the chain's "contract unclear" stops do not apply; a short contract in the text still fails.
    { contractConfirmed: true, ...(p.salaryLow !== null ? { salary: { low: p.salaryLow, high: p.salaryHigh ?? p.salaryLow } } : {}) },
  );
  const failed = a.bucket === "rejected" && !a.stage.startsWith("8 ");
  add("wording", failed ? "blocked" : a.bucket === "queue" ? "note" : "pass", { stage: a.stage }, failed ? "RULES_FAILED" : undefined);
  const phrase = scamPhrase(p.description); // asks the candidate for money: not a block, the job goes to a staff check (#244, #287)
  add("money", phrase ? "note" : "pass", phrase ? { phrase } : {});
  if (stop()) return done(a);
  // Pay: the top of a range counts (#66), with employer-paid health insurance (#68), against the minimum for the stated hours. Compared with >=:
  // DETE's page says "over 68,911" and its checklist "is 68,911 or more"; we follow the checklist.
  // #225 (step9/dete-thresholds-research.md): a role not on the Critical Skills list and not Ineligible qualifies at the non-list minimum.
  // General: the lower rate covers code 6145 only (ponytail: meat processor and horticulture sit inside 8111 and 9119, which also hold standard-rate roles; add per-entry rates if those sectors are posted).
  const base = general ? (m.generalLowerCodes!.includes(p.occupationCode) ? m.generalLower! : m.general!) : onList === "yes" ? m.criticalSkills : m.nonList;
  const minimum = minimumForHours(base, p.weeklyHours, m.standardWeekHours);
  const pay = p.salaryLow === null ? null : (p.salaryHigh ?? p.salaryLow) + (p.healthInsuranceEur ?? 0);
  let payCode: string | undefined;
  if (pay !== null && pay >= minimum) passRoute = "stated_pay";
  // a public pay-scale employer on a list role (#67), never an agency posting for a client (CF98: the client, not the agency, is the permit employer). With a grade code
  // from the scales in force (#269), stated pay must sit on that grade's scale (any point counts); a grade typed as free text, or no stated pay, passes as before.
  else if (!general && p.clientName === null && a.publicPayTier > 0 && onList === "yes") {
    if (offScale(r, p.payGrade, p.salaryLow, p.salaryHigh)) payCode = "PAY_NOT_ON_SCALE"; else passRoute = "public_pay";
  } else payCode = pay === null ? "PAY_REQUIRED" : "PAY_BELOW_MINIMUM";
  add("pay", payCode ? "blocked" : "pass", { minimumEur: minimum, countedEur: pay, healthInsuranceEur: p.healthInsuranceEur ?? 0, weeklyHours: p.weeklyHours, route: passRoute ?? null }, payCode);
  if (general) add("statement", p.statement ? "pass" : "blocked", { signed: p.statement !== null }, p.statement ? undefined : "STATEMENT_REQUIRED"); // #31: a General job appears only when the employer confirms sponsorship
  return done(a);
}
export async function rulesFor(p: Post, employerName: string, r: RulesSnapshot): Promise<Verdict> {
  return (await evaluate(p, employerName, r)).verdict;
}
export function verdictReply(v: Verdict & { ok: false }): Response {
  return Response.json({ code: v.code, ...(v.stage ? { stage: v.stage } : {}), ...(v.exception ? { exception: v.exception } : {}) }, { status: 422 });
}

// ===== database refusals
// The database's refusals as short codes; any other P0001 is REFUSED (fail closed, no detail).
export function jobRefusal(e: unknown): Refusal | null {
  const { code, message = "" } = (e ?? {}) as { code?: string; message?: string };
  if (code !== "P0001") return null;
  if (message.startsWith("job guard: the portal writes a job only for")) return { status: 403, code: "NOT_A_POSTER" };
  if (message.startsWith("signer refused")) return { status: 403, code: "NOT_A_SIGNER" };
  if (message.startsWith("job guard: sponsor_confirmed is refused")) return { status: 403, code: "BADGE_RESTRICTED" };
  if (message.startsWith("job refused")) return { status: 403, code: "COMPANY_NOT_ACTIVE" };
  if (message.startsWith("job guard: the portal may not move")) return { status: 409, code: "BAD_STATE" };
  if (message.startsWith("job guard: a client not found")) return { status: 409, code: "NEEDS_REVIEW" }; // 0028 (#244 a): a live job names a new client not in the DETE names
  if (message.startsWith("status refused: NOT_A_MEMBER")) return { status: 403, code: "NOT_A_MEMBER" };
  return { status: 403, code: "REFUSED" };
}

// ===== the writes
type Acting = { userId: string; membershipId: number; organisationId: number };
const POSTERS = new Set(["poster", "recruiter", "account_owner"]);

/** The common start of every write: the session, the poster role, the rate limit. Returns the reply to send, or the acting member and the body. */
async function writer<T>(request: Request, check: (b: unknown) => T | null, max?: number, key = "jobs", rate = JOBS_RATE): Promise<Response | { who: Acting; body: T }> {
  const read = await readPost(request, check, max);
  if (read instanceof Response) return read;
  const { login, body } = read;
  if (!login.membership) return no(403, "NOT_A_MEMBER");
  if (!POSTERS.has(login.membership.role)) return no(403, "NOT_A_POSTER");
  if (!(await withinLimit(`${key}:${login.userId}`, rate))) return no(429, "TOO_MANY_REQUESTS");
  return { who: { userId: login.userId, membershipId: login.membership.id, organisationId: login.membership.organisationId }, body };
}

async function inTx(fn: (c: pg.PoolClient) => Promise<Response>): Promise<Response> {
  const c = await getPool().connect();
  try {
    await c.query("begin");
    const r = await fn(c);
    await c.query(r.ok ? "commit" : "rollback");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    const r = jobRefusal(e);
    if (r) return no(r.status, r.code);
    throw e;
  } finally {
    c.release();
  }
}

const ORG = "select display_name, kind from organisation where id = $1";
const TEXT = "select id from consent_text where purpose = 'sponsorship_statement' order by published_at desc, id desc limit 1";
// search_vector is built the way packages/fetcher/src/store.ts builds it: title, employer name and advert text.
const INSERT_JOB =
  "insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, contract_type, contract_months, permit_type, badge, " +
  "salary_low, salary_high, health_insurance_eur, pay_grade, weekly_hours, pass_route, status, closes_at, search_vector, own_page_url, permit_employer_kind, permit_employer_name, posted_by_membership_id, " +
  "exception_confirmed_at) values ($1, $2, (select id from job_source where kind = 'portal' and board = 'employer'), $3::text, $4::text, $5, $6, $7, $8, $9, $23, $10, $11, $12, $13, $14, $15, $16, $17, " +
  "now() + interval '30 days', to_tsvector('english', $3::text || ' ' || $4::text || ' ' || $18::text), $19, $20, $21, $22, case when $24::boolean then now() end) returning id, status, badge, pass_route";
const UPDATE_JOB =
  "update job set title = $3::text, county = $4, sector = $5, occupation_code = $6, contract_type = $7, contract_months = $8, badge = $9, salary_low = $10, salary_high = $11, " +
  "health_insurance_eur = $12, pay_grade = $13, weekly_hours = $14, pass_route = $15, status = $16, own_page_url = $17, permit_employer_kind = $18, permit_employer_name = $19, " +
  "posted_by_membership_id = $20, permit_type = $22, search_vector = to_tsvector('english', $3::text || ' ' || employer_name || ' ' || $21::text), " +
  // $23: the rules ran and needed the tick (kept, or set now), ran without it (cleared), or did not run (null: kept as it is)
  "exception_confirmed_at = case when $23::boolean is null then exception_confirmed_at when $23 then coalesce(exception_confirmed_at, now()) end " +
  "where id = $1 and organisation_id = $2 returning id, status, badge, pass_route";
const UPSERT_TEXT = "insert into job_text(job_id, advert_text) values ($1, $2) on conflict (job_id) do update set advert_text = excluded.advert_text";
const SUPERSEDE = "update sponsorship_statement set superseded_at = now() where job_id = $1 and superseded_at is null";
const INSERT_STATEMENT =
  "insert into sponsorship_statement(job_id, organisation_id, kind, consent_text_id, signer_membership_id, signer_name, signer_title, on_behalf_of_name, written_authority_on_file) " +
  "values ($1, $2, $3, $4, $5, $6, $7, $8, $9)";

/** The statement (the database's signer_check decides who may sign). Inside the caller's transaction. */
async function sign(c: pg.PoolClient, jobId: string, who: Acting, p: Pick<Post, "statement" | "clientName">): Promise<Response | null> {
  const s = p.statement!;
  if (p.clientName && !s.writtenAuthority) return no(400, "WRITTEN_AUTHORITY_REQUIRED"); // on behalf of a client: the client's written authority is on file
  const text = (await c.query(TEXT)).rows[0];
  if (!text) return no(409, "NO_STATEMENT_TEXT");
  await c.query(SUPERSEDE, [jobId]);
  await c.query(INSERT_STATEMENT, [jobId, who.organisationId, p.clientName ? "on_behalf_of_client" : "own_company", text.id, who.membershipId, s.signerName, s.signerTitle,
    p.clientName, p.clientName ? true : false]);
  return null;
}
const jobReply = (r: { id: string; status: string; badge: string | null; pass_route: string | null }) =>
  ok({ jobId: r.id, status: r.status, badge: r.badge, passRoute: r.pass_route });

/** POST /api/portal/jobs: a new job, as a draft (no checks) or live (the rules; a restricted company's job goes to review, #44). */
export async function jobPost(request: Request): Promise<Response> {
  const w = await writer(request, checkBody, MAX_JOB_BODY);
  if (w instanceof Response) return w;
  const { who, body: p } = w;
  return inTx(async (c) => {
    const org = (await c.query(ORG, [who.organisationId])).rows[0] as { display_name: string; kind: string };
    if (p.clientName && org.kind !== "agency") return no(400, "CLIENT_ONLY_FOR_AGENCIES");
    let v: Verdict = { ok: true, passRoute: "stated_pay", status: "live", sector: "other", stage: "", ticked: false };
    if (p.status === "live") {
      v = await rulesFor(p, p.clientName ?? org.display_name, await freshRules(c));
      if (!v.ok) return verdictReply(v);
    }
    const r = (await c.query(INSERT_JOB, [who.organisationId, org.kind === "agency" ? "agency" : "employer", p.title, org.display_name, p.county, v.sector, p.occupationCode,
      p.contractType, p.contractMonths, p.statement ? "sponsor_confirmed" : null, p.salaryLow, p.salaryHigh, p.healthInsuranceEur, p.payGrade, p.weeklyHours,
      p.status === "live" ? v.passRoute : null, p.status === "live" ? v.status : "draft", p.description, p.ownPageUrl, p.clientName ? "client" : "self", p.clientName,
      who.membershipId, p.permitType, v.ticked])).rows[0];
    await c.query(UPSERT_TEXT, [r.id, p.description]);
    if (p.statement) { const refused = await sign(c, String(r.id), who, p); if (refused) return refused; }
    return jobReply(r);
  });
}

const LOCK = "select status, badge, pass_route, sector, permit_type, title, occupation_code, salary_low, salary_high, pay_grade, health_insurance_eur, weekly_hours, " +
  "under_review_reason, contract_type, contract_months, county, permit_employer_kind, permit_employer_name, (select advert_text from job_text where job_id = job.id) as advert_text from job " +
  "where id = $1 and organisation_id = $2 and source in ('employer','agency') for update";

/**
 * POST /api/portal/jobs/edit: the whole post again with its jobId. A draft stays a draft, or goes live with the rules (status "live").
 * On a job past draft the status field does not move it; a change to the pay (salary, grade, health insurance, hours), the title or the
 * occupation runs the rules again and needs a fresh signed statement when the job shows "Sponsor confirmed" (#226); other edits do neither.
 * A job a renewal moved to Under review for a non-pay rule (under_review_reason other than 'pay_check') runs the rules on any edit of a field they
 * read (the advert text, contract, county, client and statement too) and goes live again when they pass, as a pay edit does for 'pay_check' (#93).
 */
export async function jobEdit(request: Request): Promise<Response> {
  const w = await writer(request, checkEdit, MAX_JOB_BODY);
  if (w instanceof Response) return w;
  const { who, body: p } = w;
  return inTx(async (c) => {
    const j = (await c.query(LOCK, [p.jobId, who.organisationId])).rows[0];
    if (!j) return no(404, "JOB_NOT_FOUND"); // another company's job is not found either
    if (j.status === "closed" || j.status === "hidden") return no(409, "BAD_STATE");
    const full = isFull(p) ? p : null; // a loose draft body edits a draft only; a job past draft needs the whole post
    if (!full && j.status !== "draft") return no(400, "BAD_REQUEST");
    const org = (await c.query(ORG, [who.organisationId])).rows[0] as { display_name: string; kind: string };
    if (p.clientName && org.kind !== "agency") return no(400, "CLIENT_ONLY_FOR_AGENCIES");
    const pay = j.salary_low !== p.salaryLow || j.salary_high !== p.salaryHigh || j.pay_grade !== p.payGrade || j.health_insurance_eur !== p.healthInsuranceEur;
    const key = pay || j.title !== p.title || j.occupation_code !== p.occupationCode || j.permit_type !== p.permitType || (j.weekly_hours ?? 39) !== p.weeklyHours;
    const publish = j.status === "draft" && p.status === "live";
    const fix = j.status === "under_review" && j.under_review_reason !== "pay_check" && (key || j.advert_text !== p.description || j.contract_type !== p.contractType
      || j.contract_months !== p.contractMonths || j.county !== p.county || j.permit_employer_kind !== (p.clientName ? "client" : "self")
      || j.permit_employer_name !== p.clientName || (p.statement !== null && j.badge !== "sponsor_confirmed"));
    let status: string = j.status, passRoute = j.pass_route, sector = j.sector, ticked: boolean | null = null;
    if (publish || (j.status !== "draft" && key) || fix) {
      if (!full) return no(400, "BAD_REQUEST"); // not reached: a publish carries every field and a job past draft was checked above
      const v = await rulesFor(full, p.clientName ?? org.display_name, await freshRules(c));
      if (!v.ok) return verdictReply(v);
      if (publish) status = v.status;
      else if (v.status === "in_review" && j.status === "live") return no(409, "NEEDS_REVIEW"); // the guard keeps a live job live or closes it
      // #93: a job under review (the minimums rose) goes live again when its new pay passes; the guard allows that only on a pay change.
      else if (v.status === "live" && j.status === "under_review" && (pay || fix)) status = "live";
      passRoute = v.passRoute; sector = v.sector; ticked = v.ticked;
    }
    if (j.status !== "draft" && key && j.badge === "sponsor_confirmed" && !p.statement) return no(422, "STATEMENT_REQUIRED"); // the same rule refusal as rulesFor gives a General post
    const badge = p.statement ? "sponsor_confirmed" : j.status !== "draft" && key ? null : j.badge;
    const r = (await c.query(UPDATE_JOB, [p.jobId, who.organisationId, p.title, p.county, sector, p.occupationCode, p.contractType, p.contractMonths, badge, p.salaryLow,
      p.salaryHigh, p.healthInsuranceEur, p.payGrade, p.weeklyHours, passRoute, status, p.ownPageUrl, p.clientName ? "client" : "self", p.clientName, who.membershipId,
      p.description, p.permitType, ticked])).rows[0];
    await c.query(UPSERT_TEXT, [p.jobId, p.description]);
    if (p.statement) { const refused = await sign(c, p.jobId, who, p); if (refused) return refused; }
    return jobReply(r);
  });
}

// The live job as the rules read it, locked: its stored fields, its advert text, the company's name and whether a statement is signed.
const RENEW_LOCK =
  "select j.title, j.county, j.occupation_code, j.contract_type, j.contract_months, j.salary_low, j.salary_high, j.pay_grade, j.health_insurance_eur, j.weekly_hours, " +
  "j.own_page_url, j.permit_type, j.permit_employer_kind, j.permit_employer_name, j.exception_confirmed_at is not null as ticked, t.advert_text, o.display_name, " +
  "exists (select 1 from sponsorship_statement s where s.job_id = j.id and s.superseded_at is null) as signed " +
  "from job j join organisation o on o.id = j.organisation_id left join job_text t on t.job_id = j.id " +
  "where j.id = $1 and j.organisation_id = $2 and j.source in ('employer','agency') and j.status = 'live' for update of j";
// $5 'live' renews for 30 days from now; 'under_review' keeps the end date and moves the job to Under review with the rule code $6 as its reason.
// $7 the tick, as on an edit: the rules passed and needed it (kept or set now), passed without it (cleared), or failed (null: kept). The hire answer is kept either way.
const RENEW =
  "update job set status = $5::text, closes_at = case when $5::text = 'live' then now() + interval '30 days' else closes_at end, posted_by_membership_id = $3, " +
  "under_review_reason = $6, exception_confirmed_at = case when $7::boolean is null then exception_confirmed_at when $7 then coalesce(exception_confirmed_at, now()) end, " +
  "hire_answer = coalesce($4, hire_answer), hire_answered_at = case when $4::text is null then hire_answered_at else now() end, " +
  "hire_answered_by_membership_id = case when $4::text is null then hire_answered_by_membership_id else $3 end where id = $1 and organisation_id = $2 returning id, status, closes_at";
/**
 * POST /api/portal/jobs/renew: a live job gets a new 30 days from now (#48), with the optional "Did you hire someone through us?" answer (#49).
 * The rules in force run first (#254): a job that no longer passes, or would now need a staff check, goes to Under review instead (its end date stays),
 * and the reply says why. The exception tick stored at post or edit counts; a job without it whose code now has a condition (the Ineligible list
 * or CONDITIONS changed since it was posted) is asked for it (422 with the wording, nothing moved) and stores it once it passes with it.
 */
export async function jobRenew(request: Request): Promise<Response> {
  const w = await writer(request, checkRenew);
  if (w instanceof Response) return w;
  const { who, body } = w;
  return inTx(async (c) => {
    const j = (await c.query(RENEW_LOCK, [body.jobId, who.organisationId])).rows[0];
    if (!j) return no(404, "JOB_NOT_FOUND");
    const p: Post = { status: "live", title: j.title, description: j.advert_text ?? "", county: j.county, occupationCode: j.occupation_code, contractType: j.contract_type,
      contractMonths: j.contract_months, salaryLow: j.salary_low, salaryHigh: j.salary_high, payGrade: j.pay_grade, healthInsuranceEur: j.health_insurance_eur,
      weeklyHours: j.weekly_hours ?? 39, ownPageUrl: j.own_page_url, clientName: j.permit_employer_kind === "client" ? j.permit_employer_name : null,
      statement: j.signed ? { signerName: "", signerTitle: "", writtenAuthority: false } : null, // rulesFor asks only whether one is signed
      permitType: j.permit_type, exceptionConfirmed: body.exceptionConfirmed || j.ticked };
    const v = await rulesFor(p, p.clientName ?? j.display_name, await freshRules(c));
    if (!v.ok && v.exception && !p.exceptionConfirmed) return verdictReply(v);
    const status = v.ok && v.status === "live" ? "live" : "under_review";
    const reason = status === "live" ? null : v.ok ? "NEEDS_REVIEW" : v.code;
    const r = (await c.query(RENEW, [body.jobId, who.organisationId, who.membershipId, body.hireAnswer, status, reason, v.ok ? v.ticked : null])).rows[0];
    if (status === "live") return ok({ jobId: r.id, status, closesAt: r.closes_at });
    return ok({ jobId: r.id, status, closesAt: r.closes_at, code: reason, ...(!v.ok && v.stage ? { stage: v.stage } : {}) });
  });
}

// A draft was never shown, so it keeps no hire answer (B52); any other job needs one ($4 null refuses the update).
const CLOSE =
  "update job set status = 'closed', closed_at = now(), close_reason = 'closed', posted_by_membership_id = $3::bigint, " +
  "hire_answer = case when status = 'draft' then null else $4::text end, hire_answered_at = case when status = 'draft' then null else now() end, " +
  "hire_answered_by_membership_id = case when status = 'draft' then null else $3::bigint end where id = $1 and organisation_id = $2 and source in ('employer','agency') " +
  "and status in ('draft','in_review','live','under_review') and (status = 'draft' or $4::text is not null) returning id";
/** POST /api/portal/jobs/close: closes the job with the "Did you hire someone through us?" answer (#49); a draft needs none. A closed job never reopens. */
export async function jobClose(request: Request): Promise<Response> {
  const w = await writer(request, checkClose);
  if (w instanceof Response) return w;
  const { who, body } = w;
  return inTx(async (c) => {
    const r = (await c.query(CLOSE, [body.jobId, who.organisationId, who.membershipId, body.hireAnswer])).rows[0];
    if (r) return ok({ jobId: r.id, status: "closed" });
    // no answer and no row: the answer was needed (a bad request, the same for any job, so it says nothing about whose job it is)
    return body.hireAnswer === null ? no(400, "BAD_REQUEST") : no(404, "JOB_NOT_FOUND");
  });
}

/** GET /api/portal/jobs: the company's own jobs, with each one's state and why it is held (#44). Any active member, viewers too; no company is 404 NO_COMPANY. */
export async function jobList(request: Request): Promise<Response> {
  const login = await portalLogin(request);
  if (login instanceof Response) return login;
  if (!login.membership) return no(404, "NO_COMPANY"); // as the company GET
  try {
    return ok({ jobs: (await getPool().query("select private.portal_jobs($1) r", [login.userId])).rows[0].r });
  } catch (e) {
    const r = jobRefusal(e);
    if (r) return no(r.status, r.code);
    throw e;
  }
}

/**
 * POST /api/portal/jobs/check (P4, B50): the post body (every field of a live post, whatever its `status`), checked as a live post would be (the agency and written
 * authority checks, then every rule) and nothing written, so the form can show the whole list while the employer types. The reply keeps its single answer
 * (200 `ok` with the route, or 422 with the first refusal's code) and adds `checks`: every check with its state and facts, the client's DETE match for an agency
 * post included. A client not in the DETE names is a note and turns the answer's status to `in_review`, as a save would.
 */
export async function jobCheck(request: Request): Promise<Response> {
  const w = await writer(request, checkPost, MAX_JOB_BODY, "jobcheck", CHECK_RATE);
  if (w instanceof Response) return w;
  const { who, body: p } = w;
  const db = getPool();
  const org = (await db.query(ORG, [who.organisationId])).rows[0] as { display_name: string; kind: string };
  if (p.clientName && org.kind !== "agency") return no(400, "CLIENT_ONLY_FOR_AGENCIES");
  if (p.clientName && p.statement && !p.statement.writtenAuthority) return no(400, "WRITTEN_AUTHORITY_REQUIRED");
  const { checks, verdict: v } = await evaluate(p, p.clientName ?? org.display_name, await freshRules(db), true);
  let held = false;
  if (p.clientName) {
    const found = (await db.query(CLIENT_KNOWN, [p.clientName])).rows[0].found as boolean;
    held = !found;
    checks.push({ id: "client", state: found ? "pass" : "note", detail: { found } });
  }
  if (!v.ok) return Response.json({ code: v.code, ...(v.stage ? { stage: v.stage } : {}), ...(v.exception ? { exception: v.exception } : {}), checks }, { status: 422 });
  return ok({ ok: true, status: held ? "in_review" : v.status, passRoute: v.passRoute, sector: v.sector, checks });
}

// The same name key job_defaults uses (0008): is the client one of the names DETE (or the register) knows?
const CLIENT_KNOWN = "select exists (select 1 from organisation_name n where n.normalised_name = btrim(regexp_replace(lower($1::text), '[^a-z0-9]+', ' ', 'g'))) as found";

export const ONE_JOB =
  "select j.id, j.status, j.badge, j.pass_route, j.title, t.advert_text, j.county, j.occupation_code, j.contract_type, j.contract_months, j.salary_low, j.salary_high, j.pay_grade, " +
  "j.health_insurance_eur, j.weekly_hours, j.own_page_url, j.permit_employer_kind, j.permit_employer_name, j.permit_type, j.exception_confirmed_at is not null as ticked, " +
  "j.posted_at, j.closes_at, s.signer_name, s.signer_title, s.written_authority_on_file " +
  "from job j left join job_text t on t.job_id = j.id left join sponsorship_statement s on s.job_id = j.id and s.superseded_at is null " +
  "where j.id = $1 and j.organisation_id = $2 and j.source in ('employer','agency')";

/**
 * GET /api/portal/jobs/{id} (B49): one of the company's own jobs in full, in the shape of the post body, to fill the edit and repost forms. Any active member,
 * viewers too, as the list. Another company's job, and one that does not exist, are the same 404 JOB_NOT_FOUND.
 */
export async function jobGet(request: Request, jobId: string): Promise<Response> {
  const login = await portalLogin(request);
  if (login instanceof Response) return login;
  if (!validId(jobId)) return no(400, "BAD_REQUEST");
  if (!login.membership) return no(404, "NO_COMPANY");
  const j = (await getPool().query(ONE_JOB, [jobId, login.membership.organisationId])).rows[0];
  if (!j) return no(404, "JOB_NOT_FOUND");
  return ok({ job: {
    id: j.id, status: j.status, badge: j.badge, passRoute: j.pass_route, title: j.title, description: j.advert_text ?? "", county: j.county, occupationCode: j.occupation_code,
    contractType: j.contract_type, contractMonths: j.contract_months, salaryLow: j.salary_low, salaryHigh: j.salary_high, payGrade: j.pay_grade, healthInsuranceEur: j.health_insurance_eur,
    weeklyHours: j.weekly_hours ?? 39, ownPageUrl: j.own_page_url, clientName: j.permit_employer_kind === "client" ? j.permit_employer_name : null, permitType: j.permit_type,
    exceptionConfirmed: j.ticked, statement: j.signer_name === null ? null : { signerName: j.signer_name, signerTitle: j.signer_title, writtenAuthority: j.written_authority_on_file },
    postedAt: j.posted_at, closesAt: j.closes_at } });
}

/** GET /api/portal/jobs/suggest?title= (P5): up to 3 SOC codes from the matcher's title rules, with their official titles. No AI, no database read but the session. */
export async function jobSuggest(request: Request): Promise<Response> {
  const login = await portalLogin(request);
  if (login instanceof Response) return login;
  const params = new URL(request.url).searchParams;
  const title = line(params.get("title"), 2, 200);
  if (!title || [...params.keys()].length !== 1) return no(400, "BAD_REQUEST");
  return ok({ suggestions: suggestCodes(title).filter(isSoc2010).map((code) => ({ code, title: socTitle(code) })) });
}

/** GET /api/portal/jobs/grades (#269): the grades of the pay scales in force, for the posting form's grade picker. Any signed-in portal login; no parameters. */
export async function jobGrades(request: Request): Promise<Response> {
  const login = await portalLogin(request);
  if (login instanceof Response) return login;
  if ([...new URL(request.url).searchParams.keys()].length) return no(400, "BAD_REQUEST");
  return ok({ grades: ((await getRules(getPool())).payScales ?? []).map(({ code, title, firstEur, lastEur, note }) => ({ code, title, firstEur, lastEur, note: note ?? null })) });
}
