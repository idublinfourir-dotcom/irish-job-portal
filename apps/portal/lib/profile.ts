// The company profile (P3) and the owner's close of the company (P12). GET shows the profile to any active member; POST edits description, website and
// county; the close POST needs the company's exact name typed back. The acting login always comes from the session. The database functions (migration 0031)
// check the account owner under the company's lock, write the audit row and do the work; this file refuses bad requests early and maps the refusals.
// Name, CRO number, status, verification and slug are never fields here (an unknown field is a 400), and app_portal cannot update organisation at all.
import { COMPANY_QUERIES, FIRST_PERMIT_YEAR, getPool, getRules, summarisePermits } from "@portal/db";
import { publicPayCandidatesOf, publicPayTier } from "@portal/rules";
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

// Any active member reads the company's own profile (the name, status and the facts from the records too, read only). Labels are the public page's
// (company page, public-pages.ts); croStatus is the register's own word; permitCount is the DETE permits since permitsSince, null when no DETE name is linked.
export const COMPANY_READ = "select id, slug, kind, display_name, status, short_description, website, county, logo_url, logo_key is not null as has_logo, member_limit, claimed_at, " +
  "claims_removed_at, permit_history, cro_number, (select c.status from cro_company c where c.cro_number = o.cro_number) as cro_status, " +
  "(select coalesce(json_agg(x.name order by x.name), '[]') from (select name from organisation_name where organisation_id = o.id and kind = 'legal' order by name limit 20) x) as legal_names " +
  "from organisation o where id = $1";
export async function profileGet(request: Request): Promise<Response> {
  const login = await portalLogin(request);
  if (login instanceof Response) return login;
  if (!login.membership) return no(404, "NO_COMPANY");
  const id = login.membership.organisationId;
  const [org, permits, rules] = await Promise.all([getPool().query(COMPANY_READ, [id]), getPool().query(COMPANY_QUERIES.permits, [id]), getRules(getPool())]);
  const o = org.rows[0];
  // #67: the tier of the public pay-deal list (1 HSE, 2 section 38, 0 none) by the company's names; an agency never has one (#39, CF98: the permit employer is the public body itself)
  const pay = publicPayCandidatesOf(rules);
  const publicPay = o.kind === "agency" ? 0 : Math.max(0, ...[o.display_name, ...o.legal_names].map((n: string) => publicPayTier(n, pay)));
  const labels = [o.permit_history === "first_time" && "First-time sponsor", o.permit_history === "not_linked" && "Permit history not linked yet", o.claims_removed_at && "Sponsorship claims removed"].filter(Boolean);
  const p = summarisePermits(permits.rows);
  return ok({ company: { organisationId: o.id, slug: o.slug, kind: o.kind, name: o.display_name, status: o.status, description: o.short_description, descriptionMax: MAX_DESCRIPTION,
    website: o.website, county: o.county, logoUrl: o.logo_url, hasLogo: o.has_logo, memberLimit: o.member_limit,
    claimed: o.claimed_at !== null && (o.status === "verified" || o.status === "verified_restricted"), labels,
    croNumber: o.cro_number, croStatus: o.cro_status, legalNames: o.legal_names, publicPayTier: publicPay, permitHistory: o.permit_history, permitsSince: FIRST_PERMIT_YEAR, permitCount: p && p.byYear.reduce((n, y) => n + y.permits, 0) } });
}
