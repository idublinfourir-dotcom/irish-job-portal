// The two register import commands (docs/database.md, "CRO and WRC registers"). Run from the repo root; the weekly workflow runs both.
//   FETCHER_DATABASE_URL=<app_fetcher login> node packages/db/src/registers-cli.ts cro [--file companies.csv.zip]
//   WRC_ADMIN_DATABASE_URL=<app_admin login> node packages/db/src/registers-cli.ts wrc [--file list.pdf] [--force] [--accept-count-change]
// `cro` finds the file through the CRO portal's package_show and imports it. `wrc` fetches the WRC's stable alias, does nothing when the list has not
// changed (same ETag and Last-Modified as the last import) unless --force, and needs pdftotext (poppler-utils). `--file` reads a local file instead of the network.
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import pg from "pg";
import { csvRecords, croRows, importCro, openCsvInZip, type CroStats } from "./cro-import.ts";
import { ImportRefused } from "./registers.ts";
import { importWrc, LAST_IMPORT, parseWrc, pdfToBbox } from "./wrc-import.ts";
import { sslOptions } from "./ssl.ts";

export const CRO_PACKAGE_URL = "https://opendata.cro.ie/api/3/action/package_show?id=companies";
export const WRC_LIST_URL = "https://www.workplacerelations.ie/en/publications_forms/current_employment_agency_list.pdf";
const MAX_ZIP = 300 * 1024 * 1024; // the real zip is 48 MB
const MAX_PDF = 20 * 1024 * 1024; // the real list is 0.6 MB

type Deps = { fetch: typeof fetch; today?: () => string };
const sure = (url: string) => {
  if (new URL(url).protocol !== "https:") throw new ImportRefused(`${url} is not an https address`);
  return url;
};

/** Writes a response body to a file, stopping with an error if it grows past `max` bytes. */
async function save(res: Response, file: string, max: number): Promise<void> {
  if (!res.ok || !res.body) throw new ImportRefused(`download failed: HTTP ${res.status}`);
  let n = 0;
  const cap = new Transform({ transform: (c: Buffer, _e, cb) => ((n += c.length) > max ? cb(new ImportRefused(`download is over ${max} bytes`)) : cb(null, c)) });
  await pipeline(Readable.fromWeb(res.body as unknown as ReadableStream), cap, createWriteStream(file));
}

/** The address of the current companies zip, from the portal's dataset description (the file's own address has an id that can change). */
export async function croZipUrl(get: typeof fetch): Promise<string> {
  const res = await get(sure(CRO_PACKAGE_URL));
  if (!res.ok) throw new ImportRefused(`CRO package_show failed: HTTP ${res.status}`);
  const resources = ((await res.json()) as { result?: { resources?: { url?: unknown; format?: unknown }[] } }).result?.resources;
  const pick = resources?.find((r) => typeof r.url === "string" && (/\.zip$/i.test(r.url) || String(r.format).toLowerCase() === "zip"));
  if (!pick || typeof pick.url !== "string") throw new ImportRefused("CRO package_show has no zip file: the portal's shape has changed");
  return sure(pick.url);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void, deps: Deps = { fetch }): Promise<number> {
  const [command, ...rest] = argv;
  const flag = (f: string) => rest.includes(f);
  const fileAt = rest.indexOf("--file");
  const local = fileAt >= 0 ? rest[fileAt + 1] : undefined;
  if ((command !== "cro" && command !== "wrc") || (fileAt >= 0 && !local)) {
    log("usage: registers-cli.ts cro [--file <zip>], or registers-cli.ts wrc [--file <pdf>] [--force] [--accept-count-change]");
    return 2;
  }
  const envName = command === "cro" ? "FETCHER_DATABASE_URL" : "WRC_ADMIN_DATABASE_URL";
  const url = env[envName];
  if (!url) {
    log(`${envName} is not set (the ${command === "cro" ? "app_fetcher" : "app_admin"} login)`);
    return 2;
  }
  const today = (deps.today ?? (() => new Date().toISOString().slice(0, 10)))();
  const dir = await mkdtemp(join(tmpdir(), "registers-"));
  const db = new pg.Pool({ connectionString: url, max: 1, ssl: sslOptions(env) });
  const started = Date.now();
  try {
    if (command === "cro") {
      const zip = local ?? join(dir, "companies.csv.zip");
      if (!local) await save(await deps.fetch(await croZipUrl(deps.fetch)), zip, MAX_ZIP);
      const stats: CroStats = { read: 0, kept: 0, skipped: 0, repeated: 0 };
      const text = await openCsvInZip(zip);
      text.setEncoding("utf8");
      const r = await importCro(db, croRows(csvRecords(text as AsyncIterable<string>), stats), today, stats);
      await db.query("insert into register_import(source, validator, imported_on, row_count) values ('cro', null, $1::date, $2) on conflict (source) do update set imported_on = excluded.imported_on, row_count = excluded.row_count", [today, r.kept - r.repeated]);
      log(`CRO: read ${r.read} rows, kept ${r.kept} (${r.repeated} repeated numbers), skipped ${r.skipped} odd rows, ${r.marked} marked as not in the latest file, ${r.deleted} deleted after 90 days, in ${Math.round((Date.now() - started) / 1000)} s, peak memory ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
    } else {
      let pdf = local;
      let validator: string | null = null;
      if (!pdf) {
        pdf = join(dir, "list.pdf");
        const res = await deps.fetch(sure(WRC_LIST_URL));
        validator = [res.headers.get("etag"), res.headers.get("last-modified")].filter(Boolean).join("|") || null;
        const last = (await db.query<{ validator: string | null }>(LAST_IMPORT, ["wrc"])).rows[0];
        if (validator && last?.validator === validator && !flag("--force")) {
          await res.body?.cancel();
          log("WRC: the list has not changed since the last import, nothing done");
          return 0;
        }
        await save(res, pdf, MAX_PDF);
      }
      const parsed = parseWrc(await pdfToBbox(pdf));
      const r = await importWrc(db, parsed, today, validator, { acceptCountChange: flag("--accept-count-change") });
      log(`WRC: ${r.rows} agencies (last time ${r.before}), ${r.unreadable} unreadable rows left out, ${r.duplicates.length} repeated numbers${r.duplicates.map((d) => `\n  ${d}`).join("")}`);
      log(`WRC: ${r.lapsed.length} licences missing from two lists in a row, for staff to check${r.lapsed.map((n) => `\n  ${n}`).join("")}`);
      log(`WRC: ${r.reflagged} open adverts flagged again against this list`);
    }
    return 0;
  } catch (e) {
    if (!(e instanceof ImportRefused)) throw e;
    log(`${command === "cro" ? "CRO" : "WRC"} import refused: ${e.message}`);
    return 1;
  } finally {
    await db.end();
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
