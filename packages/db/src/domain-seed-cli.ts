// The domain seed command (Q13, #186; docs/database.md, "Domain seed"). Run from the repo root, with the app_admin login:
//   DETE_ADMIN_DATABASE_URL=... node packages/db/src/domain-seed-cli.ts <file.tsv>            (dry run: prints what it would add, skip and refuse)
//   DETE_ADMIN_DATABASE_URL=... node packages/db/src/domain-seed-cli.ts <file.tsv> --apply    (writes)
// A file with a bad header or a line without 4 columns is refused whole. Running the same file again adds nothing.
import { readFileSync, statSync } from "node:fs";
import pg from "pg";
import { parseDomainSeed, seedDomains } from "./domain-seed.ts";
import { sslOptions } from "./ssl.ts";

const MAX_BYTES = 1_000_000;

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  const args = argv.filter((a) => a !== "--apply");
  const apply = args.length < argv.length;
  if (args.length !== 1 || argv.length - args.length > 1 || args[0]!.startsWith("-")) {
    log("usage: domain-seed-cli.ts <tab-separated file> [--apply]");
    return 2;
  }
  const file = args[0]!;
  const url = env.DETE_ADMIN_DATABASE_URL;
  if (!url) {
    log("DETE_ADMIN_DATABASE_URL is not set (the app_admin login)");
    return 2;
  }
  if (statSync(file).size > MAX_BYTES) return (log(`${file} is refused, nothing was written:\nthe file is over ${MAX_BYTES} bytes`), 1);
  const p = parseDomainSeed(readFileSync(file, "utf8"));
  if (p.errors.length) return (log(`${file} is refused, nothing was written:\n${p.errors.join("\n")}`), 1);
  const db = new pg.Pool({ connectionString: url, max: 1, ssl: sslOptions(env) });
  try {
    const r = await seedDomains(db, p.rows, { apply });
    const refused = [...p.refused, ...r.refused];
    log(apply
      ? `${r.added.length} domains added, ${r.skipped.length} skipped, ${refused.length} refused`
      : `dry run, nothing written: ${r.added.length} domains would be added, ${r.skipped.length} skipped, ${refused.length} refused (add --apply to write)`);
    for (const x of r.added) log(`  ${apply ? "added" : "would add"}: ${x}`);
    for (const x of r.skipped) log(`  skipped: ${x}`);
    for (const x of refused) log(`  refused: ${x}`);
  } finally {
    await db.end();
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
