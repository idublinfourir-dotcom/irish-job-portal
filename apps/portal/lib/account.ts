// Audit row R1: the signed-in portal login downloads its own data (GET) and deletes itself (DELETE { confirm: true }), as the candidate's account routes.
// Both pass the session token, not a user id, to the database (migration 0034), which finds the login and makes every refusal; this file checks the request.
import { accountRefusal, checkDelete, exportFilename, portalDelete, portalExport, getPool } from "@portal/db";
import { no, withinLimit } from "./company";
import { portalAuth, portalOrigin } from "./portal";

export const ACCOUNT_MAX_BODY = 2048; // characters; the only good body is { "confirm": true }
export const DELETE_RATE = { windowMs: 10 * 60_000, max: 10 }; // delete attempts per login

// The live session's token and user id, or the reply: no session 401 NO_SESSION, a blocked or deleted login 403 REFUSED (as requirePortal).
async function session(request: Request): Promise<Response | { token: string; userId: string }> {
  const s = await portalAuth().api.getSession({ headers: request.headers });
  if (!s) return no(401, "NO_SESSION");
  const u = s.user as { status?: unknown; deletedAt?: unknown };
  if (u.status !== "active" || u.deletedAt) return no(403, "REFUSED");
  return { token: s.session.token, userId: s.user.id };
}

async function run(work: () => Promise<unknown>): Promise<Response> {
  try { return Response.json(await work()); } catch (e) {
    const r = accountRefusal(e);
    if (r) return no(r.status, r.code);
    throw e;
  }
}

/** GET: the login's own data as one file. No Origin check (it changes nothing but one audit row); query parameters are ignored. */
export async function exportGet(request: Request): Promise<Response> {
  const s = await session(request);
  const res = s instanceof Response ? s : await run(() => portalExport(getPool(), s.token));
  res.headers.set("cache-control", "no-store");
  if (res.ok) res.headers.set("content-disposition", `attachment; filename="${exportFilename(new Date())}"`);
  return res;
}

/** DELETE: Origin, body cap, JSON, { confirm: true }, session, rate limit, then the erase. */
export async function accountDelete(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== portalOrigin()) return no(403, "BAD_ORIGIN");
  if (Number(request.headers.get("content-length") ?? 0) > ACCOUNT_MAX_BODY) return no(413, "BODY_TOO_LARGE");
  const text = await request.text();
  if (text.length > ACCOUNT_MAX_BODY) return no(413, "BODY_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return no(400, "BAD_REQUEST"); }
  if (!checkDelete(parsed)) return no(400, "BAD_REQUEST");
  const s = await session(request);
  if (s instanceof Response) return s;
  if (!(await withinLimit(`account:${s.userId}`, DELETE_RATE))) return no(429, "TOO_MANY_REQUESTS");
  return run(() => portalDelete(getPool(), s.token));
}
