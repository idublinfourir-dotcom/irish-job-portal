// The company profile (P3) and the owner's close of the company (P12). GET shows the profile to any active member; POST edits description, website and
// county; the close POST needs the company's exact name typed back. The acting login always comes from the session. The database functions (migration 0031)
// check the account owner under the company's lock, write the audit row and do the work; this file refuses bad requests early and maps the refusals.
// Name, CRO number, status, verification and slug are never fields here (an unknown field is a 400), and app_portal cannot update organisation at all.
import { getPool } from "@portal/db";
import { isObject, no, ok, only, portalLogin, readPost, withinLimit, type Refusal } from "./company";
import { checkUrl, COUNTIES } from "./jobs";

export const PROFILE_RATE = { windowMs: 10 * 60_000, max: 20 }; // edits and closes together, per login
export const MAX_DESCRIPTION = 2000;
const BAD_TEXT = /[\p{Cf}]|[^\P{Cc}\n\r\t]/u; // line breaks and tabs allowed, no other control or format characters (as a job advert)
const BAD_LINE = /[\p{Cc}\p{Cf}]/u;

export type Profile = { description: string | null; website: string | null; county: (typeof COUNTIES)[number] | null };
// All three fields, each a value or null (null clears it). The description is plain text: stored as typed, escaped by the page that shows it.
export function checkProfile(b: unknown): Profile | null {
  if (!isObject(b) || !only(b, ["description", "website", "county"]) || Object.keys(b).length !== 3) return null;
  let description: string | null = null;
  if (b.description !== null) {
    if (typeof b.description !== "string") return null;
    const t = b.description.trim();
    if (t.length > MAX_DESCRIPTION || BAD_TEXT.test(t)) return null;
    description = t || null;
  }
  const website = b.website === null ? null : checkUrl(b.website);
  if (website === null && b.website !== null) return null;
  const county = b.county === null ? null : COUNTIES.find((c) => c === b.county);
  if (county === undefined) return null;
  return { description, website, county };
}

export function checkClose(b: unknown): { confirmName: string } | null {
  if (!isObject(b) || !only(b, ["confirmName"]) || typeof b.confirmName !== "string") return null;
  const t = b.confirmName.trim();
  return t.length >= 1 && t.length <= 160 && !BAD_LINE.test(t) ? { confirmName: t } : null;
}

const STATUS: Record<string, number> = { BAD_REQUEST: 400, NAME_MISMATCH: 400, NOT_OWNER: 403, ORGANISATION_NOT_AVAILABLE: 409 };
// 'team refused: CODE' (private.team_owner) or 'company refused: CODE'. An unknown code is REFUSED (fail closed, no detail).
export function profileRefusal(e: unknown): Refusal | null {
  const { code, message = "" } = (e ?? {}) as { code?: string; message?: string };
  if (code !== "P0001") return null;
  const c = /^(?:team|company) refused: ([A-Z_]+)/.exec(message)?.[1];
  return c && STATUS[c] ? { status: STATUS[c], code: c } : { status: 403, code: "REFUSED" };
}

async function call<T>(request: Request, check: (b: unknown) => T | null, sql: string, args: (body: T) => unknown[]): Promise<Response> {
  const read = await readPost(request, check, 8_000); // a 2,000-character description, escaped
  if (read instanceof Response) return read;
  const { login, body } = read;
  if (!login.membership) return no(403, "NOT_OWNER");
  if (!(await withinLimit(`profile:${login.userId}`, PROFILE_RATE))) return no(429, "TOO_MANY_REQUESTS");
  try {
    return ok((await getPool().query(sql, [login.userId, ...args(body)])).rows[0].r);
  } catch (e) {
    const r = profileRefusal(e);
    if (r) return no(r.status, r.code);
    throw e;
  }
}

export const profilePost = (r: Request) => call(r, checkProfile, "select private.company_edit($1, $2, $3, $4) r", (b) => [b.description, b.website, b.county]);
export const closePost = (r: Request) => call(r, checkClose, "select private.company_close($1, $2) r", (b) => [b.confirmName]);

// Any active member reads the company's own profile (the name and status too, read only).
export async function profileGet(request: Request): Promise<Response> {
  const login = await portalLogin(request);
  if (login instanceof Response) return login;
  if (!login.membership) return no(404, "NO_COMPANY");
  const o = (await getPool().query(
    "select id, display_name, status, short_description, website, county, logo_key is not null as has_logo, member_limit from organisation where id = $1",
    [login.membership.organisationId])).rows[0];
  return ok({ company: { organisationId: o.id, name: o.display_name, status: o.status, description: o.short_description, website: o.website,
    county: o.county, hasLogo: o.has_logo, memberLimit: o.member_limit } });
}
