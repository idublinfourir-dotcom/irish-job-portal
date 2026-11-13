// The monthly DETE company file (#73): download one year's .xlsx and turn it into the import file (dete_name, year, permits, source_file)
// that dete-cli.ts import reads. Replaces dete_yearly_exact.py for the layout of 2021 and later (the 2019 and 2020 files never change).
import { readXlsx, XlsxRefused, type Row } from "./xlsx.ts";

export const DETE_HOST = "enterprise.gov.ie";
export const MAX_DOWNLOAD = 10 * 1024 * 1024; // the 2026 file is 0.5 MB
export const deteUrl = (year: number) => `https://${DETE_HOST}/en/publications/publication-files/employment-permits-issued-to-companies-${year}.xlsx`;
export const sourceFileName = (year: number) => `companies-${year}.xlsx`;

/** The year's file, or null when DETE answers 404 ("not published yet"). Fixed host and path, no redirects, a size cap, and the zip signature. */
export async function downloadDete(year: number, get: typeof fetch): Promise<Buffer | null> {
  if (!Number.isInteger(year) || year < 2021 || year > 2100) throw new XlsxRefused(`no DETE file layout for the year ${year}`);
  const res = await get(deteUrl(year), { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (res.status === 404) return null;
  if (!res.ok || !res.body) throw new XlsxRefused(`download of ${year} failed: HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_DOWNLOAD) throw new XlsxRefused(`download of ${year} is over ${MAX_DOWNLOAD} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > MAX_DOWNLOAD) throw new XlsxRefused(`download of ${year} is over ${MAX_DOWNLOAD} bytes`);
    chunks.push(Buffer.from(c));
  }
  const buf = Buffer.concat(chunks);
  if (buf.subarray(0, 4).toString("latin1") !== "PK\x03\x04") throw new XlsxRefused(`the reply for ${year} is not an .xlsx file (it does not start like a zip)`);
  return buf;
}

// What Python's str.split() treats as white space, without the control characters and without U+FEFF (those are refused, not mended).
const SPACE = /[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
const MAX_COUNT = 1_000_000;

/**
 * The rows of one DETE company sheet (employer in column A, one Total column) as the import file's text. The Total column is the first
 * column after A whose header ends in "Total" in the first six rows ("Total", "Grand Total", or 2026's "Permits Issued Grand Total"). Zero counts are left out; a negative, fractional, huge or text
 * count refuses the whole file. Names are cleaned like the Python script did, and the same name twice is added up.
 */
export function companiesToTsv(rows: Row[], year: number): string {
  let total = -1;
  for (const r of rows.filter((x) => x.n <= 6).sort((a, b) => a.n - b.n))
    for (const [i, c] of [...r.cells].sort((a, b) => a[0] - b[0]))
      if (total < 0 && i > 0 && typeof c === "string" && c.trim().toLowerCase().endsWith("total")) total = i;
  if (total < 0) throw new XlsxRefused('no "Total" column in the first six rows');
  const sums = new Map<string, number>();
  for (const r of rows) {
    const raw = r.cells.get(0);
    if (typeof raw !== "string" || ["grand total", "total", "employer name"].includes(raw.trim().toLowerCase())) continue;
    const name = raw.split(SPACE).filter(Boolean).join(" ");
    const v = r.cells.get(total);
    if (!name || v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_COUNT) throw new XlsxRefused(`row ${r.n}: the count must be a whole number from 0 to ${MAX_COUNT}, found "${v}"`);
    if (v > 0) sums.set(name, (sums.get(name) ?? 0) + v);
  }
  if (!sums.size) throw new XlsxRefused("the sheet holds no employer with a permit");
  const file = sourceFileName(year);
  return "dete_name\tyear\tpermits\tsource_file\n" + [...sums].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([n, p]) => `${n}\t${year}\t${p}\t${file}\n`).join("");
}

/** A downloaded file to the import file's text. */
export const xlsxToTsv = (buf: Buffer, year: number): string => companiesToTsv(readXlsx(buf), year);
