// The Workday move (W1c; docs/database.md, "Workday move"). Run once from the repo root with the fetcher's login, while no fetch runs:
//   FETCHER_DATABASE_URL=... node packages/db/src/workday-move-cli.ts            (dry run: prints what it would move)
//   FETCHER_DATABASE_URL=... node packages/db/src/workday-move-cli.ts --apply    (writes, in one transaction)
// Running it again moves nothing.
import pg from "pg";
import { sslOptions } from "./ssl.ts";
import { moveWorkday } from "./workday-move.ts";

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  const apply = argv.length === 1 && argv[0] === "--apply";
  if (argv.length > 1 || (argv.length === 1 && !apply)) {
    log("usage: workday-move-cli.ts [--apply]");
    return 2;
  }
  const url = env.FETCHER_DATABASE_URL;
  if (!url) {
    log("FETCHER_DATABASE_URL is not set (the app_fetcher login)");
    return 2;
  }
  const db = new pg.Pool({ connectionString: url, max: 1, ssl: sslOptions(env) });
  try {
    const r = await moveWorkday(db, { apply });
    log(apply ? `${r.moved.length} Workday adverts moved, ${r.jobs} jobs with them` : `dry run, nothing written: ${r.moved.length} Workday adverts would move (add --apply to write)`);
    for (const [board, b] of Object.entries(r.boards)) log(`  ${board}: ${b.moved} ${apply ? "moved" : "would move"}, ${b.taken} already under the new source, ${b.noId} with no requisition id (stay)`);
    for (const x of r.moved) log(`  ${apply ? "moved" : "would move"}: ${x}`);
  } finally {
    await db.end();
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
