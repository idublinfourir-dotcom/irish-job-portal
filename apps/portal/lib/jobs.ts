// Employer and agency job posting (#224 to #227, #44, #48, #49): post (draft or live), edit, renew, close, and the company's own list.
// The acting login and its membership always come from the session, never the body. The rules package runs the same checks as on fetched
// adverts, on the structured fields the employer typed; the database has the last word (job_guard, signer_check, job_org_live, the deferred
// statement check). There is no row level security: every read and write here is filtered by the login's own company.
import { getPool, getRules, listAnswer, validId } from "@portal/db";
import { suggestCodes } from "@portal/matcher/rules";
import { assess, chainRules, isSoc2010, minimumForHours, socTitle, type RulesSnapshot } from "@portal/rules";
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
  /** The employer ticked the exception wording of an Ineligible entry ("with the exception of ..."). Not stored: it only lets this check pass. */
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

const id = (v: unknown) => (validId(v) ? v : null);
export function checkEdit(b: unknown): (Post & { jobId: string }) | null {
  if (!isObject(b)) return null;
  const jobId = id(b.jobId);
  const post = checkPost(Object.fromEntries(Object.entries(b).filter(([k]) => k !== "jobId")));
  return jobId && post ? { ...post, jobId } : null;
}
export type Hire = "yes" | "no";
export function checkRenew(b: unknown): { jobId: string; hireAnswer: Hire | null } | null {
  if (!isObject(b) || !only(b, ["jobId", "hireAnswer"])) return null;
  const jobId = id(b.jobId), h = b.hireAnswer;
  if (!jobId || (h !== undefined && h !== "yes" && h !== "no")) return null;
  return { jobId, hireAnswer: h ?? null };
}
export function checkClose(b: unknown): { jobId: string; hireAnswer: Hire } | null {
  const r = checkRenew(b);
  return r && r.hireAnswer ? { jobId: r.jobId, hireAnswer: r.hireAnswer } : null; // #49: closing always asks "Did you hire someone through us?"
}

// ===== the rules
/**
 * Conditions a code carries that its Ineligible title does not name (P6, 06-health-hospitality-eligibility.md): the employer ticks them with the same
 * `exceptionConfirmed` as an Ineligible exception, and the refusal carries the wording. Placeholder wording. Every other named condition (chef experience
 * and "not fast food" on 5434, disability services on 1242, 2229, 3231, 3239 and 6146) is already in its Ineligible title and asks for the same tick.
 */
export const CONDITIONS: Readonly<Record<string, string>> = {
  "6145": "Care workers and home carers: the employer is a care provider, not a private household (a job in a private home is not eligible)",
};
export type Verdict = { ok: true; passRoute: "stated_pay" | "public_pay"; status: "live" | "in_review"; sector: string; stage: string }
  | { ok: false; code: string; stage?: string; exception?: string };

/**
 * The rules on the structured fields: the occupation list, the contract, the rules chain (Ireland, "no sponsorship", Irish employer, contract text, scam wording), then the pay.
 * A General Employment Permit post (4.2): no occupation list or contract length, a quota check, the General minimum (a lower rate for some codes), stated pay only,
 * and the sponsorship statement always. The General figures are optional in the minimums, so a version without them refuses with GENERAL_RULES_NOT_SET.
 * `rules`: the minimums and lists in force (#229, `getRules(db)` from the database); the DETE names are not loaded: the chain uses them only for LinkedIn adverts (assess.ts, `known`).
 */
