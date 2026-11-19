// "Report a job" (slice 8.5 item 1) and "report a company" (#102, S11): the POST behind the candidate site and the portal. The reporter id always comes from the
// session, never the body. The reporter is never shown to the employer: the reply says only { ok: true }. The database is the
// guard: the app roles may insert only the columns below (migration 0015), so a report cannot be filed as already decided.
import { botRefused, botResponse } from "./bot-check";
import { withinRate } from "./candidate-route";
import { getPool } from "./index";
import { validId } from "./search";

export const REPORT_REASONS = ["asks_for_money", "no_sponsorship", "job_closed", "wrong_details", "other"] as const;
/** The company reasons (placeholder codes; migration 0056 holds the same list per target_kind). */
export const COMPANY_REASONS = ["fake_company", "asks_for_money", "no_sponsorship", "other"] as const;
export const MAX_BODY = 4000; // characters; evidence is at most 2000
export const MAX_EVIDENCE = 2000;
export const RATE = { windowMs: 60 * 60_000, max: 10 }; // reports per login per hour, job and company reports together

type Reason = (typeof REPORT_REASONS)[number] | (typeof COMPANY_REASONS)[number];
/** Exactly one target: a job or a company (organisation id). */
export type ReportBody = ({ jobId: string } | { companyId: string }) & { reason: Reason; evidence: string | null };

const isObject = (b: unknown): b is Record<string, unknown> => typeof b === "object" && b !== null && !Array.isArray(b);
const KEYS = ["jobId", "companyId", "reason", "evidence"];

// Null means refuse. Exactly one of jobId and companyId; the reason must be one of that target's codes. Unknown fields are refused;
// evidence may hold newline and tab but no other control character.
export function checkReport(b: unknown): ReportBody | null {
  if (!isObject(b) || !Object.keys(b).every((k) => KEYS.includes(k))) return null;
  const { jobId, companyId, reason, evidence } = b;
  if ((jobId === undefined) === (companyId === undefined)) return null;
  const id = jobId ?? companyId;
  const reasons: readonly string[] = jobId !== undefined ? REPORT_REASONS : COMPANY_REASONS;
  if (!validId(id) || typeof reason !== "string" || !reasons.includes(reason)) return null;
  const target = jobId !== undefined ? { jobId: id } : { companyId: id };
  if (evidence === undefined) return { ...target, reason: reason as Reason, evidence: null };
  if (typeof evidence !== "string" || evidence.length < 1 || evidence.length > MAX_EVIDENCE || /[\p{Cc}\p{Cf}]/u.test(evidence.replace(/[\n\t]/g, ""))) return null;
  return { ...target, reason: reason as Reason, evidence };
}

// Fixed names per side, never taken from input.
const SIDES = {
  candidate: { limit: "candidate_rate_limit", column: "reporter_candidate_user_id" },
  portal: { limit: "portal_rate_limit", column: "reporter_portal_user_id" },
} as const;
export type ReportSide = keyof typeof SIDES;
/** Who is reporting: a user id, or why not. */
// reauth_required: only a login asked for a fresh session (C4) gives it; a route that does not know it refuses with REFUSED.
export type ReportLogin = { userId: string } | { refused: "no_session" | "refused" | "reauth_required" };

const no = (status: number, code: string) => Response.json({ code }, { status });

// Counts this login's reports in the pool's rate-limit table.
const withinLimit = (side: ReportSide, userId: string) => withinRate(SIDES[side].limit, `report:${userId}`, RATE);

const JOB_INSERT = (side: ReportSide) =>
  `insert into report(target_kind, target_job_id, ${SIDES[side].column}, reason, evidence_text, target_snapshot)
   select 'job', j.id, $2, $3, $4, jsonb_build_object('title', j.title, 'employer_name', j.employer_name, 'badge', j.badge,
     'salary_low', j.salary_low, 'salary_high', j.salary_high, 'pay_grade', j.pay_grade, 'closes_at', j.closes_at)
   from job j where j.id = $1::bigint and j.status = 'live' and j.closes_at > now() returning id`;
// A company that has a page (public-pages.ts getCompanyPage): not rejected or closed, not merged away. Any other status may be reported, a banned
// or suspended one too (its page still shows). The report hides nothing (K3).
const COMPANY_INSERT = (side: ReportSide) =>
  `insert into report(target_kind, target_organisation_id, ${SIDES[side].column}, reason, evidence_text, target_snapshot)
   select 'organisation', o.id, $2, $3, $4, jsonb_build_object('display_name', o.display_name, 'slug', o.slug, 'kind', o.kind, 'status', o.status,
     'website', o.website, 'short_description', o.short_description)
   from organisation o where o.id = $1::bigint and o.status not in ('rejected','closed') and o.merged_into_id is null returning id`;

export async function handleReport(request: Request, o: { origin: string; side: ReportSide; login: (headers: Headers) => Promise<ReportLogin> }): Promise<Response> {
  if (await botRefused(process.env)) return botResponse(); // before the body is read or the database is touched
  if (request.headers.get("origin") !== o.origin) return no(403, "BAD_ORIGIN");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return no(413, "BODY_TOO_LARGE"); // before the body is read
  const text = await request.text();
  if (text.length > MAX_BODY) return no(413, "BODY_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return no(400, "BAD_REQUEST"); }
  const body = checkReport(parsed);
  if (!body) return no(400, "BAD_REQUEST");
  const who = await o.login(request.headers);
  if ("refused" in who) return who.refused === "no_session" ? no(401, "NO_SESSION") : no(403, "REFUSED");
  if (!(await withinLimit(o.side, who.userId))) return no(429, "TOO_MANY_REQUESTS");
  try {
    const job = "jobId" in body;
    const r = await getPool().query(job ? JOB_INSERT(o.side) : COMPANY_INSERT(o.side), [job ? body.jobId : body.companyId, who.userId, body.reason, body.evidence]);
    return r.rowCount ? Response.json({ ok: true }) : no(404, job ? "JOB_NOT_FOUND" : "COMPANY_NOT_FOUND");
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return no(409, "ALREADY_REPORTED");
    throw e;
  }
}
