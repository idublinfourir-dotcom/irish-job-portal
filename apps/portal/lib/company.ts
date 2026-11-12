// Becoming the owner of a company: the claim and register POSTs. The portal user id always comes from the session, never the
// body. The database functions do the real checks (ban, email confirmed, one company per login, #191); this file only refuses
// bad requests early and turns the functions' refusals into short codes.
import { PortalRefused, requirePortal } from "@portal/auth";
import { getPool } from "@portal/db";
import { randomUUID } from "node:crypto";
import { portalAuth, portalOrigin } from "./portal";

export const MAX_BODY = 2048; // characters; the largest good body is about 250
export const RATE = { windowMs: 10 * 60_000, max: 5 }; // claim and register together, per login

const isObject = (b: unknown): b is Record<string, unknown> => typeof b === "object" && b !== null && !Array.isArray(b);
const only = (b: Record<string, unknown>, keys: string[]) => Object.keys(b).every((k) => keys.includes(k));
const CRO = /^\d{1,8}$/; // CRO company numbers are digits
const WRC = /^[A-Za-z0-9-]{1,20}$/; // ponytail: loose until the WRC list is checked on its source (slice 3d)

export function checkClaim(b: unknown): { organisationId: number } | null {
  if (!isObject(b) || !only(b, ["organisationId"])) return null;
  const id = b.organisationId;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? { organisationId: id } : null;
}

export type Register = { kind: "employer" | "agency"; displayName: string; croNumber: string | null; wrcLicenceNumber: string | null };
// An employer gives its CRO number and no licence; an agency gives its WRC licence and may give a CRO number (checked against bans).
export function checkRegister(b: unknown): Register | null {
  if (!isObject(b) || !only(b, ["kind", "displayName", "croNumber", "wrcLicenceNumber"])) return null;
  const { kind, displayName: name, croNumber: cro, wrcLicenceNumber: wrc } = b;
  if (typeof name !== "string") return null;
  const displayName = name.trim();
  // at least one plain letter or digit, so the slug the function builds from the name is never empty; no control or format characters (right-to-left overrides and zero-width characters can make a name look like another's)
  if (displayName.length < 2 || displayName.length > 160 || !/[a-z0-9]/i.test(displayName) || /[\p{Cc}\p{Cf}]/u.test(displayName)) return null;
  // One spelling per number: no leading zeros on the CRO number, upper case for the licence. The ban check, the register lookup and the
  // unique indexes compare the exact text, so "0777001" would otherwise get past a ban on 777001 (ponytail: the database functions should do this too, one day).
  const croNumber = typeof cro === "string" && CRO.test(cro) ? cro.replace(/^0+(?=\d)/, "") : null;
  const croOk = croNumber !== null;
  if (kind === "employer" && croNumber && wrc === undefined) return { kind, displayName, croNumber, wrcLicenceNumber: null };
  if (kind === "agency" && typeof wrc === "string" && WRC.test(wrc) && (cro === undefined || croOk))
    return { kind, displayName, croNumber, wrcLicenceNumber: wrc.toUpperCase() };
  return null;
}

export type Refusal = { status: number; code: string };
// The functions' refusals as short codes. A banned email domain or company number gets the same REFUSED as a blocked login, so
// the reply never says what is banned (#191). Any other refusal raised by the functions is REFUSED too (fail closed, no detail).
export function refusalFor(e: unknown): Refusal | null {
  const { code, message = "", constraint } = (e ?? {}) as { code?: string; message?: string; constraint?: string };
  if (code === "23505") {
    if (constraint === "one_company_per_login") return { status: 409, code: "ALREADY_IN_A_COMPANY" };
    if (constraint === "one_owner_per_org") return { status: 409, code: "ORGANISATION_NOT_AVAILABLE" };
    if (constraint === "organisation_cro_unique" || constraint === "organisation_wrc_unique") return { status: 409, code: "NUMBER_ALREADY_REGISTERED" };
    return null;
  }
  if (code !== "P0001") return null;
  if (message.includes("email not verified")) return { status: 403, code: "EMAIL_NOT_VERIFIED" };
  if (message.includes("organisation is not unclaimed")) return { status: 409, code: "ORGANISATION_NOT_AVAILABLE" };
  if (/^CRO number .* already belongs/.test(message)) return { status: 409, code: "NUMBER_ALREADY_REGISTERED" };
  return { status: 403, code: "REFUSED" };
}

const no = (status: number, code: string) => Response.json({ code }, { status });

// One statement: counts this login's claim and register calls in the pool's rate-limit table (a row per login, the window
// restarts after RATE.windowMs without a call). Old rows are swept by the retention job (rule 41).
async function withinLimit(userId: string): Promise<boolean> {
  const now = Date.now();
  const { rows } = await getPool().query(
    `insert into portal_rate_limit(id, key, count, last_request) values ($1, $2, 1, $3)
     on conflict (key) do update set count = case when portal_rate_limit.last_request < $3 - $4 then 1 else portal_rate_limit.count + 1 end, last_request = $3
     returning count`, [randomUUID(), `company:${userId}`, now, RATE.windowMs]);
  return rows[0].count <= RATE.max;
}

export async function companyPost<T>(request: Request, check: (b: unknown) => T | null, sql: string, args: (userId: string, body: T) => unknown[]): Promise<Response> {
  if (request.headers.get("origin") !== portalOrigin()) return no(403, "BAD_ORIGIN");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return no(413, "BODY_TOO_LARGE"); // before the body is read
  const text = await request.text();
  if (text.length > MAX_BODY) return no(413, "BODY_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return no(400, "BAD_REQUEST"); }
  const body = check(parsed);
  if (!body) return no(400, "BAD_REQUEST");
  let login;
  try { login = await requirePortal(portalAuth(), request.headers); } catch (e) {
    if (e instanceof PortalRefused) return e.message === "no_session" ? no(401, "NO_SESSION") : no(403, "REFUSED");
    throw e;
  }
  if (login.membership) return no(409, "ALREADY_IN_A_COMPANY");
  if (!(await withinLimit(login.userId))) return no(429, "TOO_MANY_REQUESTS");
  try {
    const r = (await getPool().query(sql, args(login.userId, body))).rows[0].r as { organisation_id: number; status: string };
    return Response.json({ organisationId: Number(r.organisation_id), status: r.status });
  } catch (e) {
    const r = refusalFor(e);
    if (r) return no(r.status, r.code);
    throw e;
  }
}
