// The employer status page (#44, #91, #134 to #136): GET reads the company's cases, POST { action, caseId, text } replies or appeals.
// The acting login always comes from the session. The database functions (migration 0017) make every real check; this file refuses
// bad requests early and turns the functions' refusals into short codes.
import { getPool, validId } from "@portal/db";
import { isObject, no, ok, only, portalLogin, readPost, withinLimit, type Refusal } from "./company";

export const STATUS_RATE = { windowMs: 10 * 60_000, max: 10 }; // replies and appeals together, per login

export type StatusWrite = { action: "reply" | "appeal"; caseId: string; text: string };

// Text: 1 to 1,800 characters after trimming (fits inside MAX_BODY with its JSON), line breaks and tabs allowed, no other control or format characters.
export function checkStatus(b: unknown): StatusWrite | null {
  if (!isObject(b) || !only(b, ["action", "caseId", "text"])) return null;
  const { action, caseId, text } = b;
  if (action !== "reply" && action !== "appeal") return null;
  if (!validId(caseId)) return null;
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (t.length < 1 || t.length > 1800 || /[\p{Cf}]|[^\P{Cc}\n\r\t]/u.test(t)) return null;
  return { action, caseId, text: t };
}

const STATUS: Record<string, number> = {
  BAD_REQUEST: 400, BAD_TEXT: 400, REFUSED: 403, NOT_A_MEMBER: 403, NOT_OWNER: 403, CASE_NOT_FOUND: 404,
  ALREADY_REPLIED: 409, REPLY_CLOSED: 409, ALREADY_APPEALED: 409, APPEAL_CLOSED: 409,
};
// The functions raise 'status refused: CODE ...'. A code this file does not know is REFUSED (fail closed, no detail).
export function statusRefusal(e: unknown): Refusal | null {
  const { code, message = "" } = (e ?? {}) as { code?: string; message?: string };
  if (code !== "P0001") return null;
  const c = /^status refused: ([A-Z_]+)/.exec(message)?.[1];
  return c && STATUS[c] ? { status: STATUS[c], code: c } : { status: 403, code: "REFUSED" };
}

export async function statusPost(request: Request): Promise<Response> {
  const read = await readPost(request, checkStatus);
  if (read instanceof Response) return read;
  const { login, body } = read;
  if (!(await withinLimit(`status:${login.userId}`, STATUS_RATE))) return no(429, "TOO_MANY_REQUESTS");
  try {
    return ok((await getPool().query("select private.status_write($1, $2, $3, $4) r", [login.userId, body.action, body.caseId, body.text])).rows[0].r);
  } catch (e) {
    const r = statusRefusal(e);
    if (r) return no(r.status, r.code);
    throw e;
  }
}

// Any active member reads the page. A login with no company is 404 NO_COMPANY, as the company GET.
export async function statusGet(request: Request): Promise<Response> {
  const login = await portalLogin(request);
  if (login instanceof Response) return login;
  if (!login.membership) return no(404, "NO_COMPANY");
  try {
    return ok({ page: (await getPool().query("select private.status_page($1) r", [login.userId])).rows[0].r });
  } catch (e) {
    const r = statusRefusal(e);
    if (r) return no(r.status, r.code);
    throw e;
  }
}
