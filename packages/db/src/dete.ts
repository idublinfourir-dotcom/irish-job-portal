// DETE employment permit counts (#73, #152, #154): read the tab-separated files, load them as app_admin, link a DETE legal
// name to an employer name, and read "permits in the last 5 years" for an employer. No import at run time, so a page can use it.
// Every statement is a constant with parameters; no value is ever put into SQL text.
import type pg from "pg";

type Db = Pick<pg.Pool, "query" | "connect">;

const MAX_NAME = 300;
export const MAX_ERRORS = 20;
const MAX_PERMITS = 1_000_000;
// Control characters, the replacement character and format characters (zero-width, direction marks, BOM): never part of a company name.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\ufffd\p{Cf}\u2028\u2029]/u;

export type PermitRow = { deteName: string; year: number; permits: number; sourceFile: string | null };
export type Link = { organisationNameId: string; deteName: string };
export type Parsed<T> = { rows: T[]; errors: string[] };

// Splits a file into lines of cells after checking the header. Returns the data lines with their line numbers.
export function lines(text: string, header: string[]): { n: number; cells: string[] }[] | string {
  const all = text.replace(/^﻿/, "").split("\n").map((l) => l.replace(/\r$/, ""));
  if (all.at(-1) === "") all.pop();
  if (all[0] !== header.join("\t")) return `line 1: the header must be: ${header.join(" <tab> ")}`;
  return all.slice(1).map((l, i) => ({ n: i + 2, cells: l.split("\t") }));
}

export function cleanName(raw: string): string | null {
  const name = raw.trim();
  return name && name.length <= MAX_NAME && !CONTROL.test(name) ? name : null;
}

/** Reads dete_name, year, permits, source_file. Any error means the whole file is refused. */
export function parsePermits(text: string): Parsed<PermitRow> {
  const body = lines(text, ["dete_name", "year", "permits", "source_file"]);
  if (typeof body === "string") return { rows: [], errors: [body] };
  const rows: PermitRow[] = [];
  const errors: string[] = [];
  const seen = new Map<string, number>();
  for (const { n, cells } of body) {
    const bad = (why: string) => errors.push(`line ${n}: ${why}`);
    if (cells.length !== 4) { bad(`expected 4 columns, found ${cells.length}`); continue; }
    const [rawName, rawYear, rawPermits, rawSource] = cells as [string, string, string, string];
    const deteName = cleanName(rawName);
    const year = /^\d{4}$/.test(rawYear) ? Number(rawYear) : NaN;
    const permits = /^\d{1,9}$/.test(rawPermits) ? Number(rawPermits) : NaN;
    const sourceFile = rawSource.trim();
    if (deteName === null) bad(`the name is empty, over ${MAX_NAME} characters or has control characters`);
    else if (!(year >= 2000 && year <= 2100)) bad(`the year must be 2000 to 2100, found "${rawYear}"`);
    else if (!(permits >= 1 && permits <= MAX_PERMITS)) bad(`permits must be a whole number from 1 to ${MAX_PERMITS}, found "${rawPermits}"`);
    else if (sourceFile.length > 200 || CONTROL.test(sourceFile)) bad("source_file is over 200 characters or has control characters");
    else {
      const key = `${deteName}\t${year}`;
      const first = seen.get(key);
      if (first !== undefined) bad(`the same name and year as line ${first}`);
      else { seen.set(key, n); rows.push({ deteName, year, permits, sourceFile: sourceFile || null }); }
    }
    if (errors.length >= MAX_ERRORS) break;
  }
  return { rows, errors };
}

/** Reads organisation_name_id, dete_name. */
export function parseLinks(text: string): Parsed<Link> {
  const body = lines(text, ["organisation_name_id", "dete_name"]);
  if (typeof body === "string") return { rows: [], errors: [body] };
  const rows: Link[] = [];
  const errors: string[] = [];
  const seen = new Map<string, number>();
  for (const { n, cells } of body) {
    const bad = (why: string) => errors.push(`line ${n}: ${why}`);
    if (cells.length !== 2) { bad(`expected 2 columns, found ${cells.length}`); continue; }
    const [id, rawName] = cells as [string, string];
    const deteName = cleanName(rawName);
    if (!/^[1-9]\d{0,17}$/.test(id.trim())) bad(`organisation_name_id must be a whole number, found "${id}"`);
    else if (deteName === null) bad(`the name is empty, over ${MAX_NAME} characters or has control characters`);
    else if (seen.has(deteName)) bad(`the same DETE name as line ${seen.get(deteName)}`);
    else { seen.set(deteName, n); rows.push({ organisationNameId: id.trim(), deteName }); }
    if (errors.length >= MAX_ERRORS) break;
  }
  return { rows, errors };
}

