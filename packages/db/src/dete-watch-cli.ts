// The weekly DETE watcher (step 15 D5; .github/workflows/weekly-registers.yml). Run from the repo root with the app_admin login:
//   DETE_WATCH_ADMIN_DATABASE_URL=... node packages/db/src/dete-watch-cli.ts
// Fetches each DETE page and Word file in WATCH once and compares it with what dete_watch (migration 0060) holds: a page by a hash of its main
// text (the raw HTML differs on every fetch: __VIEWSTATE and an elapsed-time comment), a Word file by its ETag and a hash of its bytes. The first
// run stores the baseline and raises nothing. A change writes one scheduled_check item for rules data editors (once per change, by its key),
// naming the page and, for the latest updates page, the new item titles. Nothing changes the rules: staff do that through /api/rules.
// A failed fetch (not 200, a redirect, a timeout, too big, a page with no main text) is logged and raises nothing; if every address fails, exit 1.
import { createHash } from "node:crypto";
import pg from "pg";
import { sslOptions } from "./ssl.ts";

const DETE = "https://enterprise.gov.ie";
const LISTS = `${DETE}/en/what-we-do/workplace-and-skills/economic-migration-policy/occupations-lists-and-reviews`;
// The two list pages moved on DETE's site (the old employment-permit-eligibility addresses answer 301 here, 19 Nov 2026): these are the new ones.
export const WATCH = [
  { id: "latest-updates", kind: "page", name: "Latest employment permits notices", address: `${DETE}/en/what-we-do/workplace-and-skills/employment-permits/latest-updates/` },
  { id: "csol-page", kind: "page", name: "Critical Skills Occupations List page", address: `${LISTS}/csol.html` },
  { id: "iol-page", kind: "page", name: "Ineligible Occupations List page", address: `${LISTS}/iol.html` },
  { id: "csol-docx", kind: "document", name: "Critical Skills Occupations List (Word file)", address: `${DETE}/en/publications/publication-files/critical-skills-occupations-list.docx` },
  { id: "iol-docx", kind: "document", name: "Ineligible Occupations List (Word file)", address: `${DETE}/en/publications/publication-files/ineligible-occupations-list.docx` },
] as const;
export type Watched = (typeof WATCH)[number];

export const MAX_BYTES = 10 * 1024 * 1024; // the pages are about 50 KB, the Word files about 60 KB
export const MAX_TITLE = 200, MAX_TITLES = 200, MAX_NEW = 1000; // characters of one title, titles kept, characters of the new titles in an item
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** HTML to plain text: scripts and styles dropped, a link's address kept as text (a moved Word file link is a change), tags removed, entities
 *  decoded, control characters and runs of spaces made one space. Pure. */
export function plain(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<a\b[^>]*?\bhref\s*=\s*"([^"]*)"[^>]*>/gi, " $1 ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
    })
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The page's main part (DETE's article.content-body__sections__main), or null when the page has none. Pure. */
export function mainPart(html: string): string | null {
  const start = html.search(/<article\b[^>]*content-body__sections__main/i);
  if (start < 0) return null;
  const end = html.indexOf("</article>", start);
  return html.slice(start, end < 0 ? undefined : end);
}

/** The item titles of a page (its h2 headings), plain text, each cut to MAX_TITLE characters, at most MAX_TITLES. Pure. */
export const titlesOf = (main: string): string[] =>
  [...main.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => plain(m[1]!).slice(0, MAX_TITLE)).filter(Boolean).slice(0, MAX_TITLES);

export type Seen = { fingerprint: string; titles: string[] };
/** What a fetched page or file is compared by. A page with no main text is null (a failed fetch). Pure. */
export function seen(w: Pick<Watched, "kind">, body: Buffer, etag: string | null): Seen | null {
  if (w.kind === "document") return { fingerprint: `${(etag ?? "").slice(0, 100)}|${sha(body)}`, titles: [] };
  const main = mainPart(body.toString("utf8"));
  const text = main === null ? "" : plain(main);
  return text ? { fingerprint: sha(text), titles: titlesOf(main!) } : null;
}

/** The review item for a change, or null when there is no stored value yet (the baseline) or nothing changed. Pure. */
export function changeItem(w: Watched, before: Seen | undefined, now: Seen): Record<string, string> | null {
  if (!before || before.fingerprint === now.fingerprint) return null;
  const known = new Set(before.titles);
  const fresh = now.titles.filter((t) => !known.has(t)).join("; ").slice(0, MAX_NEW);
  return { key: `dete_page_changed:${w.id}:${sha(`${before.fingerprint}>${now.fingerprint}`).slice(0, 16)}`, role: "rules_data_editor", name: w.name, address: w.address, ...(fresh ? { newTitles: fresh } : {}) };
}

/** One address, fetched once: fixed https address, no redirects, a timeout and a size cap. Throws with a short reason on any failure. */
export async function fetchOne(w: Watched, get: typeof fetch): Promise<Seen> {
  const res = await get(w.address, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (res.status !== 200 || !res.body) throw new Error(`HTTP ${res.status}`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    if ((size += c.length) > MAX_BYTES) throw new Error(`over ${MAX_BYTES} bytes`);
    chunks.push(Buffer.from(c));
  }
  const s = seen(w, Buffer.concat(chunks), res.headers.get("etag"));
  if (!s) throw new Error("the page has no main text");
  return s;
}

export const STORED = "select address, fingerprint, titles from dete_watch";
// One statement per address: keep the new value, and write the item (if any) with it. A key already written is skipped by the unique index.
export const SAVE =
  "with s as (insert into dete_watch(address, fingerprint, titles) values ($1, $2, $3::jsonb) on conflict (address) do update set fingerprint = excluded.fingerprint, " +
  "titles = excluded.titles, checked_at = now(), changed_at = case when dete_watch.fingerprint = excluded.fingerprint then dete_watch.changed_at else now() end returning 1) " +
  "insert into review_item(queue, reason, detail) select 'scheduled_check', 'dete_page_changed', $4::jsonb from s where $4::jsonb is not null " +
  "on conflict ((detail->>'key')) where queue = 'scheduled_check' do nothing";

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void, deps: { fetch: typeof fetch } = { fetch }): Promise<number> {
  if (argv.length) return log("usage: dete-watch-cli.ts (no arguments)"), 2;
  const url = env.DETE_WATCH_ADMIN_DATABASE_URL;
  if (!url) return log("DETE_WATCH_ADMIN_DATABASE_URL is not set (the app_admin login)"), 2;
  const fetched: [Watched, Seen][] = [];
  for (const w of WATCH) {
    try {
      fetched.push([w, await fetchOne(w, deps.fetch)]);
    } catch (e) {
      log(`${w.name}: fetch failed, nothing raised: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  if (!fetched.length) return log("DETE watch: every address failed"), 1;
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  try {
    await client.connect();
    const stored = new Map((await client.query<Seen & { address: string }>(STORED)).rows.map((r) => [r.address, r]));
    for (const [w, now] of fetched) {
      const before = stored.get(w.address);
      const item = changeItem(w, before, now);
      const r = await client.query(SAVE, [w.address, now.fingerprint, JSON.stringify(now.titles), item && JSON.stringify(item)]);
      log(`${w.name}: ${!before ? "baseline stored" : !item ? "unchanged" : r.rowCount ? `changed, review item written${item.newTitles ? ` (new: ${item.newTitles})` : ""}` : "changed, item already written"}`);
    }
    return 0;
  } catch (e) {
    log(`DETE watch refused: ${(e as Error).message}`); // no connection string is ever in these messages
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
