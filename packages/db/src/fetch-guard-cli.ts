// The daily fetch's "already fetched today" guard (.github/workflows/daily-fetch.yml, scheduled runs only). Run from the repo root with
// the fetcher's login (app_fetcher, which may select from fetch_run):
//   FETCHER_DATABASE_URL=... node packages/db/src/fetch-guard-cli.ts
// Prints one line. When a fetch already worked today (UTC) it also writes `skip=true` to the file named by GITHUB_OUTPUT, so the later
// steps do not run. Exit 0 means "decided"; exit 1 means the guard could not decide, and the run must not fetch (fail closed).
import { appendFileSync } from "node:fs";
import pg from "pg";
import { sslOptions } from "./ssl.ts";

/** The start of the UTC day that `now` falls in. */
export const utcDayStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** One good run today: started on or after the UTC day start, finished, no error. One statement; fetch_run_started_idx serves the range. */
export const GOOD_RUN_TODAY = "select 1 from fetch_run where started_at >= $1 and finished_at is not null and error is null limit 1";

/** The decision: skip when at least one good run started today. */
export const decide = (goodRunsToday: number): "skip" | "fetch" => (goodRunsToday > 0 ? "skip" : "fetch");

export async function main(env: NodeJS.ProcessEnv, log: (line: string) => void, now = new Date()): Promise<number> {
  const url = env.FETCHER_DATABASE_URL;
  if (!url) return log("FETCHER_DATABASE_URL is not set (the app_fetcher login)"), 2;
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const { rowCount } = await client.query(GOOD_RUN_TODAY, [utcDayStart(now)]);
    if (decide(rowCount ?? 0) === "fetch") return log("no fetch has worked yet today (UTC): fetching"), 0;
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, "skip=true\n");
    log("a fetch already worked today (UTC): skipping this one");
    return 0;
  } catch (e) {
    // Only the error's name and code: a connection error must never carry the connection string into a log.
    const err = e as { name?: string; code?: string };
    log(`the guard could not tell whether a fetch ran today (${err.name ?? "error"} ${err.code ?? ""}): not fetching`.replace(" )", ")"));
    return 1;
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.env, console.log);
