// Becoming the owner of a company: the claim and register POSTs. The portal user id always comes from the session, never the
// body. The database functions do the real checks (ban, email confirmed, one company per login, #191); this file only refuses
// bad requests early and turns the functions' refusals into short codes.
import { PortalRefused, requirePortal, type PortalLogin } from "@portal/auth";
import { getPool, toWire, validId, withinRate } from "@portal/db";
import { portalAuth, portalOrigin } from "./portal";

export const MAX_BODY = 2048; // characters; the largest good body is about 250
export const RATE = { windowMs: 10 * 60_000, max: 5 }; // claim and register together, per login

export const isObject = (b: unknown): b is Record<string, unknown> => typeof b === "object" && b !== null && !Array.isArray(b);
export const only = (b: Record<string, unknown>, keys: string[]) => Object.keys(b).every((k) => keys.includes(k));
const CRO = /^\d{1,8}$/; // CRO company numbers are digits
const WRC = /^[A-Za-z0-9-]{1,20}$/; // ponytail: loose until the WRC list is checked on its source (slice 3d)

export function checkClaim(b: unknown): { organisationId: string } | null {
  return isObject(b) && only(b, ["organisationId"]) && validId(b.organisationId) ? { organisationId: b.organisationId } : null;
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
  // One spelling per number, the same cleaning register_organisation does (#210, migration 0014): spaces and a leading IE removed and no
  // leading zeros on the CRO number; spaces removed, upper case and EA added to bare digits for the licence. The ban check, the register
  // lookup and the unique indexes compare the exact text, so "0777001" or "IE 777001" would otherwise get past a ban on 777001.
  const c = typeof cro === "string" ? cro.replace(/\s+/g, "").replace(/^ie/i, "") : null;
  const croNumber = c !== null && CRO.test(c) ? c.replace(/^0+(?=\d)/, "") : null;
  const w = typeof wrc === "string" ? wrc.replace(/\s+/g, "").toUpperCase() : null;
  const licence = w !== null && /^\d+$/.test(w) ? `EA${w}` : w;
  const croOk = croNumber !== null;
  if (kind === "employer" && croNumber && wrc === undefined) return { kind, displayName, croNumber, wrcLicenceNumber: null };
  if (kind === "agency" && licence !== null && WRC.test(licence) && (cro === undefined || croOk))
    return { kind, displayName, croNumber, wrcLicenceNumber: licence };
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
  if (message.includes("COOL_DOWN")) return { status: 429, code: "CLAIM_COOL_DOWN" }; // #203: this login's claim of this company was rejected under 24 hours ago
  if (message.includes("organisation is not unclaimed")) return { status: 409, code: "ORGANISATION_NOT_AVAILABLE" };
  if (/^CRO number .* already belongs/.test(message)) return { status: 409, code: "NUMBER_ALREADY_REGISTERED" };
  return { status: 403, code: "REFUSED" };
}

export const no = (status: number, code: string) => Response.json({ code }, { status });
/** A 200 reply in the shared format (toWire): ids as strings of digits, times as ISO 8601 in UTC with Z. */
export const ok = (body: unknown) => Response.json(toWire(body));

// Counts this login's calls under one key in the pool's rate-limit table (a row per login and key, a fixed window from the first call; see
// withinRate). Old rows are swept by the retention job (rule 41).
export const withinLimit = (key: string, rate: { windowMs: number; max: number } = RATE) => withinRate("portal_rate_limit", key, rate);

// The checks every portal POST makes before its database call, in this order: the portal's own Origin, the body size (by header,
// then by length), JSON, the body check, then a session from requirePortal. `max` is the body cap in characters (a job post carries its advert text). Returns the reply to send, or the login and the body.
export async function readPost<T>(request: Request, check: (b: unknown) => T | null, max = MAX_BODY): Promise<Response | { login: PortalLogin; body: T }> {
  if (request.headers.get("origin") !== portalOrigin()) return no(403, "BAD_ORIGIN");
  if (Number(request.headers.get("content-length") ?? 0) > max) return no(413, "BODY_TOO_LARGE"); // before the body is read
  const text = await request.text();
  if (text.length > max) return no(413, "BODY_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return no(400, "BAD_REQUEST"); }
  const body = check(parsed);
  if (!body) return no(400, "BAD_REQUEST");
  const login = await portalLogin(request);
  return login instanceof Response ? login : { login, body };
}

/** requirePortal, with its refusals as replies: no session is 401 NO_SESSION, a blocked or deleted login 403 REFUSED. */
export async function portalLogin(request: Request): Promise<Response | PortalLogin> {
  try { return await requirePortal(portalAuth(), request.headers); } catch (e) {
    if (e instanceof PortalRefused) return e.message === "no_session" ? no(401, "NO_SESSION") : no(403, "REFUSED");
    throw e;
  }
}

export async function companyPost<T>(request: Request, check: (b: unknown) => T | null, sql: string, args: (userId: string, body: T) => unknown[]): Promise<Response> {
  const read = await readPost(request, check);
  if (read instanceof Response) return read;
  const { login, body } = read;
  if (login.membership) return no(409, "ALREADY_IN_A_COMPANY");
  if (!(await withinLimit(`company:${login.userId}`))) return no(429, "TOO_MANY_REQUESTS");
  try {
    const r = (await getPool().query(sql, args(login.userId, body))).rows[0].r as { organisation_id: number; status: string };
    return ok({ organisationId: r.organisation_id, status: r.status });
  } catch (e) {
    const r = refusalFor(e);
    if (r) return no(r.status, r.code);
    throw e;
  }
}
