// The content editor (#234 D3, 20c section 2): drafts of content_page (guide, update, help, occupation) are written by a content editor; a content editor publishes
// help pages and updates and withdraws any page; a rules-data editor publishes guides and occupation texts. The database already refuses to publish anything but
// help without a source and a checked-on date (content_page_check); that stays the last word and is mapped to a short code here. The writer is recorded in
// updated_by_staff_user_id. Terms and privacy texts have their own two-person route (legal-texts.ts, /api/legal-texts) and are not here.
import type pg from "pg";
import { isSoc2010 } from "@portal/rules";
import { QueueRefused } from "./admin-queue";
import { HELP_CATEGORIES, UPDATE_CATEGORIES, validSlug } from "./content";
import { isTime, validId } from "./search";
import { requireRole } from "./staff-admin";
import { AUDIT } from "./trust-safety";

type Q = Pick<pg.Pool, "query">;
type Db = Pick<pg.Pool, "query" | "connect">;

export const KINDS = ["guide", "update", "help", "occupation", "notice"] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ["draft", "published", "withdrawn"] as const;
export const MAX_TITLE = 200;
export const MAX_BODY_CHARS = 50_000;
export const MAX_SOURCE_URL = 500;
export const CONTENT_PAGE = 20;
/** Who publishes what. A content editor does not publish a guide or an occupation text: they state rules and numbers, so a rules-data editor approves them (20c). */
export const PUBLISHER: Record<Kind, "content_editor" | "rules_data_editor"> = { help: "content_editor", update: "content_editor", notice: "content_editor", guide: "rules_data_editor", occupation: "rules_data_editor" };

const ctrl = /[\p{Cc}\p{Cf}]/u;
const title = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= MAX_TITLE && !ctrl.test(v);
// the body keeps its line breaks and tabs, and nothing else invisible
const body = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= MAX_BODY_CHARS && !ctrl.test(v.replace(/[\n\r\t]/g, ""));
function sourceUrl(v: unknown): boolean {
  if (typeof v !== "string" || v.length > MAX_SOURCE_URL || ctrl.test(v)) return false;
  try {
    return ["https:", "http:"].includes(new URL(v).protocol);
  } catch {
    return false;
  }
}
function checkedOn(v: unknown): boolean {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\d$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v && v <= new Date().toISOString().slice(0, 10);
}

/** The day an update's rule starts: a real calendar day, any year (it may be in the future, unlike checked-on). */
function effectiveFrom(v: unknown): boolean {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\d$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}
const category = (v: unknown) => typeof v === "string" && ([...UPDATE_CATEGORIES, ...HELP_CATEGORIES] as readonly string[]).includes(v);

export type Draft = { kind: string; slug: string; title: string; body: string; sourceUrl?: string; checkedOn?: string; category?: string; effectiveFrom?: string };
export type Edit = { title?: string; body?: string; sourceUrl?: string; checkedOn?: string; category?: string; effectiveFrom?: string };

function checkFields(i: Edit): void {
  if (i.title !== undefined && !title(i.title)) throw new QueueRefused("bad_title");
  if (i.body !== undefined && !body(i.body)) throw new QueueRefused("bad_body_text");
  if (i.sourceUrl !== undefined && !sourceUrl(i.sourceUrl)) throw new QueueRefused("bad_source_url");
  if (i.checkedOn !== undefined && !checkedOn(i.checkedOn)) throw new QueueRefused("bad_checked_on");
  if (i.category !== undefined && !category(i.category)) throw new QueueRefused("bad_category");
  if (i.effectiveFrom !== undefined && !effectiveFrom(i.effectiveFrom)) throw new QueueRefused("bad_effective_from");
}
/** The database's own pairing rules (an update's category is not a help category; only an update has an effective day) as short codes. */
function pairing(e: unknown): never {
  const k = (e as { code?: string; constraint?: string });
  if (k.code === "23514" && k.constraint === "content_page_category_check") throw new QueueRefused("bad_category");
  if (k.code === "23514" && k.constraint === "content_page_effective_check") throw new QueueRefused("bad_effective_from");
  throw e;
}
/** Slug rules: lower-case letters, digits and hyphens as the public reads accept (content.ts); an occupation page's slug is its SOC 2010 code (0018). */
export function checkSlug(kind: string, slug: unknown): string {
  if (!validSlug(slug) || (kind === "occupation" && !isSoc2010(slug))) throw new QueueRefused("bad_slug");
  return slug;
}
const isKind = (k: unknown): k is Kind => typeof k === "string" && (KINDS as readonly string[]).includes(k);

const EDITORS = ["content_editor", "rules_data_editor", "administrator"] as const;
const audit = (c: Q, staff: string, action: string, id: string, after: object) => c.query(AUDIT, [staff, `content.${action}`, "content_page", id, JSON.stringify(after), null, null, null]);

