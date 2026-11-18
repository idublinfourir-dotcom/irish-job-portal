// The WRC employment agency list import (#185, #208, #212): the list is one PDF made from Excel. `pdftotext -bbox` gives every word with its position,
// and the columns are read by position (Agency Name, Trading Name, Address, Licence Number); the county is the heading above each group of rows.
// Staff use only: the list is never shown publicly (#212). Every statement is a constant with parameters.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type pg from "pg";
import { ImportRefused, normaliseLicenceNumber } from "./registers.ts";

type Db = Pick<pg.Pool, "query" | "connect">;

/** Column starts on the page (points). Read from the 1 November 2026 list: names at 103, trading names at 317, addresses at 493, licence numbers at 733. */
const TRADING_FROM = 312;
const ADDRESS_FROM = 490;
const LICENCE_FROM = 725;
const HEADING_BELOW = 100; // county headings start at about x=53
const ROW_REACH = 7; // a row is about 15 points high; a word belongs to the nearest licence number within this
const MAX_FIELD = 500;

export type WrcRow = { licenceNumber: string; agencyName: string; tradingName: string | null; address: string | null; county: string | null };
export type WrcParsed = { rows: WrcRow[]; duplicates: string[]; badNumbers: number };

type Word = { x: number; xMax: number; y: number; text: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
const clean = (s: string) => s.replace(/_{2,}/g, " ").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_FIELD);

/** Words of each page from `pdftotext -bbox` output. */
export function bboxPages(html: string): Word[][] {
  return html.split("<page ").slice(1).map((page) =>
    [...page.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="[\d.]+">([^<]*)<\/word>/g)].map((m) => ({ x: +m[1]!, y: +m[2]!, xMax: +m[3]!, text: decode(m[4]!) })),
  );
}

/**
 * The agency rows of a bbox text. A row is a licence number ("EA" and its digits, in the last column); every other word within a row's reach goes to
 * the column its x position is in, and underscore runs (the list's "none") are dropped. Words at the far left alone on a line are county headings.
 * Rows with no usable number are counted in `badNumbers`; a number met again keeps its first row and is listed in `duplicates`.
 */
export function parseWrc(html: string): WrcParsed {
  const rows: WrcRow[] = [];
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  let badNumbers = 0;
  let county: string | null = null;
  for (const words of bboxPages(html)) {
    const anchors = words.filter((w) => w.x >= LICENCE_FROM && w.x < 745 && /^EA/i.test(w.text)).sort((a, b) => a.y - b.y);
    const owner = (w: Word) => {
      let best: Word | undefined;
      for (const a of anchors) if (Math.abs(a.y - w.y) <= ROW_REACH && (!best || Math.abs(a.y - w.y) < Math.abs(best.y - w.y))) best = a;
      return best;
    };
    const mine = new Map<Word, Word[]>(anchors.map((a) => [a, []]));
    const headings: { y: number; text: string[] }[] = [];
    for (const w of [...words].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const a = owner(w);
      if (a) mine.get(a)!.push(w);
      else if (w.x < HEADING_BELOW - 40) {
        const h = headings.find((h) => Math.abs(h.y - w.y) < 3);
        if (h) h.text.push(w.text);
        else headings.push({ y: w.y, text: [w.text] });
      }
    }
    // Reading order: headings and rows by height, so a row takes the last heading above it (and the one on the page before, at the top).
    const items = [...anchors.map((a) => ({ y: a.y, anchor: a })), ...headings.map((h) => ({ y: h.y, heading: clean(h.text.join(" ")) }))].sort((a, b) => a.y - b.y);
    for (const it of items) {
      if ("heading" in it) {
        county = it.heading || county;
        continue;
      }
      const a = it.anchor;
      const group = mine.get(a)!;
      // The digits start just after "EA". Address text that spills over this column can sit at the same place ("Dublin 18"), so the longest wins.
      const digits = group.filter((w) => w !== a && /^\d+$/.test(w.text) && w.x - a.xMax >= 0 && w.x - a.xMax <= 6).sort((p, q) => q.text.length - p.text.length)[0];
      const number = normaliseLicenceNumber(/^EA\s*\d+$/i.test(a.text) ? a.text : a.text + (digits?.text ?? ""));
      const parts = (pick: (w: Word) => boolean) => clean(group.filter((w) => w !== a && w !== digits && pick(w)).sort((p, q) => p.x - q.x || p.y - q.y).map((w) => w.text).join(" "));
      const agencyName = parts((w) => w.x < TRADING_FROM);
      if (!/^EA\d{1,7}$/.test(number) || !agencyName) {
        badNumbers++;
        continue;
      }
      if (seen.has(number)) {
        duplicates.push(number + (seen.get(number) === agencyName ? " (same agency again)" : " (a different agency)"));
        continue;
      }
      seen.set(number, agencyName);
      rows.push({
        licenceNumber: number, agencyName, county,
        tradingName: parts((w) => w.x >= TRADING_FROM && w.x < ADDRESS_FROM) || null,
        address: parts((w) => w.x >= ADDRESS_FROM) || null,
      });
    }
  }
  return { rows, duplicates, badNumbers };
}

