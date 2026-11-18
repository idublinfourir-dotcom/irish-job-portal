// The fetch watch (.github/workflows/fetch-watch.yml, late in the day). A failed run already emails the engineer; this catches a daily fetch
// that never started. With the fetcher's login (app_fetcher) it asks the guard's question. Exit 0: a fetch worked today (UTC). Exit 1 (red run,
// so GitHub sends its email): none did; it starts a guarded "Daily fetch" run unless one is already queued or running. Exit 2: not configured.
// When a fetch worked but some boards' last try today failed (14 Nov 2026: Workday's Saturday maintenance), it starts one unguarded retry and
// stays green. FETCHER_SKIP_KINDS (as the guard's) leaves out the boards fetched elsewhere (W1b: Workday on the laptop), so a laptop run
// neither counts as today's fetch nor, when it failed or never ran, starts a GitHub retry. The two watch slots land hours after the daily fetch, so the retry usually falls after the maintenance window.
//   FETCHER_DATABASE_URL=... GH_TOKEN=... GH_REPO=owner/repo node packages/db/src/fetch-watch-cli.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { GOOD_RUN_TODAY, SKIPPED_SOURCES, skipKinds, utcDayStart } from "./fetch-guard-cli.ts";
import { sslOptions } from "./ssl.ts";

const WORKFLOW = "daily-fetch.yml";
const OPEN = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

/** The real gh. Fixed arguments only; the token and repository come from the environment. */
const realGh = async (args: string[]): Promise<string> => (await promisify(execFile)("gh", args, { timeout: 60_000 })).stdout;

/** Boards not in the skipped kinds ($2) whose last finished try today failed, with no good try after it. fetch_run_started_idx serves the range. */
export const FAILED_BOARDS_TODAY =
  "select count(distinct f.job_source_id)::int as n from fetch_run f " +
  `where f.started_at >= $1 and f.finished_at is not null and f.error is not null and f.job_source_id <> all(${SKIPPED_SOURCES}) ` +
  "and not exists (select 1 from fetch_run g where g.job_source_id = f.job_source_id and g.id > f.id and g.started_at >= $1 and g.finished_at is not null and g.error is null)";

/** The decision and the action, on any connection (a fake in the unit tests). Returns the exit code. */
export async function watch(db: Pick<pg.ClientBase, "query">, log: (line: string) => void, now: Date, gh = realGh, skip: string[] = []): Promise<number> {
  const day = utcDayStart(now);
  const running = async () => (JSON.parse(await gh(["run", "list", "--workflow", WORKFLOW, "--limit", "20", "--json", "status"])) as { status: string }[]).some((r) => OPEN.has(r.status));
  if ((await db.query(GOOD_RUN_TODAY, [day, skip])).rowCount) {
    const failed: number = (await db.query(FAILED_BOARDS_TODAY, [day, skip])).rows[0].n;
    if (!failed) return log("a fetch worked today (UTC)"), 0;
    const head = `a fetch worked today (UTC) but ${failed} board${failed === 1 ? "" : "s"} failed`;
    if (await running()) return log(`${head}; one is already running`), 0;
    // guarded=false: the guard would skip, since a fetch worked. ponytail: at most one retry per watch slot (two a day); a board that is broken
    // for good gets two extra one-minute runs a day. Add a per-board limit (job_source.last_ok_at) if that ever costs real Actions minutes.
    await gh(["workflow", "run", WORKFLOW, "-f", "guarded=false"]);
    return log(`${head}; started a retry`), 0;
  }
  const hhmm = now.toISOString().slice(11, 16);
  if (await running()) return log(`no fetch worked today by ${hhmm} UTC; one is already running`), 1;
  // guarded=true: the started run goes through the same guard as a scheduled one, so it cannot fetch twice if a fetch lands meanwhile.
  await gh(["workflow", "run", WORKFLOW, "-f", "guarded=true"]);
  return log(`no fetch worked today by ${hhmm} UTC; started one`), 1;
}

export async function main(env: NodeJS.ProcessEnv, log: (line: string) => void, now = new Date(), gh = realGh): Promise<number> {
  const url = env.FETCHER_DATABASE_URL;
  if (!url) return log("FETCHER_DATABASE_URL is not set (the app_fetcher login)"), 2;
  let skip: string[];
  try {
    skip = skipKinds(env.FETCHER_SKIP_KINDS);
  } catch (e) {
    return log((e as Error).message), 2;
  }
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await watch(client, log, now, gh, skip);
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
