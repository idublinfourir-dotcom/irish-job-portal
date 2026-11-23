// B38: the candidate's in-app updates (the portal's N3 notices, same shape): a list newest first and a seen marker. Run as app_candidate through the
// candidate_notification view (select and update(read_at) only). A row belongs to one candidate, so every statement filters on the session's id: another
// candidate's notice id matches no row. Params hold ids and codes only (the writers' rule); the wording is page copy. No unread count: the "N updates since"
// line was dropped by #287 (Q54), so a page counts the unread rows it was given.
import type pg from "pg";
import { QueueRefused } from "./admin-queue";
import { decodeReviewCursor } from "./account-review";
import { isObject, only, Refuse } from "./candidate-route";
import { NOTICE_PAGE, encodeNoticeCursor } from "./notices";
import { validId } from "./search";

// All on notification_candidate_idx (candidate_user_id, created_at desc, id desc).
const COLS = "id, category, template_key, params, created_at::text as created_text, read_at::text as read_at from candidate_notification where candidate_user_id = $1";
const FIRST = `select ${COLS} order by created_at desc, id desc limit ${NOTICE_PAGE + 1}`;
const AFTER = `select ${COLS} and (created_at, id) < ($2::timestamptz, $3::bigint) order by created_at desc, id desc limit ${NOTICE_PAGE + 1}`;

type Row = { id: string; category: string; template_key: string; params: unknown; created_text: string; read_at: string | null };

/** GET ?after=: one page (50) of this candidate's updates and the next page's token. A bad token is 400 BAD_CURSOR; any other query key is 400 BAD_REQUEST. */
export async function listCandidateNotices(db: pg.Pool, userId: string, url: URL) {
  const q = url.searchParams;
  if ([...q.keys()].some((k) => k !== "after") || q.getAll("after").length > 1) throw new Refuse(400, "BAD_REQUEST");
  let cursor: [string, string] | undefined;
  try { cursor = q.has("after") ? decodeReviewCursor(q.get("after")) : undefined; } catch (e) { if (e instanceof QueueRefused) throw new Refuse(400, "BAD_CURSOR"); throw e; }
  const all = (await db.query<Row>(cursor ? AFTER : FIRST, cursor ? [userId, ...cursor] : [userId])).rows;
  const rows = all.slice(0, NOTICE_PAGE);
  return {
    items: rows.map((r) => ({ id: r.id, category: r.category, templateKey: r.template_key, params: r.params, createdAt: r.created_text, readAt: r.read_at })),
    next: all.length > NOTICE_PAGE ? encodeNoticeCursor(rows.at(-1)!) : null,
  };
}

export type NoticeSeen = { action: "read"; id: string } | { action: "read_all" };
export const checkNoticeSeen = (b: unknown): NoticeSeen | null => {
  if (!isObject(b)) return null;
  if (b.action === "read" && only(b, ["action", "id"]) && validId(b.id)) return { action: "read", id: b.id };
  return b.action === "read_all" && only(b, ["action"]) ? { action: "read_all" } : null;
};

/** The seen marker: one update, or every unread one. `marked` is how many changed (another candidate's id, an unknown id or one already read is 0). */
export async function markCandidateNotices(db: pg.Pool, userId: string, b: NoticeSeen) {
  const r = b.action === "read"
    ? await db.query("update candidate_notification set read_at = now() where id = $2::bigint and candidate_user_id = $1 and read_at is null", [userId, b.id])
    : await db.query("update candidate_notification set read_at = now() where candidate_user_id = $1 and read_at is null", [userId]);
  return { marked: r.rowCount ?? 0 };
}