/** The bbox text of a PDF file, from the pdftotext program (poppler-utils). The path is an argument, never run as code. */
export async function pdfToBbox(file: string): Promise<string> {
  const run = promisify(execFile);
  try {
    return (await run("pdftotext", ["-bbox", file, "-"], { maxBuffer: 200 * 1024 * 1024, timeout: 120_000 })).stdout;
  } catch (e) {
    throw new ImportRefused(`pdftotext failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

// ===== the database =====
export const WRC_BEFORE = "select count(*)::int as n from wrc_licence where missed_imports = 0";
export const WRC_UPSERT =
  "insert into wrc_licence(licence_number, agency_name, trading_name, address, county, first_seen_on, last_seen_on, missed_imports) " +
  "select n, a, t, d, c, $6::date, $6::date, 0 from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) as x(n, a, t, d, c) " +
  "on conflict (licence_number) do update set agency_name = excluded.agency_name, trading_name = excluded.trading_name, address = excluded.address, " +
  "county = excluded.county, last_seen_on = excluded.last_seen_on, missed_imports = 0";
export const WRC_MISSED = "update wrc_licence set missed_imports = least(missed_imports + 1, 100) where last_seen_on < $1::date returning licence_number, missed_imports";
// Adverts still open are flagged again against the new list (0047); the number changed is returned.
export const WRC_REFRESH = "select private.refresh_wrc_agency() as n";
export const RECORD_IMPORT =
  "insert into register_import(source, validator, imported_on, row_count) values ($1, $2, $3::date, $4) " +
  "on conflict (source) do update set validator = excluded.validator, imported_on = excluded.imported_on, row_count = excluded.row_count";
export const LAST_IMPORT = "select validator, row_count from register_import where source = $1";

export type WrcResult = { reflagged: number; rows: number; inserted: number; before: number; unreadable: number; duplicates: string[]; lapsed: string[] };

/**
 * Loads the parsed list in one transaction. Refused (nothing written) when it has no rows, more than 2% of rows with no usable number, or a row count more than 5% away
 * from the last list (unless `acceptCountChange`). A licence missing from this list gets missed_imports + 1; at 2 it is "possibly lapsed" and returned
 * for staff to look at: nothing is banned or removed because of it (#212).
 */
export async function importWrc(db: Db, parsed: WrcParsed, today: string, validator: string | null, opts: { acceptCountChange?: boolean } = {}): Promise<WrcResult> {
  const { rows } = parsed;
  if (!rows.length) throw new ImportRefused("the list has no agency rows");
  // A few rows can be unreadable (the PDF prints address text over the licence number); they are left out and counted. Many means the layout changed.
  if (parsed.badNumbers * 50 > rows.length) throw new ImportRefused(`${parsed.badNumbers} rows have no licence number of the form EA plus digits or no agency name: the layout may have changed`);
  const client = await db.connect();
  try {
    await client.query("begin");
    const before = (await client.query<{ n: number }>(WRC_BEFORE)).rows[0]!.n;
    if (before > 0 && !opts.acceptCountChange && Math.abs(rows.length - before) > before * 0.05)
      throw new ImportRefused(`the list has ${rows.length} agencies but the last one had ${before} (more than 5% apart): check the PDF, then run again with --accept-count-change`);
    const up = await client.query(WRC_UPSERT, [rows.map((r) => r.licenceNumber), rows.map((r) => r.agencyName), rows.map((r) => r.tradingName), rows.map((r) => r.address), rows.map((r) => r.county), today]);
    const missed = await client.query<{ licence_number: string; missed_imports: number }>(WRC_MISSED, [today]);
    const reflagged = (await client.query<{ n: number }>(WRC_REFRESH)).rows[0]!.n;
    await client.query(RECORD_IMPORT, ["wrc", validator, today, rows.length]);
    await client.query("commit");
    return { reflagged, rows: rows.length, inserted: up.rowCount ?? 0, before, unreadable: parsed.badNumbers, duplicates: parsed.duplicates, lapsed: missed.rows.filter((r) => r.missed_imports >= 2).map((r) => r.licence_number) };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
