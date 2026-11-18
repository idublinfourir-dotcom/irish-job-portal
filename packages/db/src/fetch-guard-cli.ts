// The daily fetch's "already fetched today" guard (.github/workflows/daily-fetch.yml, scheduled runs only). Run from the repo root with
// the fetcher's login (app_fetcher, which may select from fetch_run):
//   FETCHER_DATABASE_URL=... node packages/db/src/fetch-guard-cli.ts
// FETCHER_SKIP_KINDS (a comma list, as the fetch's) leaves those boards' runs out: Workday is fetched on the engineer's laptop (W1b), so a laptop
// run never makes the GitHub run skip. Prints one line. When a fetch already worked today (UTC) it also writes `skip=true` to the file named by GITHUB_OUTPUT, so the later
// steps do not run. Exit 0 means "decided"; exit 1 means the guard could not decide, and the run must not fetch (fail closed).
import { appendFileSync } from "node:fs";
import pg from "pg";
import { sslOptions } from "./ssl.ts";

/** The start of the UTC day that `now` falls in. */
export const utcDayStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** FETCHER_SKIP_KINDS as a list: blank is none. A kind is lower-case letters only; anything else throws (the guard and the watch do not start). */
export function skipKinds(value = ""): string[] {
  const list = value.split(",").map((k) => k.trim()).filter(Boolean);
  if (value.trim() && (!list.length || list.some((k) => !/^[a-z]{1,40}$/.test(k)))) throw new Error("FETCHER_SKIP_KINDS must be a comma list of board kinds");
  return list;
}

/** The ids of the boards of the skipped kinds ($2), read once per statement (an init plan), not once per fetch_run row. */
export const SKIPPED_SOURCES = "array(select id from job_source where kind = any($2::text[]))";

/**
 * One good run today of a board not in the skipped kinds ($2, a text array): started on or after the UTC day start, finished, no error.
 * One statement; fetch_run_started_idx serves the range.
 */
export const GOOD_RUN_TODAY =
  "select 1 from fetch_run f where f.started_at >= $1 and f.finished_at is not null and f.error is null " +
  `and f.job_source_id <> all(${SKIPPED_SOURCES}) limit 1`;

/** The decision: skip when at least one good run started today. */
export const decide = (goodRunsToday: number): "skip" | "fetch" => (goodRunsToday > 0 ? "skip" : "fetch");

export async function main(env: NodeJS.ProcessEnv, log: (line: string) => void, now = new Date()): Promise<number> {
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
    const { rowCount } = await client.query(GOOD_RUN_TODAY, [utcDayStart(now), skip]);
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