// A yearly total has no month. Same figures again change nothing (the where clause), so a re-import writes no row.
const UPSERT =
  "insert into dete_permit_count(dete_name, year, month, permits, source_file) " +
  "select t.name, t.year, null, t.permits, t.source from unnest($1::text[], $2::int[], $3::int[], $4::text[]) as t(name, year, permits, source) " +
  "on conflict (dete_name, year, month) do update set permits = excluded.permits, source_file = excluded.source_file, imported_at = now() " +
  "where (dete_permit_count.permits, dete_permit_count.source_file) is distinct from (excluded.permits, excluded.source_file) " +
  "returning (xmax = 0) as inserted";
const KNOWN_IDS = "select id::text from organisation_name where id = any($1::bigint[])";
const KNOWN_NAMES = "select distinct dete_name from dete_permit_count where dete_name = any($1::text[])";
const SET_LINKS =
  "update dete_permit_count d set organisation_name_id = l.id from unnest($1::bigint[], $2::text[]) as l(id, name) " +
  "where d.dete_name = l.name and d.organisation_name_id is distinct from l.id";
// The last 5 calendar years are $2 to $3. One pass over the linked rows through two indexes. No rows at all means "not linked".
export const LAST_5_YEARS =
  "select count(d.id)::int as linked, coalesce(sum(d.permits) filter (where d.year between $2 and $3), 0)::int as permits, " +
  "min(d.year) filter (where d.permits > 0)::int as first_year " +
  "from organisation_name n join dete_permit_count d on d.organisation_name_id = n.id where n.organisation_id = $1::bigint";

// Sets each employer's permit history label and sponsor key from the DETE rows (migrations 0007, 0008) and returns how many employers changed.
const REFRESH = "select private.refresh_permit_history() as changed";

// D6 (#49): with replaceYears, before the upsert, each name and year whose count in the file is above the stored one (0 when not stored yet) is
// written to dete_permit_rise, so staff see whose permits went up since the month before. Staff only (app_admin), never public.
const RISES =
  "insert into dete_permit_rise(dete_name, year, permits_before, permits_after) " +
  "select t.name, t.year, coalesce(d.permits, 0), t.permits from unnest($1::text[], $2::int[], $3::int[]) as t(name, year, permits) " +
  "left join dete_permit_count d on d.dete_name = t.name and d.year = t.year and d.month is null where t.permits > coalesce(d.permits, 0)";
// The rises of the newest monthly run: the January run imports two years in two transactions, so everything found within a day of the newest row.
export const LATEST_RISES =
  "select r.dete_name as \"deteName\", r.year::int, r.permits_before as \"before\", r.permits_after as \"after\", o.id::text as \"organisationId\", " +
  "o.display_name as \"organisation\", r.found_at as \"foundAt\" " +
  "from (select * from dete_permit_rise where found_at > (select max(found_at) from dete_permit_rise) - interval '1 day' " +
  "order by permits_after - permits_before desc, id limit 200) r " +
  "left join dete_permit_count d on d.dete_name = r.dete_name and d.year = r.year and d.month is null " +
  "left join organisation_name n on n.id = d.organisation_name_id left join organisation o on o.id = n.organisation_id " +
  "order by r.permits_after - r.permits_before desc, r.id";

const CHUNK = 10_000;
// For the company seed (company-seed.ts). index.ts exports this module, where other modules use the names MAX_NAME and inTransaction.
export { inTransaction as inOneTransaction, MAX_NAME as MAX_COMPANY_NAME };

async function inTransaction<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const refresh = async (c: pg.PoolClient) => (await c.query<{ changed: number }>(REFRESH)).rows[0]!.changed;

/** Recomputes every employer's permit history label and sponsor key; returns how many changed. Run daily as app_admin so the 5-year window moves on 1 January. */
export async function refreshPermitHistory(db: Db): Promise<number> {
  return (await db.query<{ changed: number }>(REFRESH)).rows[0]!.changed;
}

// With replaceYears: each year's stored total, and the rows of those years the file no longer has (set to 0, so a link survives).
const YEAR_TOTALS = "select year::int, coalesce(sum(permits), 0)::bigint as total from dete_permit_count where year = any($1::int[]) group by year";
const ZERO_MISSING =
  "update dete_permit_count d set permits = 0, imported_at = now() where d.year = any($1::int[]) and d.permits <> 0 " +
  "and not exists (select 1 from unnest($2::text[], $3::int[]) as t(name, year) where t.name = d.dete_name and t.year = d.year)";

