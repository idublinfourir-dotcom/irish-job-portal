// The CRO company register import (#185, #207, #208, #210, #211): read the zip file the CRO publishes, keep Normal and "about to leave" companies, and
// upsert them into cro_company as app_fetcher. The 194 MB CSV is streamed, never held whole. Every statement is a constant with parameters.
// Zip and CSV come from outside: sizes, entry counts and field lengths are capped so a hostile file cannot fill the disk or memory.
import { open } from "node:fs/promises";
import { pipeline, Transform, type Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";
import type pg from "pg";
import { guessCounty, ImportRefused, isKeptStatus, normaliseCompanyName, normaliseCroNumber } from "./registers.ts";

type Db = Pick<pg.Pool, "query">;

const MAX_UNZIPPED = 1024 ** 3; // the real file is 194 MB
const MAX_ENTRIES = 20;
const MAX_FIELD = 2000;
const MAX_FIELDS = 100;
const BATCH = 5000;

// ===== the zip: one csv entry, read from the central directory at the end of a file on disk =====
const u16 = (b: Buffer, o: number) => b.readUInt16LE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);

/** The text of the first .csv entry of a zip file, as a stream. Refuses zip64, encryption, too many entries and anything over the size cap. */
export async function openCsvInZip(file: string): Promise<Readable> {
  const fh = await open(file, "r");
  try {
    const size = (await fh.stat()).size;
    const tail = Buffer.alloc(Math.min(size, 65557));
    await fh.read(tail, 0, tail.length, size - tail.length);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0 || eocd + 22 > tail.length) throw new ImportRefused("not a zip file");
    const [count, cdSize, cdOffset] = [u16(tail, eocd + 10), u32(tail, eocd + 12), u32(tail, eocd + 16)];
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ImportRefused("zip64 files are not accepted");
    if (count > MAX_ENTRIES) throw new ImportRefused(`the zip has ${count} files, at most ${MAX_ENTRIES} are accepted`);
    if (cdSize > 1 << 20 || cdOffset + cdSize > size) throw new ImportRefused("the zip directory is broken");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    for (let at = 0, i = 0; i < count; i++) {
      if (at + 46 > cd.length || u32(cd, at) !== 0x02014b50) throw new ImportRefused("the zip directory is broken");
      const [flags, method, comp, plain, nameLen, extraLen, commentLen, local] = [u16(cd, at + 8), u16(cd, at + 10), u32(cd, at + 20), u32(cd, at + 24), u16(cd, at + 28), u16(cd, at + 30), u16(cd, at + 32), u32(cd, at + 42)];
      const name = cd.subarray(at + 46, at + 46 + nameLen).toString("latin1");
      at += 46 + nameLen + extraLen + commentLen;
      if (!name.toLowerCase().endsWith(".csv")) continue;
      if (flags & 1) throw new ImportRefused("encrypted zip entries are not accepted");
      if (method !== 0 && method !== 8) throw new ImportRefused(`zip compression method ${method} is not accepted`);
      if (plain > MAX_UNZIPPED) throw new ImportRefused(`the csv would unzip to ${plain} bytes, over the ${MAX_UNZIPPED} limit`);
      const head = Buffer.alloc(30);
      await fh.read(head, 0, 30, local);
      if (u32(head, 0) !== 0x04034b50) throw new ImportRefused("the zip directory is broken");
      const start = local + 30 + u16(head, 26) + u16(head, 28);
      if (start + comp > size) throw new ImportRefused("the zip is cut short");
      // The declared size is the cap while unzipping: an entry that unzips to more than it says is stopped.
      let seen = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          seen += chunk.length;
          cb(seen > plain ? new ImportRefused("the csv unzips to more than the zip says") : null, chunk);
        },
      });
      const raw = fh.createReadStream({ start, end: start + comp - 1 });
      return method === 8 ? pipeline(raw, createInflateRaw(), cap, () => {}) : pipeline(raw, cap, () => {});
    }
    throw new ImportRefused("the zip has no csv file");
  } catch (e) {
    await fh.close();
    throw e;
  }
}

// ===== the csv: quoted fields, doubled quotes, line breaks inside quotes, CR LF, a BOM; long fields are cut, never grown without limit =====
/** Records of a CSV text stream. A field is cut at 2,000 characters and a record at 100 fields, so a hostile file cannot grow memory. */
export async function* csvRecords(chunks: AsyncIterable<string | Buffer>): AsyncGenerator<string[]> {
  let rec: string[] = [];
  let field = "";
  let quoted = false; // inside "..."
  let closed = false; // a closing quote was just read: a second quote straight after it is a literal quote
  let first = true;
  const add = (s: string) => {
    if (field.length < MAX_FIELD) field += s.length > MAX_FIELD - field.length ? s.slice(0, MAX_FIELD - field.length) : s;
  };
  const endField = () => {
    if (rec.length < MAX_FIELDS) rec.push(field);
    field = "";
  };
  for await (const piece of chunks) {
    let chunk = typeof piece === "string" ? piece : piece.toString("utf8");
    if (first) {
      first = false;
      chunk = chunk.replace(/^\uFEFF/, "");
    }
    let start = 0;
    const n = chunk.length;
    for (let i = 0; i < n; i++) {
      const c = chunk.charCodeAt(i);
      if (quoted) {
        if (c !== 34) continue;
        add(chunk.slice(start, i));
        start = i + 1;
        quoted = false;
        closed = true;
        continue;
      }
      if (closed) {
        closed = false;
        if (c === 34) { // "" inside a quoted field is one quote; other text after a closing quote is kept as it comes
          quoted = true;
          add('"');
          start = i + 1;
          continue;
        }
      }
      if (c === 44 || c === 10 || c === 13) {
        add(chunk.slice(start, i));
        start = i + 1;
        if (c === 13) continue; // CR is dropped; the LF ends the record
        endField();
        if (c === 10) {
          if (!(rec.length === 1 && rec[0] === "")) yield rec;
          rec = [];
        }
      } else if (c === 34 && field.length === 0 && start === i) {
        quoted = true;
        start = i + 1;
      }
    }
    add(chunk.slice(start)); // the unfinished rest of the chunk (inside quotes or not)
  }
  endField();
  if (!(rec.length === 1 && rec[0] === "") && rec.length > 0) yield rec;
}

