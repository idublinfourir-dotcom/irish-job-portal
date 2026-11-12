// Content reads (step 9): the updates feed, a guide by slug, a help page by slug. They read the view published_content_page, never the table, so a draft
// or withdrawn page cannot be returned (the view's own where clause), and run as app_candidate or app_portal, the roles that hold the view's select right.
// Every statement is a constant with parameters. The feed pages on (published_at, id), never OFFSET. The id is selected as text, so the order by names
// the table's own bigint id (a bare `id` in order by would mean the text output column and sort 9 after 10).
import type pg from "pg";
import { isTime, validId } from "./search";

type Db = Pick<pg.Pool, "query">;

export const UPDATES_PAGE = 20;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const validSlug = (s: unknown): s is string => typeof s === "string" && SLUG.test(s);

export class BadContentInput extends Error {}

export type ContentPage = {
  id: string; kind: string; slug: string; title: string; body: string; sourceUrl: string | null; checkedOn: string | null; publishedAt: Date; updatedAt: Date;
};
type Row = {
  id: string; kind: string; slug: string; title: string; body: string; source_url: string | null; checked_on: string | null; published_at: Date; updated_at: Date;
  published_text?: string;
};
const COLUMNS = "id::text, kind, slug, title, body, source_url, checked_on::text, published_at, updated_at";
const page = (r: Row): ContentPage => ({
  id: r.id, kind: r.kind, slug: r.slug, title: r.title, body: r.body, sourceUrl: r.source_url, checkedOn: r.checked_on, publishedAt: r.published_at, updatedAt: r.updated_at,
});

const ONE = `select ${COLUMNS} from published_content_page where kind = $1 and slug = $2`;
const FEED_FIRST = `select ${COLUMNS}, published_at::text as published_text from published_content_page where kind = 'update' order by published_at desc, published_content_page.id desc limit ${UPDATES_PAGE + 1}`;
const FEED_AFTER =
  `select ${COLUMNS}, published_at::text as published_text from published_content_page where kind = 'update' and (published_at, id) < ($1::timestamptz, $2::bigint) ` +
  `order by published_at desc, published_content_page.id desc limit ${UPDATES_PAGE + 1}`;
/** The statements, for the page budget. */
export const CONTENT_QUERIES = { one: ONE, feedFirst: FEED_FIRST, feedAfter: FEED_AFTER };

/** One published page of a kind by slug, or null (unknown, draft, withdrawn, a bad slug, or another kind). */
export async function getContent(db: Db, kind: "guide" | "help" | "occupation", slug: string): Promise<ContentPage | null> {
  if (!validSlug(slug)) return null;
  const r = (await db.query<Row>(ONE, [kind, slug])).rows[0];
  return r ? page(r) : null;
}
export const getGuide = (db: Db, slug: string) => getContent(db, "guide", slug);
export const getHelp = (db: Db, slug: string) => getContent(db, "help", slug);

export const encodeFeedCursor = (publishedText: string, id: string) => Buffer.from(JSON.stringify({ t: publishedText, i: id })).toString("base64url");
/** Throws BadContentInput for anything that is not exactly a token this module made. */
export function decodeFeedCursor(token: unknown): { t: string; i: string } {
  const bad = () => new BadContentInput("bad cursor");
  if (typeof token !== "string" || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) throw bad();
  let o: { t?: unknown; i?: unknown };
  try { o = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); } catch { throw bad(); }
  if (o === null || typeof o !== "object" || typeof o.t !== "string" || !isTime(o.t) || !validId(o.i)) throw bad();
  return { t: o.t, i: o.i };
}

export type Updates = { updates: ContentPage[]; next: string | null };

/** The updates feed, newest first. `after` is the `next` of the page before. */
export async function listUpdates(db: Db, after?: string): Promise<Updates> {
  const c = after === undefined ? null : decodeFeedCursor(after);
  const rows = (await db.query<Row>(c ? FEED_AFTER : FEED_FIRST, c ? [c.t, c.i] : [])).rows;
  const shown = rows.slice(0, UPDATES_PAGE);
  const last = shown.at(-1);
  return { updates: shown.map(page), next: rows.length > UPDATES_PAGE && last ? encodeFeedCursor(last.published_text!, last.id) : null };
}
