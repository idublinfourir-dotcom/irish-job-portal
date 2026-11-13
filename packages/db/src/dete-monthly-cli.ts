// The monthly DETE import (.github/workflows/monthly-dete.yml). Run from the repo root with the app_admin login:
//   DETE_ADMIN_DATABASE_URL=... node packages/db/src/dete-monthly-cli.ts
// Downloads this year's company file from DETE (and last year's final one during January), turns each into the import file, and loads it
// so the year totals what the newest file says. Every file is downloaded and checked before anything is written. In January a 404 for
// the new year means "not published yet" (exit 0); any other failure exits 1. Linking new DETE names to companies stays by hand (dete-cli.ts link).
import pg from "pg";
import { importPermits, parsePermits, type PermitRow } from "./dete.ts";
import { downloadDete, sourceFileName, xlsxToTsv } from "./dete-monthly.ts";
import { sslOptions } from "./ssl.ts";

export async function main(env: NodeJS.ProcessEnv, log: (line: string) => void, deps: { fetch: typeof fetch; now?: Date } = { fetch }): Promise<number> {
  const url = env.DETE_ADMIN_DATABASE_URL;
  if (!url) return log("DETE_ADMIN_DATABASE_URL is not set (the app_admin login)"), 2;
  const now = deps.now ?? new Date();
  const year = now.getUTCFullYear();
  const january = now.getUTCMonth() === 0;
  const files: { year: number; rows: PermitRow[] }[] = [];
  try {
    for (const y of january ? [year - 1, year] : [year]) {
      const buf = await downloadDete(y, deps.fetch);
      if (!buf) {
        if (january && y === year) { log(`DETE has not published the ${y} file yet: nothing to do`); continue; }
        throw new Error(`DETE has no ${y} file (HTTP 404)`);
      }
      const { rows, errors } = parsePermits(xlsxToTsv(buf, y));
      if (errors.length) return log(`the ${y} file is refused, nothing was written:\n${errors.join("\n")}`), 1;
      files.push({ year: y, rows });
    }
    if (!files.length) return 0;
    const db = new pg.Pool({ connectionString: url, max: 1, ssl: sslOptions(env) });
    try {
      for (const f of files) {
        const r = await importPermits(db, f.rows, { replaceYears: true });
        log(`${f.year} (${sourceFileName(f.year)}): ${f.rows.length} employers, ${r.inserted} new, ${r.updated} changed, ${r.unchanged} unchanged, ${r.zeroed} dropped by DETE and set to 0, ${r.labelsChanged} permit history labels changed`);
      }
    } finally {
      await db.end();
    }
    return 0;
  } catch (e) {
    log(`the DETE import failed, nothing more was written: ${(e as Error).message}`); // no connection string is ever in these messages
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.env, console.log);