/**
 * Upserts the rows in one transaction, 10,000 per statement, then refreshes the labels in that transaction. Run as app_admin. Never touches organisation_name_id.
 * `replaceYears` is for a newer cumulative file of a year (the monthly import): afterwards each year in the file totals exactly what the file says, so a
 * name the file dropped is set to 0 (never deleted, its link stays), and each count that went up is kept in dete_permit_rise (`rose`). It refuses a file whose total for a year is under half of what is stored (a cut-off file).
 */
export async function importPermits(db: Db, rows: PermitRow[], opts: { replaceYears?: boolean } = {}): Promise<{ inserted: number; updated: number; unchanged: number; labelsChanged: number; zeroed?: number; rose?: number }> {
  let inserted = 0;
  let updated = 0;
  let labelsChanged = 0;
  let zeroed: number | undefined;
  let rose = 0;
  await inTransaction(db, async (c) => {
    if (opts.replaceYears) {
      const years = [...new Set(rows.map((r) => r.year))];
      const stored = new Map((await c.query<{ year: number; total: string }>(YEAR_TOTALS, [years])).rows.map((r) => [r.year, Number(r.total)]));
      for (const y of years) {
        const now = rows.reduce((n, r) => n + (r.year === y ? r.permits : 0), 0);
        if (now * 2 < (stored.get(y) ?? 0)) throw new Error(`the file's total for ${y} is ${now}, under half of the ${stored.get(y)} stored: refusing, nothing was written`);
      }
    }
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      if (opts.replaceYears) rose += (await c.query(RISES, [part.map((x) => x.deteName), part.map((x) => x.year), part.map((x) => x.permits)])).rowCount ?? 0;
      const r = await c.query<{ inserted: boolean }>(UPSERT, [part.map((x) => x.deteName), part.map((x) => x.year), part.map((x) => x.permits), part.map((x) => x.sourceFile)]);
      for (const row of r.rows) if (row.inserted) inserted++; else updated++;
    }
    if (opts.replaceYears) zeroed = (await c.query(ZERO_MISSING, [[...new Set(rows.map((r) => r.year))], rows.map((r) => r.deteName), rows.map((r) => r.year)])).rowCount ?? 0;
    labelsChanged = await refresh(c);
  });
  return { inserted, updated, unchanged: rows.length - inserted - updated, labelsChanged, ...(zeroed === undefined ? {} : { zeroed, rose }) };
}

/** Sets organisation_name_id on the DETE rows of each name, then refreshes the labels in the same transaction. A name or id that is not in the database is reported and skipped. */
export async function linkNames(db: Db, links: Link[]): Promise<{ rowsChanged: number; skipped: string[]; labelsChanged: number }> {
  return inTransaction(db, async (c) => {
    const ids = new Set((await c.query<{ id: string }>(KNOWN_IDS, [[...new Set(links.map((l) => l.organisationNameId))]])).rows.map((r) => r.id));
    const names = new Set((await c.query<{ dete_name: string }>(KNOWN_NAMES, [links.map((l) => l.deteName)])).rows.map((r) => r.dete_name));
    const skipped: string[] = [];
    const good = links.filter((l) => {
      if (!ids.has(l.organisationNameId)) skipped.push(`organisation_name_id ${l.organisationNameId} does not exist (${l.deteName})`);
      else if (!names.has(l.deteName)) skipped.push(`DETE name not found: ${l.deteName}`);
      else return true;
      return false;
    });
    const r = good.length ? await c.query(SET_LINKS, [good.map((l) => l.organisationNameId), good.map((l) => l.deteName)]) : { rowCount: 0 };
    return { rowsChanged: r.rowCount ?? 0, skipped, labelsChanged: await refresh(c) };
  });
}

/**
 * Permits DETE issued to an employer in the current year and the four before, summed over every DETE row linked to any of
 * its names, and the first year with permits. null means no DETE name is linked: "not linked", which is not zero.
 */
export async function permitsLast5Years(db: Pick<pg.Pool, "query">, organisationId: number | string, now = new Date()): Promise<{ permits: number; firstYear: number | null } | null> {
  const year = now.getUTCFullYear();
  const { rows } = await db.query<{ linked: number; permits: number; first_year: number | null }>(LAST_5_YEARS, [String(organisationId), year - 4, year]);
  const r = rows[0]!;
  return r.linked === 0 ? null : { permits: r.permits, firstYear: r.first_year };
}

export type PermitRise = { deteName: string; year: number; before: number; after: number; organisationId: string | null; organisation: string | null; foundAt: Date };
/** D6: the names whose DETE count went up in the newest monthly run, biggest rise first, with the linked company when there is one. app_admin only. */
export async function latestPermitRises(db: Pick<pg.Pool, "query">): Promise<PermitRise[]> {
  return (await db.query<PermitRise>(LATEST_RISES)).rows;
}
