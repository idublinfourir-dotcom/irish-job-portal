// The signed-in portal user's notices (N3, #93): GET ?after= lists them a page at a time with the unread count; POST { action: "read", id } marks one
// read and { action: "read_all" } marks all. The user id always comes from the session; the database calls filter on it (packages/db/src/notices.ts).
import { checkPortalSettings, getPool, getPortalSettings, listNotices, markAllNoticesRead, markNoticeRead, putPortalSettings, QueueRefused, validId } from "@portal/db";
import { isObject, no, ok, only, portalLogin, readPost, withinLimit } from "./company";

export const NOTICE_RATE = { windowMs: 10 * 60_000, max: 120 }; // marks per login: a person clicking through a full page of 50 stays far under it

export const SETTINGS_RATE = { windowMs: 10 * 60_000, max: 30 }; // settings changes per login

export type NoticeWrite = { action: "read"; id: string } | { action: "read_all" };

export function checkNotice(b: unknown): NoticeWrite | null {
  if (!isObject(b)) return null;
  if (b.action === "read" && only(b, ["action", "id"]) && validId(b.id)) return { action: "read", id: b.id };
  if (b.action === "read_all" && only(b, ["action"])) return { action: "read_all" };
  return null;
}

export async function noticesGet(request: Request): Promise<Response> {
  const login = await portalLogin(request);
  if (login instanceof Response) return login;
  try {
    return ok(await listNotices(getPool(), login.userId, new URL(request.url).searchParams.get("after") ?? undefined));
  } catch (e) {
    if (e instanceof QueueRefused) return no(400, "BAD_CURSOR");
    throw e;
  }
}

export async function noticesPost(request: Request): Promise<Response> {
  const read = await readPost(request, checkNotice);
  if (read instanceof Response) return read;
  const { login, body } = read;
  if (!(await withinLimit(`notices:${login.userId}`, NOTICE_RATE))) return no(429, "TOO_MANY_REQUESTS");
  const marked = body.action === "read" ? await markNoticeRead(getPool(), login.userId, body.id) : await markAllNoticesRead(getPool(), login.userId);
  return ok({ marked });
}

// N7: the login's own notice settings. GET reads them; PUT { job_expiry_reminder?, account? } changes them (account only as true). Any active portal login.
export async function settingsGet(request: Request): Promise<Response> {
  const login = await portalLogin(request);
  return login instanceof Response ? login : ok(await getPortalSettings(getPool(), login.userId));
}

export async function settingsPut(request: Request): Promise<Response> {
  const read = await readPost(request, checkPortalSettings);
  if (read instanceof Response) return read;
  if (!(await withinLimit(`notice-settings:${read.login.userId}`, SETTINGS_RATE))) return no(429, "TOO_MANY_REQUESTS");
  return ok(await putPortalSettings(getPool(), read.login.userId, read.body));
}
