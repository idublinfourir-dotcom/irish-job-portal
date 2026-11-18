// Pay floors (#82, #100): GET lists the company's floors and the wording to sign, POST { action, ... } signs or withdraws one. The acting member always
// comes from the session, never the body. The database refuses an agency, an employer off the big-company list and a member who may not sign
// (pay_floor_insert, signer_check); this file refuses bad requests early and turns refusals into short codes.
import { cleanFamily, createPayFloor, FloorRefused, getPool, getRules, listAnswer, listPayFloors, MAX_FLOOR_EUR, validId, withdrawPayFloor, type FloorMember, type ListEntries } from "@portal/db";
import { isObject, no, ok, only, portalLogin, readPost, withinLimit } from "./company";
import { portalOrigin } from "./portal";

export const FLOOR_RATE = { windowMs: 10 * 60_000, max: 10 }; // signs and withdrawals together, per login

export type FloorWrite =
  | { action: "sign"; roleFamily: string; floorEur: number; consentTextId: string }
  | { action: "withdraw"; floorId: string };

/** `lists`: the occupation lists in force (#229); a role family is a four-digit code that is not on the Ineligible list (#231). */
export function checkFloor(b: unknown, lists: ListEntries): FloorWrite | null {
  if (!isObject(b)) return null;
  if (b.action === "sign" && only(b, ["action", "roleFamily", "floorEur", "consentTextId"])) {
    const family = cleanFamily(b.roleFamily), eur = b.floorEur, text = b.consentTextId;
    if (family === null || listAnswer(lists, family) === "no" || typeof eur !== "number" || !Number.isInteger(eur) || eur < 1 || eur > MAX_FLOOR_EUR) return null;
    if (!validId(text)) return null;
    return { action: "sign", roleFamily: family, floorEur: eur, consentTextId: text };
  }
  if (b.action === "withdraw" && only(b, ["action", "floorId"]) && validId(b.floorId))
    return { action: "withdraw", floorId: b.floorId };
  return null;
}

const STATUS: Record<string, number> = {
  BAD_REQUEST: 400, REFUSED: 403, NOT_BIG_COMPANY: 403, NOT_SIGNER: 403, NOT_FOUND: 404,
  NO_CONSENT_TEXT: 409, TEXT_CHANGED: 409, ALREADY_PENDING: 409, NOT_WITHDRAWABLE: 409,
};
const ACTIVE_COMPANY = ["verified", "verified_restricted"];

export async function floorPost(request: Request): Promise<Response> {
  // the Origin first, as on every portal write, so a cross-site request costs no rules read (readPost checks it again)
  if (request.headers.get("origin") !== portalOrigin()) return no(403, "BAD_ORIGIN");
  const lists = (await getRules(getPool())).occupationLists;
  const read = await readPost(request, (b) => checkFloor(b, lists));
  if (read instanceof Response) return read;
  const { login, body } = read;
  const m = login.membership;
  if (!m) return no(403, "REFUSED");
  if (!(await withinLimit(`floors:${login.userId}`, FLOOR_RATE))) return no(429, "TOO_MANY_REQUESTS");
  const who: FloorMember = { membershipId: m.id, organisationId: m.organisationId, role: m.role };
  try {
    if (body.action === "withdraw") {
      await withdrawPayFloor(getPool(), who, body.floorId);
      return ok({ ok: true });
    }
    if (!ACTIVE_COMPANY.includes(m.organisationStatus)) return no(403, "REFUSED");
    return ok(await createPayFloor(getPool(), who, body));
  } catch (e) {
    if (e instanceof FloorRefused) return no(STATUS[e.message] ?? 403, STATUS[e.message] ? e.message : "REFUSED");
    throw e;
  }
}

// Every active member sees the company's own floors (a viewer included, like the other lists); a login with no company sees none.
export async function floorGet(request: Request): Promise<Response> {
  const login = await portalLogin(request);
  if (login instanceof Response) return login;
  if (!login.membership) return ok({ text: null, floors: [] });
  return ok(await listPayFloors(getPool(), login.membership.organisationId));
}
