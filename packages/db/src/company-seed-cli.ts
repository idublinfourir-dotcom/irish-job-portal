// The company seed command (D2, #246; docs/database.md, "Company seed"). Run from the repo root by the owner, with the owner login (portal_owner):
// the database refuses app_admin's seed writes without a confirmed company_seed request (0047), which is the panel's path (/api/companies/seed).
//   SEED_OWNER_DATABASE_URL=... node packages/db/src/company-seed-cli.ts packages/db/seed/companies-2026-11.tsv
// A file with any bad line is refused whole, nothing written. Running the same file again writes nothing.
import { readFileSync, statSync } from "node:fs";
import pg from "pg";
import { parseSeed, seedCompanies } from "./company-seed.ts";
import { sslOptions } from "./ssl.ts";

const MAX_BYTES = 1_000_000;

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  const [file, extra] = argv;
  if (!file || extra) {
    log("usage: company-seed-cli.ts <tab-separated file>");
    return 2;
  }
  const url = env.SEED_OWNER_DATABASE_URL;
  if (!url) {
    log("SEED_OWNER_DATABASE_URL is not set (the owner login, portal_owner)");
    return 2;
  }
  const refused = (errors: string[]) => (log(`${file} is refused, nothing was written:\n${errors.join("\n")}`), 1);
  if (statSync(file).size > MAX_BYTES) return refused([`the file is over ${MAX_BYTES} bytes`]);
  const { rows, errors } = parseSeed(readFileSync(file, "utf8"));
  if (errors.length) return refused(errors);
  const db = new pg.Pool({ connectionString: url, max: 1, ssl: sslOptions(env) });
  try {
    const r = await seedCompanies(db, rows);
    log(`${r.created} companies new, ${r.found} found existing, ${r.namesAdded} names added, ${r.deteRowsLinked} DETE rows linked, ${r.refused.length} refused`);
    log(`${r.labelsChanged} permit history labels changed`);
    for (const x of [...r.refused.map((s) => `refused: ${s}`), ...r.notes, ...r.deteNotFound]) log(`  ${x}`);
  } finally {
    await db.end();
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
