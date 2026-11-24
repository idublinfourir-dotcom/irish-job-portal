// S3 and S5 (#46): the public reads of the candidate site (job list and search, one job, a company page, an occupation page) behind one gate.
// The gate reads the session first. A visitor (no candidate session; a forged, expired, suspended or deleted one; a portal or staff session) gets at
// most VISITOR_JOBS jobs of any list, no cursor, and a flag that more wait behind sign-in; the rows past them are never fetched. A signed-in candidate
// keeps the full paging. Every read is counted in candidate_rate_limit through countRate: per client address for a visitor, per login for a candidate.
import type pg from "pg";
import { closedJob, similarLiveJobs } from "./candidate";
import { clientAddress, countRate, Refuse } from "./candidate-route";
import { BadEligibilityInput, registrationFor, type EligibilityInput } from "@portal/rules";
import { BadContentInput, getHelp, listUpdates } from "./content";
import { getPool } from "./index";
import { checkWithSiteLists, getCompanyPage, getOccupationPage } from "./public-pages";
import type { ReportLogin } from "./report";
import { BadSearchInput, getJob, listJobs, PAGE_SIZE, parseSearch, type Sort } from "./search";

export const VISITOR_JOBS = 6; // #46
export const VISITOR_READ_RATES = [{ windowMs: 60_000, max: 60 }, { windowMs: 3_600_000, max: 600 }]; // per client address
export const CANDIDATE_READ_RATES = [{ windowMs: 60_000, max: 300 }]; // per login: a person paging fast stays far under it

type Rate = { windowMs: number; max: number };
/** The rate keys of one reader. The window is in the key, so the minute and the hour count apart. */
export const readLimits = (who: ReportLogin, ip: string): { key: string; rate: Rate }[] =>
  "userId" in who
    ? CANDIDATE_READ_RATES.map((rate) => ({ key: `read:candidate:${who.userId}:${rate.windowMs}`, rate }))
    : VISITOR_READ_RATES.map((rate) => ({ key: `read:ip:${ip}:${rate.windowMs}`, rate }));

/** Seconds until every limit that is over has a new window, or null when none is over. */
export function retryAfter(counts: { count: number; end: number; rate: Rate }[], now: number): number | null {
  const over = counts.filter((c) => c.count > c.rate.max);
  return over.length ? Math.max(1, ...over.map((c) => Math.ceil((c.end - now) / 1000))) : null;
}
export const tooMany = (seconds: number) => Response.json({ code: "TOO_MANY_REQUESTS" }, { status: 429, headers: { "retry-after": String(seconds) } });

/** The cap decision: a visitor gets the first VISITOR_JOBS and may not page (a cursor is refused); a candidate gets PAGE_SIZE and the cursors. */
export function readPaging(q: URLSearchParams, visitor: boolean): { limit: number; after?: string; before?: string } {
  if (!visitor) return { limit: PAGE_SIZE, after: q.get("after") ?? undefined, before: q.get("before") ?? undefined };
  if (q.has("after") || q.has("before")) throw new Refuse(401, "SIGN_IN_FOR_MORE");
  return { limit: VISITOR_JOBS };
}
/** A list as sent: a visitor's has no cursor, and signInForMore says jobs were left out. */
const shown = <L extends { next: string | null }>(l: L, visitor: boolean) => (visitor ? { ...l, next: null, signInForMore: l.next !== null } : { ...l, signInForMore: false });

export type Work = (db: pg.Pool, q: URLSearchParams, visitor: boolean) => Promise<unknown>;
/** What the gate gives back: the data, or a typed refusal. A page shows the refusal; publicRead turns it into the HTTP reply. */
export type ReadResult =
  | { ok: true; data: unknown }
  | { ok: false; status: 429; code: "TOO_MANY_REQUESTS"; retryAfter: number }
  | { ok: false; status: number; code: string }; // 400 BAD_REQUEST, 401 SIGN_IN_FOR_MORE, 404 NOT_FOUND

/** The gate of every public read, callable from a Server Component with `await headers()`: session, rate limit, then the work.
 *  null from the work is 404; bad input is 400. */
export async function gatedRead(headers: Headers, query: URLSearchParams, login: (headers: Headers) => Promise<ReportLogin>, work: Work): Promise<ReadResult> {
  const who = await login(headers);
  const now = Date.now();
  const counts = await Promise.all(readLimits(who, clientAddress(headers)).map(async (l) => ({ rate: l.rate, ...(await countRate("candidate_rate_limit", l.key, l.rate)) })));
  const wait = retryAfter(counts, now);
  if (wait !== null) return { ok: false, status: 429, code: "TOO_MANY_REQUESTS", retryAfter: wait };
  try {
    const data = await work(getPool(), query, !("userId" in who));
    return data === null ? { ok: false, status: 404, code: "NOT_FOUND" } : { ok: true, data };
  } catch (e) {
    if (e instanceof BadSearchInput || e instanceof BadContentInput || e instanceof BadEligibilityInput) return { ok: false, status: 400, code: "BAD_REQUEST" };
    if (e instanceof Refuse) return { ok: false, status: e.status, code: e.code };
    throw e;
  }
}

/** One public GET: the gate's answer as the HTTP reply. */
export async function publicRead(request: Request, login: (headers: Headers) => Promise<ReportLogin>, work: Work): Promise<Response> {
  const r = await gatedRead(request.headers, new URL(request.url).searchParams, login, work);
  if (r.ok) return Response.json(r.data);
  return "retryAfter" in r ? tooMany(r.retryAfter) : Response.json({ code: r.code }, { status: r.status });
}

