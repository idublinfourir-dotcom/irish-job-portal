// The portal user's in-app notices (N3, #93): list newest first, count unread, mark one or all read. Run as app_portal through the
// portal_notification view, which grants select and update(read_at) only. A notice is addressed to one portal user (notification.portal_user_id;
// the writers put the company id in params), so every statement filters on the session's user id: another user's notice id matches no row.
import type pg from "pg";
import { decodeReviewCursor } from "./account-review";
import { validId } from "./search";

export const NOTICE_PAGE = 50;
export const UNREAD_CAP = 200; // counts are capped at 200, as search counts are; 200 reads "200 or more"

// All on notification_portal_idx (portal_user_id, created_at desc, id desc). The id stays a bigint (pg hands it over as text): an "id::text as id" would make
// "order by id" sort the text.
const COLS = "id, category, template_key, params, created_at::text as created_text, read_at::text as read_at from portal_notification where portal_user_id = $1";
export const NOTICES_FIRST = `select ${COLS} order by created_at desc, id desc limit ${NOTICE_PAGE + 1}`;
export const NOTICES_AFTER = `select ${COLS} and (created_at, id) < ($2::timestamptz, $3::bigint) order by created_at desc, id desc limit ${NOTICE_PAGE + 1}`;
export const UNREAD = `select count(*)::int as n from (select 1 from portal_notification where portal_user_id = $1 and read_at is null limit ${UNREAD_CAP}) x`;
export const MARK_ONE = "update portal_notification set read_at = now() where id = $2::bigint and portal_user_id = $1 and read_at is null";
export const MARK_ALL = "update portal_notification set read_at = now() where portal_user_id = $1 and read_at is null";

type Row = { id: string; category: string; template_key: string; params: unknown; created_text: string; read_at: string | null };
export type Notice = { id: string; category: string; templateKey: string; params: unknown; createdAt: string; readAt: string | null };

/** The same {t, i} token shape as the review queue's, so its decoder (decodeReviewCursor) reads it. */
export const encodeNoticeCursor = (r: { created_text: string; id: string }) => Buffer.from(JSON.stringify({ t: r.created_text, i: r.id })).toString("base64url");

/** One page of this user's notices (newest first), the next page's token, and the unread count (capped at UNREAD_CAP). A bad token is QueueRefused("bad_cursor"). */
export async function listNotices(db: Pick<pg.Pool, "query">, userId: string, after?: string): Promise<{ items: Notice[]; next: string | null; unread: number }> {
  const cursor = after === undefined ? undefined : decodeReviewCursor(after);
  const all = (await db.query<Row>(cursor ? NOTICES_AFTER : NOTICES_FIRST, cursor ? [userId, ...cursor] : [userId])).rows;
  const rows = all.slice(0, NOTICE_PAGE);
  const unread = (await db.query<{ n: number }>(UNREAD, [userId])).rows[0]!.n;
  return {
    items: rows.map((r) => ({ id: r.id, category: r.category, templateKey: r.template_key, params: r.params, createdAt: r.created_text, readAt: r.read_at })),
    next: all.length > NOTICE_PAGE ? encodeNoticeCursor(rows.at(-1)!) : null,
    unread,
  };
}

/** Marks one of this user's notices read. Returns 1 when it was unread, else 0 (already read, someone else's, or no such id). */
export async function markNoticeRead(db: Pick<pg.Pool, "query">, userId: string, id: string): Promise<number> {
  return validId(id) ? ((await db.query(MARK_ONE, [userId, id])).rowCount ?? 0) : 0;
}

/** Marks every unread notice of this user read; returns how many. */
export async function markAllNoticesRead(db: Pick<pg.Pool, "query">, userId: string): Promise<number> {
  return (await db.query(MARK_ALL, [userId])).rowCount ?? 0;
}