export async function rulesFor(p: Post, employerName: string, r: RulesSnapshot): Promise<Verdict> {
  const m = r.minimums;
  const general = p.permitType === "general";
  if (general && (m.general === undefined || m.generalLower === undefined || !m.generalLowerCodes || !m.generalQuotaFullCodes)) return { ok: false, code: "GENERAL_RULES_NOT_SET" };
  const onList = listAnswer(r.occupationLists, p.occupationCode);
  if (onList === "no") {
    // an Ineligible entry that names an exception passes when the employer confirmed they meet it; the reply carries the wording so the page can show it
    const title = r.occupationLists.find((e) => e.code === p.occupationCode && e.list === "ineligible")?.title;
    const exception = title?.includes("with the exception of") ? title : undefined;
    if (!(exception && p.exceptionConfirmed)) return { ok: false, code: "OCCUPATION_INELIGIBLE", ...(exception ? { exception } : {}) };
  }
  const condition = CONDITIONS[p.occupationCode];
  if (condition && !p.exceptionConfirmed) return { ok: false, code: "OCCUPATION_INELIGIBLE", exception: condition };
  if (general && m.generalQuotaFullCodes!.includes(p.occupationCode)) return { ok: false, code: "QUOTA_FULL" }; // #85: a full quota blocks new postings
  if (!general) {
    if (onList === null && !m.nonListRoute) return { ok: false, code: "OCCUPATION_NOT_ON_LIST" };
    // a Critical Skills post needs a contract of at least 2 years (#32); a General post has no minimum length
    if (p.contractType === "fixed_term" && p.contractMonths! < m.minContractMonths) return { ok: false, code: "CONTRACT_TOO_SHORT" };
  }
  // ponytail: for a General post the chain's text reader gets a 1-month minimum, so "6 months" in the advert is not "short" (maternity, intern and temporary wording still stop it)
  const chain = chainRules(r);
  if (general) chain.minimums = { ...m, minContractMonths: 1 };
  const a = await assess(
    { source: "employer", employer: employerName, title: p.title, location: `${p.county}, Ireland`, description: p.description, employmentType: "", salaryBox: "" },
    { deteNames: new Set(), ...chain, matcher: async () => ({ occupationCode: p.occupationCode, onCriticalSkillsList: "yes", confidence: "high" }) },
    // The contract is stated in its own fields (checked above), so the chain's "contract unclear" stops do not apply; a short contract in the text still fails.
    { contractConfirmed: true, ...(p.salaryLow !== null ? { salary: { low: p.salaryLow, high: p.salaryHigh ?? p.salaryLow } } : {}) },
  );
  if (a.bucket === "rejected" && !a.stage.startsWith("8 ")) return { ok: false, code: "RULES_FAILED", stage: a.stage };
  // Pay: the top of a range counts (#66), with employer-paid health insurance (#68), against the minimum for the stated hours. Compared with >=:
  // DETE's page says "over 68,911" and its checklist "is 68,911 or more"; we follow the checklist.
  // #225 (step9/dete-thresholds-research.md): a role not on the Critical Skills list and not Ineligible qualifies at the non-list minimum.
  // General: the lower rate covers code 6145 only (ponytail: meat processor and horticulture sit inside 8111 and 9119, which also hold standard-rate roles; add per-entry rates if those sectors are posted).
  const base = general ? (m.generalLowerCodes!.includes(p.occupationCode) ? m.generalLower! : m.general!) : onList === "yes" ? m.criticalSkills : m.nonList;
  const minimum = minimumForHours(base, p.weeklyHours, m.standardWeekHours);
  const pay = p.salaryLow === null ? null : (p.salaryHigh ?? p.salaryLow) + (p.healthInsuranceEur ?? 0);
  let passRoute: "stated_pay" | "public_pay";
  if (pay !== null && pay >= minimum) passRoute = "stated_pay";
  else if (!general && a.publicPayTier > 0 && onList === "yes") passRoute = "public_pay"; // a public pay-scale employer on a list role (#67)
  else return { ok: false, code: pay === null ? "PAY_REQUIRED" : "PAY_BELOW_MINIMUM" };
  if (general && !p.statement) return { ok: false, code: "STATEMENT_REQUIRED" }; // #31: a General job appears only when the employer confirms sponsorship
  return { ok: true, passRoute, status: a.bucket === "queue" || a.scamFlag ? "in_review" : "live", sector: a.sector, stage: a.stage };
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
  "salary_low, salary_high, health_insurance_eur, pay_grade, weekly_hours, pass_route, status, closes_at, search_vector, own_page_url, permit_employer_kind, permit_employer_name, posted_by_membership_id) " +
  "values ($1, $2, (select id from job_source where kind = 'portal' and board = 'employer'), $3::text, $4::text, $5, $6, $7, $8, $9, $23, $10, $11, $12, $13, $14, $15, $16, $17, " +
  "now() + interval '30 days', to_tsvector('english', $3::text || ' ' || $4::text || ' ' || $18::text), $19, $20, $21, $22) returning id, status, badge, pass_route";
const UPDATE_JOB =
  "update job set title = $3::text, county = $4, sector = $5, occupation_code = $6, contract_type = $7, contract_months = $8, badge = $9, salary_low = $10, salary_high = $11, " +
  "health_insurance_eur = $12, pay_grade = $13, weekly_hours = $14, pass_route = $15, status = $16, own_page_url = $17, permit_employer_kind = $18, permit_employer_name = $19, " +
  "posted_by_membership_id = $20, permit_type = $22, search_vector = to_tsvector('english', $3::text || ' ' || employer_name || ' ' || $21::text) " +
  "where id = $1 and organisation_id = $2 returning id, status, badge, pass_route";
const UPSERT_TEXT = "insert into job_text(job_id, advert_text) values ($1, $2) on conflict (job_id) do update set advert_text = excluded.advert_text";
const SUPERSEDE = "update sponsorship_statement set superseded_at = now() where job_id = $1 and superseded_at is null";
const INSERT_STATEMENT =
  "insert into sponsorship_statement(job_id, organisation_id, kind, consent_text_id, signer_membership_id, signer_name, signer_title, on_behalf_of_name, written_authority_on_file) " +
  "values ($1, $2, $3, $4, $5, $6, $7, $8, $9)";

/** The statement (the database's signer_check decides who may sign). Inside the caller's transaction. */
async function sign(c: pg.PoolClient, jobId: string, who: Acting, p: Post): Promise<Response | null> {
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
  const w = await writer(request, checkPost, MAX_JOB_BODY);
  if (w instanceof Response) return w;
  const { who, body: p } = w;
  return inTx(async (c) => {
    const org = (await c.query(ORG, [who.organisationId])).rows[0] as { display_name: string; kind: string };
    if (p.clientName && org.kind !== "agency") return no(400, "CLIENT_ONLY_FOR_AGENCIES");
    let v: Verdict = { ok: true, passRoute: "stated_pay", status: "live", sector: "other", stage: "" };
    if (p.status === "live") {
      v = await rulesFor(p, p.clientName ?? org.display_name, await getRules(c));
      if (!v.ok) return verdictReply(v);
    }
    const r = (await c.query(INSERT_JOB, [who.organisationId, org.kind === "agency" ? "agency" : "employer", p.title, org.display_name, p.county, v.sector, p.occupationCode,
      p.contractType, p.contractMonths, p.statement ? "sponsor_confirmed" : null, p.salaryLow, p.salaryHigh, p.healthInsuranceEur, p.payGrade, p.weeklyHours,
      p.status === "live" ? v.passRoute : null, p.status === "live" ? v.status : "draft", p.description, p.ownPageUrl, p.clientName ? "client" : "self", p.clientName,
      who.membershipId, p.permitType])).rows[0];
    await c.query(UPSERT_TEXT, [r.id, p.description]);
    if (p.statement) { const refused = await sign(c, String(r.id), who, p); if (refused) return refused; }
    return jobReply(r);
  });
}

const LOCK = "select status, badge, pass_route, sector, permit_type, title, occupation_code, salary_low, salary_high, pay_grade, health_insurance_eur, weekly_hours from job " +
  "where id = $1 and organisation_id = $2 and source in ('employer','agency') for update";

/**
 * POST /api/portal/jobs/edit: the whole post again with its jobId. A draft stays a draft, or goes live with the rules (status "live").
 * On a job past draft the status field does not move it; a change to the pay (salary, grade, health insurance, hours), the title or the
 * occupation runs the rules again and needs a fresh signed statement when the job shows "Sponsor confirmed" (#226); other edits do neither.
 */
export async function jobEdit(request: Request): Promise<Response> {
  const w = await writer(request, checkEdit, MAX_JOB_BODY);
  if (w instanceof Response) return w;
  const { who, body: p } = w;
  return inTx(async (c) => {
    const j = (await c.query(LOCK, [p.jobId, who.organisationId])).rows[0];
    if (!j) return no(404, "JOB_NOT_FOUND"); // another company's job is not found either
    if (j.status === "closed" || j.status === "hidden") return no(409, "BAD_STATE");
    const org = (await c.query(ORG, [who.organisationId])).rows[0] as { display_name: string; kind: string };
    if (p.clientName && org.kind !== "agency") return no(400, "CLIENT_ONLY_FOR_AGENCIES");
    const pay = j.salary_low !== p.salaryLow || j.salary_high !== p.salaryHigh || j.pay_grade !== p.payGrade || j.health_insurance_eur !== p.healthInsuranceEur;
    const key = pay || j.title !== p.title || j.occupation_code !== p.occupationCode || j.permit_type !== p.permitType || (j.weekly_hours ?? 39) !== p.weeklyHours;
    const publish = j.status === "draft" && p.status === "live";
    let status: string = j.status, passRoute = j.pass_route, sector = j.sector;
    if (publish || (j.status !== "draft" && key)) {
      const v = await rulesFor(p, p.clientName ?? org.display_name, await getRules(c));
      if (!v.ok) return verdictReply(v);
      if (publish) status = v.status;
      else if (v.status === "in_review" && j.status === "live") return no(409, "NEEDS_REVIEW"); // the guard keeps a live job live or closes it
      // #93: a job under review (the minimums rose) goes live again when its new pay passes; the guard allows that only on a pay change.
      else if (v.status === "live" && j.status === "under_review" && pay) status = "live";
      passRoute = v.passRoute; sector = v.sector;
    }
    if (j.status !== "draft" && key && j.badge === "sponsor_confirmed" && !p.statement) return no(422, "STATEMENT_REQUIRED"); // the same rule refusal as rulesFor gives a General post
    const badge = p.statement ? "sponsor_confirmed" : j.status !== "draft" && key ? null : j.badge;
    const r = (await c.query(UPDATE_JOB, [p.jobId, who.organisationId, p.title, p.county, sector, p.occupationCode, p.contractType, p.contractMonths, badge, p.salaryLow,
      p.salaryHigh, p.healthInsuranceEur, p.payGrade, p.weeklyHours, passRoute, status, p.ownPageUrl, p.clientName ? "client" : "self", p.clientName, who.membershipId,
      p.description, p.permitType])).rows[0];
    await c.query(UPSERT_TEXT, [p.jobId, p.description]);
    if (p.statement) { const refused = await sign(c, p.jobId, who, p); if (refused) return refused; }
    return jobReply(r);
  });
}

const RENEW =
  "update job set closes_at = now() + interval '30 days', posted_by_membership_id = $3, hire_answer = coalesce($4, hire_answer), " +
  "hire_answered_at = case when $4::text is null then hire_answered_at else now() end, hire_answered_by_membership_id = case when $4::text is null then hire_answered_by_membership_id else $3 end " +
  "where id = $1 and organisation_id = $2 and source in ('employer','agency') and status = 'live' returning id, closes_at";
/** POST /api/portal/jobs/renew: a live job gets a new 30 days from now (#48), with the optional "Did you hire someone through us?" answer (#49). */
export async function jobRenew(request: Request): Promise<Response> {
  const w = await writer(request, checkRenew);
  if (w instanceof Response) return w;
  const { who, body } = w;
  return inTx(async (c) => {
    const r = (await c.query(RENEW, [body.jobId, who.organisationId, who.membershipId, body.hireAnswer])).rows[0];
    return r ? ok({ jobId: r.id, closesAt: r.closes_at }) : no(404, "JOB_NOT_FOUND");
  });
}

const CLOSE =
  "update job set status = 'closed', closed_at = now(), close_reason = 'closed', posted_by_membership_id = $3, hire_answer = $4, hire_answered_at = now(), " +
  "hire_answered_by_membership_id = $3 where id = $1 and organisation_id = $2 and source in ('employer','agency') and status in ('draft','in_review','live','under_review') returning id";
/** POST /api/portal/jobs/close: closes the job with the "Did you hire someone through us?" answer (#49). A closed job never reopens. */
export async function jobClose(request: Request): Promise<Response> {
  const w = await writer(request, checkClose);
  if (w instanceof Response) return w;
  const { who, body } = w;
  return inTx(async (c) => {
    const r = (await c.query(CLOSE, [body.jobId, who.organisationId, who.membershipId, body.hireAnswer])).rows[0];
    return r ? ok({ jobId: r.id, status: "closed" }) : no(404, "JOB_NOT_FOUND");
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
 * POST /api/portal/jobs/check (P4): the post body, checked as a live post would be (the agency and written authority checks, then rulesFor) and
 * nothing written, so the form can show a refusal while the employer types. `status` is read but does not matter. The same codes as the post.
 */
export async function jobCheck(request: Request): Promise<Response> {
  const w = await writer(request, checkPost, MAX_JOB_BODY, "jobcheck", CHECK_RATE);
  if (w instanceof Response) return w;
  const { who, body: p } = w;
  const db = getPool();
  const org = (await db.query(ORG, [who.organisationId])).rows[0] as { display_name: string; kind: string };
  if (p.clientName && org.kind !== "agency") return no(400, "CLIENT_ONLY_FOR_AGENCIES");
  if (p.clientName && p.statement && !p.statement.writtenAuthority) return no(400, "WRITTEN_AUTHORITY_REQUIRED");
  const v = await rulesFor(p, p.clientName ?? org.display_name, await getRules(db));
  return v.ok ? ok({ ok: true, status: v.status, passRoute: v.passRoute, sector: v.sector }) : verdictReply(v);
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
