// S3 and S5 (#46): the public reads of the candidate site (job list and search, one job, a company page, an occupation page) behind one gate.
// The gate reads the session first. A visitor (no candidate session; a forged, expired, suspended or deleted one; a portal or staff session) gets at
// most VISITOR_JOBS jobs of any list, no cursor, and a flag that more wait behind sign-in; the rows past them are never fetched. A signed-in candidate
// keeps the full paging. Every read is counted in candidate_rate_limit through countRate: per client address for a visitor, per login for a candidate.
import type pg from "pg";
import { similarLiveJobs } from "./candidate";
import { clientAddress, countRate, Refuse } from "./candidate-route";
import { getHelp } from "./content";
import { getPool } from "./index";
import { getCompanyPage, getOccupationPage } from "./public-pages";
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

type Work = (db: pg.Pool, q: URLSearchParams, visitor: boolean) => Promise<unknown>;
const no = (status: number, code: string) => Response.json({ code }, { status });

/** One public GET: session, rate limit, then the work. null from the work is 404; bad input is 400. */
export async function publicRead(request: Request, login: (headers: Headers) => Promise<ReportLogin>, work: Work): Promise<Response> {
  const who = await login(request.headers);
  const now = Date.now();
  const counts = await Promise.all(readLimits(who, clientAddress(request.headers)).map(async (l) => ({ rate: l.rate, ...(await countRate("candidate_rate_limit", l.key, l.rate)) })));
  const wait = retryAfter(counts, now);
  if (wait !== null) return tooMany(wait);
  try {
    const body = await work(getPool(), new URL(request.url).searchParams, !("userId" in who));
    return body === null ? no(404, "NOT_FOUND") : Response.json(body);
  } catch (e) {
    if (e instanceof BadSearchInput) return no(400, "BAD_REQUEST");
    if (e instanceof Refuse) return no(e.status, e.code);
    throw e;
  }
}

// The work of each route. Query keys: the list takes sort, after, before and the parseSearch filters; one job takes id; a company slug; an occupation
// code; a help page (S17, "Not sure?") its slug, 404 when no page of that slug is published.
export const jobsRead: Work = async (db, q, visitor) => {
  const p = readPaging(q, visitor);
  return shown(await listJobs(db, { sort: (q.get("sort") ?? undefined) as Sort | undefined, filters: parseSearch(q), ...p }), visitor);
};
export const jobRead: Work = (db, q) => getJob(db, q.get("id") ?? "");
export const similarRead: Work = (db, q) => similarLiveJobs(db, q.get("id") ?? "");
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
