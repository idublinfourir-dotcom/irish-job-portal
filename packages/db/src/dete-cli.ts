// The two admin commands (docs/database.md, "DETE permit counts"). Run from the repo root, with the app_admin login:
//   DETE_ADMIN_DATABASE_URL=... node packages/db/src/dete-cli.ts import /path/permits.tsv
//   DETE_ADMIN_DATABASE_URL=... node packages/db/src/dete-cli.ts link /path/links.tsv
//   DETE_ADMIN_DATABASE_URL=... node packages/db/src/dete-cli.ts refresh   (daily, from .github/workflows/daily-fetch.yml)
import { readFileSync } from "node:fs";
import pg from "pg";
import { importPermits, linkNames, parseLinks, parsePermits, refreshPermitHistory } from "./dete.ts";
import { sslOptions } from "./ssl.ts";

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  const [command, file] = argv;
  if (!((command === "import" || command === "link") && file) && !(command === "refresh" && !file)) {
    log("usage: dete-cli.ts import|link <tab-separated file>, or dete-cli.ts refresh");
    return 2;
  }
  const url = env.DETE_ADMIN_DATABASE_URL;
  if (!url) {
    log("DETE_ADMIN_DATABASE_URL is not set (the app_admin login)");
    return 2;
  }
  const pool = () => new pg.Pool({ connectionString: url, max: 1, ssl: sslOptions(env) });
  if (command === "refresh") {
    const db = pool();
    try {
      log(`${await refreshPermitHistory(db)} permit history labels changed`);
    } finally {
      await db.end();
    }
    return 0;
  }
  const text = readFileSync(file!, "utf8");
  const refused = (errors: string[]) => (log(`${file} is refused, nothing was written:\n${errors.join("\n")}`), 1);
  if (command === "import") {
    const { rows, errors } = parsePermits(text);
    if (errors.length) return refused(errors);
    const db = pool();
    try {
      const r = await importPermits(db, rows);
      log(`imported ${r.inserted} new, ${r.updated} changed, ${r.unchanged} unchanged, ${r.labelsChanged} permit history labels changed`);
    } finally {
      await db.end();
    }
  } else {
    const { rows, errors } = parseLinks(text);
    if (errors.length) return refused(errors);
    const db = pool();
    try {
      const r = await linkNames(db, rows);
      log(`linked ${r.rowsChanged} DETE rows, skipped ${r.skipped.length}, ${r.labelsChanged} permit history labels changed${r.skipped.map((s) => `\n  ${s}`).join("")}`);
    } finally {
      await db.end();
    }
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
