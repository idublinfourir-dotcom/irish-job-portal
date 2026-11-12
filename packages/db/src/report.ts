// "Report a job" (slice 8.5 item 1): the POST behind the candidate site and the portal. The reporter id always comes from the
// session, never the body. The reporter is never shown to the employer: the reply says only { ok: true }. The database is the
// guard: the app roles may insert only the columns below (migration 0015), so a report cannot be filed as already decided.
import { randomUUID } from "node:crypto";
import { getPool } from "./index";
import { validId } from "./search";

export const REPORT_REASONS = ["asks_for_money", "no_sponsorship", "job_closed", "wrong_details", "other"] as const;
export const MAX_BODY = 4000; // characters; evidence is at most 2000
export const MAX_EVIDENCE = 2000;
export const RATE = { windowMs: 60 * 60_000, max: 10 }; // reports per login per hour

export type ReportBody = { jobId: string; reason: (typeof REPORT_REASONS)[number]; evidence: string | null };

const isObject = (b: unknown): b is Record<string, unknown> => typeof b === "object" && b !== null && !Array.isArray(b);

// Null means refuse. Unknown fields are refused; evidence may hold newline and tab but no other control character.
export function checkReport(b: unknown): ReportBody | null {
  if (!isObject(b) || !Object.keys(b).every((k) => k === "jobId" || k === "reason" || k === "evidence")) return null;
  const { jobId, reason, evidence } = b;
  if (!validId(jobId) || typeof reason !== "string" || !(REPORT_REASONS as readonly string[]).includes(reason)) return null;
  if (evidence === undefined) return { jobId, reason: reason as ReportBody["reason"], evidence: null };
  if (typeof evidence !== "string" || evidence.length < 1 || evidence.length > MAX_EVIDENCE || /[\p{Cc}\p{Cf}]/u.test(evidence.replace(/[\n\t]/g, ""))) return null;
  return { jobId, reason: reason as ReportBody["reason"], evidence };
}

// Fixed names per side, never taken from input.
const SIDES = {
  candidate: { limit: "candidate_rate_limit", column: "reporter_candidate_user_id" },
  portal: { limit: "portal_rate_limit", column: "reporter_portal_user_id" },
} as const;
export type ReportSide = keyof typeof SIDES;
/** Who is reporting: a user id, or why not. */
export type ReportLogin = { userId: string } | { refused: "no_session" | "refused" };

const no = (status: number, code: string) => Response.json({ code }, { status });

// One statement: counts this login's reports in the pool's rate-limit table (same shape as the company POSTs).
async function withinLimit(side: ReportSide, userId: string): Promise<boolean> {
  const now = Date.now();
  const { rows } = await getPool().query(
    `insert into ${SIDES[side].limit}(id, key, count, last_request) values ($1, $2, 1, $3)
     on conflict (key) do update set count = case when ${SIDES[side].limit}.last_request < $3 - $4 then 1 else ${SIDES[side].limit}.count + 1 end, last_request = $3
     returning count`, [randomUUID(), `report:${userId}`, now, RATE.windowMs]);
  return rows[0].count <= RATE.max;
}

export async function handleReport(request: Request, o: { origin: string; side: ReportSide; login: (headers: Headers) => Promise<ReportLogin> }): Promise<Response> {
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
    const r = await getPool().query(
      `insert into report(target_kind, target_job_id, ${SIDES[o.side].column}, reason, evidence_text, target_snapshot)
       select 'job', j.id, $2, $3, $4, jsonb_build_object('title', j.title, 'employer_name', j.employer_name, 'badge', j.badge,
         'salary_low', j.salary_low, 'salary_high', j.salary_high, 'pay_grade', j.pay_grade, 'closes_at', j.closes_at)
       from job j where j.id = $1::bigint and j.status = 'live' and j.closes_at > now() returning id`, [body.jobId, who.userId, body.reason, body.evidence]);
    return r.rowCount ? Response.json({ ok: true }) : no(404, "JOB_NOT_FOUND");
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return no(409, "ALREADY_REPORTED");
    throw e;
  }
}
