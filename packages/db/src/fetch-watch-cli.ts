// The fetch watch (.github/workflows/fetch-watch.yml, late in the day). A failed run already emails the engineer; this catches a daily fetch
// that never started. With the fetcher's login (app_fetcher) it asks the guard's question. Exit 0: a fetch worked today (UTC). Exit 1 (red run,
// so GitHub sends its email): none did; it starts a guarded "Daily fetch" run unless one is already queued or running. Exit 2: not configured.
//   FETCHER_DATABASE_URL=... GH_TOKEN=... GH_REPO=owner/repo node packages/db/src/fetch-watch-cli.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { GOOD_RUN_TODAY, utcDayStart } from "./fetch-guard-cli.ts";
import { sslOptions } from "./ssl.ts";

const WORKFLOW = "daily-fetch.yml";
const OPEN = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

/** The real gh. Fixed arguments only; the token and repository come from the environment. */
const realGh = async (args: string[]): Promise<string> => (await promisify(execFile)("gh", args, { timeout: 60_000 })).stdout;

/** The decision and the action, on any connection (a fake in the unit tests). Returns the exit code. */
export async function watch(db: Pick<pg.ClientBase, "query">, log: (line: string) => void, now: Date, gh = realGh): Promise<number> {
  if ((await db.query(GOOD_RUN_TODAY, [utcDayStart(now)])).rowCount) return log("a fetch worked today (UTC)"), 0;
  const hhmm = now.toISOString().slice(11, 16);
  const runs: { status: string }[] = JSON.parse(await gh(["run", "list", "--workflow", WORKFLOW, "--limit", "20", "--json", "status"]));
  if (runs.some((r) => OPEN.has(r.status))) return log(`no fetch worked today by ${hhmm} UTC; one is already running`), 1;
  // guarded=true: the started run goes through the same guard as a scheduled one, so it cannot fetch twice if a fetch lands meanwhile.
  await gh(["workflow", "run", WORKFLOW, "-f", "guarded=true"]);
  return log(`no fetch worked today by ${hhmm} UTC; started one`), 1;
}

export async function main(env: NodeJS.ProcessEnv, log: (line: string) => void, now = new Date(), gh = realGh): Promise<number> {
  const url = env.FETCHER_DATABASE_URL;
  if (!url) return log("FETCHER_DATABASE_URL is not set (the app_fetcher login)"), 2;
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await watch(client, log, now, gh);
  } catch (e) {
    // Only the error's name and code: a connection error must never carry the connection string into a log.
    const err = e as { name?: string; code?: string };
    log(`the watch could not finish (${err.name ?? "error"} ${err.code ?? ""})`.replace(" )", ")"));
    return 1;
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.env, console.log);