async function writer<T>(db: Db, staff: string, any: readonly string[], why: string, fn: (c: pg.PoolClient, roles: string[]) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("begin");
    const roles = await requireRole(c, staff, any, why);
    const out = await fn(c, roles);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// ===== reads: a content editor, a rules-data editor or an administrator =====
const COLS =
  "id::text as id, kind, slug, title, status, source_url, checked_on::text as checked_on, published_at::text as published_at, updated_by_staff_user_id, updated_at::text as updated_text, " +
  "category, effective_from::text as effective_from";
export type ContentRow = {
  id: string; kind: string; slug: string; title: string; status: string; source_url: string | null; checked_on: string | null; published_at: string | null;
  updated_by_staff_user_id: string | null; updated_text: string; category: string | null; effective_from: string | null;
};
const summary = (r: ContentRow) => ({
  id: r.id, kind: r.kind, slug: r.slug, title: r.title, status: r.status, sourceUrl: r.source_url, checkedOn: r.checked_on, publishedAt: r.published_at,
  updatedBy: r.updated_by_staff_user_id, updatedAt: r.updated_text, category: r.category, effectiveFrom: r.effective_from,
});
// Newest change first on (updated_at, id). ponytail: no index on updated_at; the table is a few hundred rows (guides, help, updates, one text per occupation).
export const CONTENT_LIST =
  `select ${COLS} from content_page where ($1::text is null or kind = $1) and ($2::text is null or status = $2) and ($3::timestamptz is null or (updated_at, id) < ($3::timestamptz, $4::bigint)) ` +
  `order by updated_at desc, id desc limit ${CONTENT_PAGE + 1}`;
export const CONTENT_ONE = `select ${COLS}, body from content_page where id = $1::bigint`;

/** Pages of every state, newest change first, 20 a page. */
export async function listContentPages(db: Q, staff: string, o: { kind?: string; status?: string; after?: string } = {}) {
  if (o.kind !== undefined && !isKind(o.kind)) throw new QueueRefused("bad_kind");
  if (o.status !== undefined && !(STATUSES as readonly string[]).includes(o.status)) throw new QueueRefused("bad_status");
  let cursor: [string, string] | [null, null] = [null, null];
  if (o.after !== undefined) {
    const bad = new QueueRefused("bad_cursor");
    if (o.after.length > 200 || !/^[A-Za-z0-9_-]+$/.test(o.after)) throw bad;
    let t: { t?: unknown; i?: unknown };
    try { t = JSON.parse(Buffer.from(o.after, "base64url").toString("utf8")); } catch { throw bad; }
    if (t === null || typeof t !== "object" || typeof t.t !== "string" || !isTime(t.t) || !validId(t.i)) throw bad;
    cursor = [t.t, t.i];
  }
  await requireRole(db, staff, EDITORS, "not_content_staff");
  const all = (await db.query<ContentRow>(CONTENT_LIST, [o.kind ?? null, o.status ?? null, cursor[0], cursor[1]])).rows;
  const rows = all.slice(0, CONTENT_PAGE);
  const last = rows.at(-1);
  return { items: rows.map(summary), next: all.length > CONTENT_PAGE && last ? Buffer.from(JSON.stringify({ t: last.updated_text, i: last.id })).toString("base64url") : null };
}

// Q14 (20c: "a list of stale checked-on dates"; B74 adds help and occupation pages): published guides, help and occupation pages whose checked-on date is over STALE_DAYS old,
// oldest first. A help page with no checked-on date is not listed: help may be published without one. ponytail: 90 days is a placeholder until the owner names the period;
// content_page_stale_idx covers guides only, and the table is a few hundred rows (one text per occupation), so the other kinds are read by a scan.
export const STALE_DAYS = 90;
export const STALE_KINDS = ["guide", "help", "occupation"] as const;
export const CONTENT_STALE =
  `select ${COLS} from content_page where kind = any($2::text[]) and status = 'published' and checked_on < current_date - $1::int order by checked_on, id limit 101`;

/** Published guides, help and occupation pages (or one of those kinds) not checked for STALE_DAYS, oldest first, at most 100. Any other kind is bad_kind. */
export async function listStaleContent(db: Q, staff: string, kind?: string) {
  if (kind !== undefined && !(STALE_KINDS as readonly string[]).includes(kind)) throw new QueueRefused("bad_kind");
  await requireRole(db, staff, EDITORS, "not_content_staff");
  const rows = (await db.query<ContentRow>(CONTENT_STALE, [STALE_DAYS, kind === undefined ? STALE_KINDS : [kind]])).rows;
  return { staleDays: STALE_DAYS, items: rows.slice(0, 100).map(summary), truncated: rows.length > 100 };
}

/** One page with its body, whatever its state. null for an unknown or malformed id. */
export async function getContentPage(db: Q, staff: string, id: string) {
  await requireRole(db, staff, EDITORS, "not_content_staff");
  if (!validId(id)) return null;
  const r = (await db.query<ContentRow & { body: string }>(CONTENT_ONE, [id])).rows[0];
  return r ? { ...summary(r), body: r.body } : null;
}

/** What the public page of this content page would be made from, whatever its state (B74): the fields the public reads give (content.ts ContentPage), plus the state. null for an unknown id. */
export async function previewContentPage(db: Q, staff: string, id: string) {
  const p = await getContentPage(db, staff, id);
  return p && { id: p.id, kind: p.kind, slug: p.slug, title: p.title, body: p.body, sourceUrl: p.sourceUrl, checkedOn: p.checkedOn, publishedAt: p.publishedAt, updatedAt: p.updatedAt, category: p.category, effectiveFrom: p.effectiveFrom, status: p.status };
}

// ===== writes =====
const INSERT =
  "insert into content_page(kind, slug, title, body, source_url, checked_on, updated_by_staff_user_id, category, effective_from) values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9::date) returning id::text as id";
/** A new draft. Only a content editor writes drafts. */
export async function createContentDraft(db: Db, staff: string, d: Draft): Promise<{ id: string }> {
  if (!isKind(d.kind)) throw new QueueRefused("bad_kind");
  checkSlug(d.kind, d.slug);
  if (!title(d.title)) throw new QueueRefused("bad_title");
  if (!body(d.body)) throw new QueueRefused("bad_body_text");
  checkFields(d);
  return writer(db, staff, ["content_editor"], "not_content_editor", async (c) => {
    try {
      const id = (await c.query<{ id: string }>(INSERT, [d.kind, d.slug, d.title, d.body, d.sourceUrl ?? null, d.checkedOn ?? null, staff, d.category ?? null, d.effectiveFrom ?? null])).rows[0]!.id;
      await audit(c, staff, "create", id, { kind: d.kind, slug: d.slug });
      return { id };
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new QueueRefused("slug_taken");
      return pairing(e);
    }
  });
}

const EDIT =
  "update content_page set title = coalesce($2, title), body = coalesce($3, body), source_url = coalesce($4, source_url), checked_on = coalesce($5::date, checked_on), " +
  "category = coalesce($7, category), effective_from = coalesce($8::date, effective_from), updated_by_staff_user_id = $6, updated_at = now() where id = $1::bigint and status in ('draft','withdrawn') returning kind, slug";
const STATE = "select status from content_page where id = $1::bigint";
/** Edits a draft (or a withdrawn page, to fix it before publishing again). A published page is withdrawn first. Kind and slug never change. */
export async function editContentDraft(db: Db, staff: string, id: string, e: Edit): Promise<void> {
  if (!validId(id)) throw new QueueRefused("not_found");
  checkFields(e);
  if (Object.values(e).every((v) => v === undefined)) throw new QueueRefused("nothing_to_change");
  await writer(db, staff, ["content_editor"], "not_content_editor", async (c) => {
    const r = (await c.query(EDIT, [id, e.title ?? null, e.body ?? null, e.sourceUrl ?? null, e.checkedOn ?? null, staff, e.category ?? null, e.effectiveFrom ?? null]).catch(pairing)).rows[0];
    if (!r) throw new QueueRefused((await c.query(STATE, [id])).rowCount ? "not_editable" : "not_found");
    await audit(c, staff, "edit", id, { fields: Object.keys(e).filter((k) => (e as Record<string, unknown>)[k] !== undefined) });
  });
}

const KIND_OF = "select kind, status from content_page where id = $1::bigint for update";
const PUBLISH = "update content_page set status = 'published', published_at = now(), updated_by_staff_user_id = $2, updated_at = now() where id = $1::bigint and status in ('draft','withdrawn')";
/** Publishes a draft or a withdrawn page: help and updates by a content editor, guides and occupation texts by a rules-data editor. The database wants a source and a date. */
export async function publishContent(db: Db, staff: string, id: string): Promise<void> {
  if (!validId(id)) throw new QueueRefused("not_found");
  await writer(db, staff, ["content_editor", "rules_data_editor"], "not_publisher", async (c, roles) => {
    const p = (await c.query<{ kind: Kind; status: string }>(KIND_OF, [id])).rows[0];
    if (!p) throw new QueueRefused("not_found");
    if (!roles.includes(PUBLISHER[p.kind])) throw new QueueRefused(`not_${PUBLISHER[p.kind]}`);
    if (p.status === "published") throw new QueueRefused("already_published");
    try {
      await c.query(PUBLISH, [id, staff]);
    } catch (e) {
      if ((e as { code?: string }).code === "23514") throw new QueueRefused("needs_source_and_checked_on"); // content_page_check
      throw e;
    }
    await audit(c, staff, "publish", id, { kind: p.kind });
  });
}

const WITHDRAW = "update content_page set status = 'withdrawn', updated_by_staff_user_id = $2, updated_at = now() where id = $1::bigint and status = 'published' returning kind";
/** Takes a published page down. A content editor withdraws any kind. */
export async function withdrawContent(db: Db, staff: string, id: string): Promise<void> {
  if (!validId(id)) throw new QueueRefused("not_found");
  await writer(db, staff, ["content_editor"], "not_content_editor", async (c) => {
    const r = (await c.query<{ kind: string }>(WITHDRAW, [id, staff])).rows[0];
    if (!r) throw new QueueRefused((await c.query(STATE, [id])).rowCount ? "not_published" : "not_found");
    await audit(c, staff, "withdraw", id, { kind: r.kind });
  });
}