// The work of each route. Query keys: the list takes sort, after, before and the parseSearch filters; one job takes id; a company slug; an occupation
// code; a help page (S17, "Not sure?") its slug, 404 when no page of that slug is published.
export const jobsRead: Work = async (db, q, visitor) => {
  const p = readPaging(q, visitor);
  return shown(await listJobs(db, { sort: (q.get("sort") ?? undefined) as Sort | undefined, filters: parseSearch(q), ...p }), visitor);
};
export const jobRead: Work = (db, q) => getJob(db, q.get("id") ?? "");
export const similarRead: Work = (db, q) => similarLiveJobs(db, q.get("id") ?? "");
export const closedJobRead: Work = (db, q) => closedJob(db, q.get("id") ?? "");
export const companyRead: Work = async (db, q, visitor) => {
  const { limit, after } = readPaging(q, visitor);
  const c = await getCompanyPage(db, q.get("slug") ?? "", { after, limit });
  return c && "jobs" in c ? { ...c, jobs: shown(c.jobs, visitor) } : c;
};
export const occupationRead: Work = async (db, q, visitor) => {
  const { limit, after } = readPaging(q, visitor);
  const o = await getOccupationPage(db, q.get("code") ?? "", { after, limit });
  return o && { ...o, jobs: shown(o.jobs, visitor) };
};
export const helpRead: Work = (db, q) => getHelp(db, q.get("slug") ?? "");
// The updates feed (GET /api/updates): ?after, the `next` of the page before, and ?category (B17). News, not jobs: a visitor pages it too.
export const updatesRead: Work = (db, q) => listUpdates(db, q.get("after") ?? undefined, q.get("category") ?? undefined);

// The eligibility checker (GET /api/checker). Strict: every key at most once, no other key, each value in its shape, else 400 before any statement.
const CHECKER_KEYS = ["occupationCode", "annualPay", "relevantDegree", "degreeAwardMonth", "contractMonths", "weeklyHours", "title"];
export function checkerInput(q: URLSearchParams): { input: EligibilityInput; title: string | null } {
  const bad = () => new BadEligibilityInput("bad checker input");
  const keys = [...q.keys()];
  if (keys.some((k) => !CHECKER_KEYS.includes(k)) || new Set(keys).size !== keys.length) throw bad();
  const get = (k: string, shape: RegExp) => {
    const v = q.get(k);
    if (v !== null && !shape.test(v)) throw bad();
    return v;
  };
  const code = get("occupationCode", /^[0-9]{4}$/), pay = get("annualPay", /^[0-9]{1,7}(\.[0-9]{1,2})?$/), degree = get("relevantDegree", /^(true|false)$/);
  if (code === null || pay === null || degree === null) throw bad();
  const months = get("contractMonths", /^[0-9]{1,3}$/), hours = get("weeklyHours", /^[0-9]{1,2}(\.[0-9]{1,2})?$/);
  return {
    input: {
      occupationCode: code, annualPay: Number(pay), relevantDegree: degree === "true", degreeAwardMonth: get("degreeAwardMonth", /^[0-9]{4}-(0[1-9]|1[0-2])$/),
      contractMonths: months === null ? null : Number(months), ...(hours === null ? {} : { weeklyHours: Number(hours) }),
    },
    // the job title, only to tell a regulated role of a mixed code (S6); never stored
    title: get("title", /^[^\p{Cc}\p{Cf}]{1,200}$/u),
  };
}
export const checkerRead: Work = async (db, q) => {
  const { input, title } = checkerInput(q);
  return { ...(await checkWithSiteLists(db, input)), registration: registrationFor(input.occupationCode, title) };
};

// ===== R5: the legal text in force (legal-texts.ts publishes it) =====
export const LEGAL_IN_FORCE =
  "select purpose, version, body, published_at::text as published_at from consent_text where purpose = $1 order by published_at desc, id desc limit 1";
// The cookie policy, the employer acceptable use text and the data retention text are public pages of both sites (B20, #290).
const SHARED_TEXTS = ["privacy_notice", "cookie_policy", "employer_acceptable_use", "data_retention"] as const;
export const SITE_PURPOSES = { candidate: ["signup_terms", ...SHARED_TEXTS], portal: ["portal_signup_terms", ...SHARED_TEXTS] } as const;

/** The text in force for one of the site's purposes, or null before any version. Another purpose is 400. */
export async function legalInForce(db: Pick<pg.Pool, "query">, site: keyof typeof SITE_PURPOSES, purpose: string | null) {
  if (!(SITE_PURPOSES[site] as readonly string[]).includes(purpose ?? "")) throw new Refuse(400, "BAD_REQUEST");
  const r = (await db.query(LEGAL_IN_FORCE, [purpose])).rows[0];
  return r ? { purpose: r.purpose, version: r.version, body: r.body, publishedAt: r.published_at } : null;
}

/** The portal's public read: no login, counted per client address in portal_rate_limit (the visitor limits of the candidate reads). */
export async function portalLegalRead(request: Request): Promise<Response> {
  const ip = clientAddress(request.headers), now = Date.now();
  const counts = await Promise.all(VISITOR_READ_RATES.map(async (rate) => ({ rate, ...(await countRate("portal_rate_limit", `legal:ip:${ip}:${rate.windowMs}`, rate)) })));
  const wait = retryAfter(counts, now);
  if (wait !== null) return tooMany(wait);
  try {
    const body = await legalInForce(getPool(), "portal", new URL(request.url).searchParams.get("purpose"));
    return body === null ? Response.json({ code: "NOT_FOUND" }, { status: 404 }) : Response.json(body);
  } catch (e) {
    if (e instanceof Refuse) return Response.json({ code: e.code }, { status: e.status });
    throw e;
  }
}

/** The candidate site's read (through publicRead): ?purpose=signup_terms or privacy_notice. */
export const legalRead: Work = (db, q) => legalInForce(db, "candidate", q.get("purpose"));
