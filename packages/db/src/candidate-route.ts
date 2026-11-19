// The plumbing every signed-in candidate route shares (the shape of report.ts and the portal's readPost): Origin, body cap, JSON, the body check,
// the session, a rate limit per login, then the route's own work. The candidate id always comes from the session, never the body.
// A refusal from the work (class Refuse) or from a database rule becomes a short code; anything else is thrown (a 500, nothing leaked).
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getPool } from "./index";
import type { ReportLogin } from "./report";

export const CANDIDATE_MAX_BODY = 2048; // characters; the largest good body (a full profile) is under 1,000
export const CANDIDATE_RATE = { windowMs: 10 * 60_000, max: 60 }; // writes per login, all candidate routes together

export class Refuse extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export type CandidateEnv = { origin: string; login: (headers: Headers) => Promise<ReportLogin> };

export const isObject = (b: unknown): b is Record<string, unknown> => typeof b === "object" && b !== null && !Array.isArray(b);
/** True when the object has no key outside `keys`. */
export const only = (b: Record<string, unknown>, keys: readonly string[]) => Object.keys(b).every((k) => keys.includes(k));
export const hasControl = (s: string) => /[\p{Cc}\p{Cf}]/u.test(s);

const no = (status: number, code: string) => Response.json({ code }, { status });

// One statement, the pool's rate-limit table; every own limit (candidate writes, uploads, reports, the portal's POSTs) goes through it. The table is
// the app's own: each app role may write only its own. last_request holds the END of the window, as in packages/auth/src/email-limit.ts: Better
// Auth deletes rows whose last_request is older than its longest window (better-auth rate-limiter, deleteExpiredRows), so storing the last call's
// time would let a 10-minute or hour-long count restart after a few minutes' pause.
export const rateSql = (table: RateTable) =>
  `insert into ${table} as r (id, key, count, last_request) values ($1, $2, 1, $3::bigint + $4::bigint)
     on conflict (key) do update set count = case when r.last_request <= $3::bigint then 1 else r.count + 1 end,
       last_request = case when r.last_request <= $3::bigint then $3::bigint + $4::bigint else r.last_request end
     returning count, last_request`;
type RateTable = "candidate_rate_limit" | "portal_rate_limit";
/** The client address as Vercel gives it (the only address header trusted; the auth pools read the same one). Every other header is ignored. */
export const clientAddress = (h: Headers) => (h.get("x-vercel-forwarded-for") ?? "").split(",")[0]!.trim().slice(0, 64) || "none";
/** Counts one call under `key`: the count in this window and the window's end (ms since 1970). */
export async function countRate(table: RateTable, key: string, rate: { windowMs: number }): Promise<{ count: number; end: number }> {
  const { rows } = await getPool().query(rateSql(table), [randomUUID(), key, Date.now(), rate.windowMs]);
  return { count: rows[0].count, end: Number(rows[0].last_request) };
}
export const withinRate = async (table: RateTable, key: string, rate: { windowMs: number; max: number }) => (await countRate(table, key, rate)).count <= rate.max;
const withinLimit = (userId: string) => withinRate("candidate_rate_limit", `candidate:${userId}`, CANDIDATE_RATE);

/** One transaction on one connection. */
export async function inTransaction<T>(db: pg.Pool, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("begin");
    const r = await work(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally { c.release(); }
}

// The database's own refusals as codes. A job that never went live and a job that does not exist look the same (JOB_NOT_FOUND).
function refusalFor(e: unknown): Refuse | null {
  if (e instanceof Refuse) return e;
  const { code, message = "" } = (e ?? {}) as { code?: string; message?: string };
  if (code === "23503") return new Refuse(404, "JOB_NOT_FOUND");
  if (code === "23514") return new Refuse(400, "BAD_REQUEST");
  if (code !== "P0001") return null;
  if (message.includes("never live")) return new Refuse(404, "JOB_NOT_FOUND");
  if (message.includes("saved jobs full")) return new Refuse(409, "SAVED_LIMIT");
  return new Refuse(403, "REFUSED"); // the tracker guard and any other rule: fail closed, no detail
}

async function run(env: CandidateEnv, headers: Headers, rate: boolean, work: (userId: string) => Promise<unknown>): Promise<Response> {
  const who = await env.login(headers);
  if ("refused" in who) return who.refused === "no_session" ? no(401, "NO_SESSION") : no(403, who.refused === "reauth_required" ? "REAUTH_REQUIRED" : "REFUSED");
  if (rate && !(await withinLimit(who.userId))) return no(429, "TOO_MANY_REQUESTS");
  try { return Response.json(await work(who.userId)); } catch (e) {
    const r = refusalFor(e);
    if (r) return no(r.status, r.code);
    throw e;
  }
}

/** A GET: needs a session, no Origin or rate limit (it changes nothing). */
export const candidateRead = (request: Request, env: CandidateEnv, work: (db: pg.Pool, userId: string, url: URL) => Promise<unknown>) =>
  run(env, request.headers, false, (userId) => work(getPool(), userId, new URL(request.url)));

/** A POST, PUT or DELETE: Origin, body cap, JSON, the body check, session, rate limit, then the work. */
export async function candidateWrite<T>(request: Request, env: CandidateEnv, check: (b: unknown) => T | null, work: (db: pg.Pool, userId: string, body: T) => Promise<unknown>): Promise<Response> {
  if (request.headers.get("origin") !== env.origin) return no(403, "BAD_ORIGIN");
  if (Number(request.headers.get("content-length") ?? 0) > CANDIDATE_MAX_BODY) return no(413, "BODY_TOO_LARGE"); // before the body is read
  const text = await request.text();
  if (text.length > CANDIDATE_MAX_BODY) return no(413, "BODY_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return no(400, "BAD_REQUEST"); }
  const body = check(parsed);
  if (body === null) return no(400, "BAD_REQUEST");
  return run(env, request.headers, true, (userId) => work(getPool(), userId, body));
}
