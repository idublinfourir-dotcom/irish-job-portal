// The signed-in portal user's notices (N3, #93): GET ?after= lists them a page at a time with the unread count; POST { action: "read", id } marks one
// read and { action: "read_all" } marks all. The user id always comes from the session; the database calls filter on it (packages/db/src/notices.ts).
import { getPool, listNotices, markAllNoticesRead, markNoticeRead, QueueRefused, validId } from "@portal/db";
import { isObject, no, ok, only, portalLogin, readPost, withinLimit } from "./company";

export const NOTICE_RATE = { windowMs: 10 * 60_000, max: 120 }; // marks per login: a person clicking through a full page of 50 stays far under it

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