// ===== the rows =====
export type CroRow = { croNumber: string; name: string; normalisedName: string; status: string; companyType: string | null; county: string | null; statusDate: string };
export type CroStats = { read: number; kept: number; skipped: number; repeated: number };

const NEEDED = ["company_num", "company_name", "company_status", "company_type", "company_status_date", "company_address_1", "company_address_2", "company_address_3", "company_address_4"] as const;
const clean = (s: string | undefined) => (s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim();

/**
 * Rows to keep from CSV records: the header is read by name (a missing column refuses the file), only kept statuses are returned,
 * and a row with an odd number or an empty or over-long name is counted in `skipped` and left out.
 */
export async function* croRows(records: AsyncIterable<string[]>, stats: CroStats): AsyncGenerator<CroRow> {
  let index: Record<string, number> | undefined;
  for await (const r of records) {
    const col = index;
    if (!col) {
      const names = r.map((h) => clean(h).toLowerCase());
      const missing = NEEDED.filter((h) => !names.includes(h));
      if (missing.length) throw new ImportRefused(`the CRO file has no column ${missing.join(", ")}`);
      index = Object.fromEntries(names.map((h, i) => [h, i]));
      continue;
    }
    stats.read++;
    const get = (h: (typeof NEEDED)[number]) => clean(r[col[h]!]);
    const status = get("company_status");
    if (!isKeptStatus(status)) continue;
    const croNumber = normaliseCroNumber(get("company_num"));
    const name = get("company_name");
    if (!/^\d{1,9}$/.test(croNumber) || !name || name.length >= MAX_FIELD) {
      stats.skipped++;
      continue;
    }
    stats.kept++;
    yield {
      croNumber, name, normalisedName: normaliseCompanyName(name), status, statusDate: get("company_status_date"),
      companyType: get("company_type").slice(0, 200) || null,
      county: guessCounty([get("company_address_1"), get("company_address_2"), get("company_address_3"), get("company_address_4")]),
    };
  }
  if (!index) throw new ImportRefused("the CRO file is empty");
}

// ===== the database =====
// One statement per batch. Rows are upserted by cro_number; a number met again in the same file keeps the row with the later status date
// (the earlier one wins a tie), see `better`.
export const UPSERT =
  "insert into cro_company(cro_number, name, normalised_name, status, company_type, county, last_seen_on) " +
  "select n, a, b, c, d, e, $7::date from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) as t(n, a, b, c, d, e) " +
  "on conflict (cro_number) do update set name = excluded.name, normalised_name = excluded.normalised_name, status = excluded.status, " +
  "company_type = excluded.company_type, county = excluded.county, last_seen_on = excluded.last_seen_on";
/** Rows not in this file get this status instead of being deleted at once; they are deleted once unseen for GONE_DAYS. */
export const GONE = "Not in latest file";
export const GONE_DAYS = 90;
export const MARK_GONE = `update cro_company set status = '${GONE}' where last_seen_on < $1::date and status <> '${GONE}'`;
export const DELETE_OLD = `delete from cro_company where last_seen_on < $1::date - ${GONE_DAYS}`;
export const BEFORE = `select count(*)::int as n from cro_company where status <> '${GONE}'`;

/** True when `row` should replace `old` for the same number: the later status date, and the earlier row when the dates are equal. */
export const better = (row: Pick<CroRow, "statusDate">, old: Pick<CroRow, "statusDate">): boolean => row.statusDate > old.statusDate;

export type CroResult = CroStats & { before: number; marked: number; deleted: number };

/**
 * Loads rows into cro_company with last_seen_on = `today` (an ISO date), then marks and deletes what the file no longer has. A file with fewer than
 * 80% of the kept rows we already hold is refused before anything is marked, so a cut-short download cannot make the whole register vanish.
 */
export async function importCro(db: Db, rows: AsyncIterable<CroRow>, today: string, stats: CroStats): Promise<CroResult> {
  const before = (await db.query<{ n: number }>(BEFORE)).rows[0]!.n;
  const seen = new Map<string, string>(); // number -> status date of the row written for it; ~35 MB for the real file
  let batch = new Map<string, CroRow>();
  const flush = async () => {
    if (!batch.size) return;
    const list = [...batch.values()];
    batch = new Map();
    await db.query(UPSERT, [list.map((r) => r.croNumber), list.map((r) => r.name), list.map((r) => r.normalisedName), list.map((r) => r.status), list.map((r) => r.companyType), list.map((r) => r.county), today]);
  };
  for await (const row of rows) {
    const old = seen.get(row.croNumber);
    if (old !== undefined) {
      stats.repeated++;
      if (!better(row, { statusDate: old })) continue;
    }
    seen.set(row.croNumber, row.statusDate);
    batch.set(row.croNumber, row);
    if (batch.size >= BATCH) await flush();
  }
  await flush();
  if (before > 0 && seen.size < before * 0.8) throw new ImportRefused(`the file has ${seen.size} kept companies but the register holds ${before}: refused before marking anything as gone`);
  const marked = (await db.query(MARK_GONE, [today])).rowCount ?? 0;
  const deleted = (await db.query(DELETE_OLD, [today])).rowCount ?? 0;
  return { ...stats, before, marked, deleted };
}
