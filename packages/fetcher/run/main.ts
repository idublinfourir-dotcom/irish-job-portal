// One fetch of every board in FETCHER_BOARDS_FILE, saved through the app_fetcher login. The only code that reads the environment; laptop.run.ts
// runs it under vitest because the packages import each other without file endings (see vitest.run.config.ts). `deps` lets a test fake the
// network and the database.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { loadRules } from "@portal/db/rules-data";
import { sslOptions } from "@portal/db/ssl";
import { chatClient, createBatchChecker, spacedClient, rulesMatcher, type ListEntry } from "@portal/matcher";
import { chainRules, checkSnapshot, cleanEmployerName } from "@portal/rules";
import { atsTasks, runBoards, type BoardReport, type BoardsFile, type FetcherMatcher } from "../src";

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const whole = (name: string, fallback: number) => {
  const v = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(v) || v < 0) throw new Error(`${name} must be a whole number, 0 or more`);
  return v;
};
const json = (file: string) => JSON.parse(readFileSync(file, "utf8")) as unknown;

// The rules matcher never fails. Its answer only feeds the rules chain; every badge is then checked by the model (`checkBatch` below).
const matcher: FetcherMatcher = async (title, description) => ({ match: await rulesMatcher(title, description), quote: null, modelId: "rules", failure: null });

type Deps = { fetch: typeof fetch; pool: (connectionString: string) => pg.Pool; sleep?: (ms: number) => Promise<void> };
const real = (): Deps => ({ fetch: globalThis.fetch, pool: (connectionString) => new pg.Pool({ connectionString, max: 4, ssl: sslOptions() }) });
// The rules in force on the run's UTC day, from the database (#229).
const rulesInForce = async (db: Pick<pg.Pool, "query">, day: string) => {
  try {
    return checkSnapshot(await loadRules(db, day));
  } catch (e) {
    throw new Error(`the fetch did not start, nothing was saved: ${e instanceof Error ? e.message : String(e)}`);
  }
};

export async function main(deps: Deps = real()): Promise<BoardReport[]> {
  const started = new Date();
  // Same DETE file and loading as packages/rules/src/chain/assess.parity.ts.
  const deteNames = new Set((json(join(need("PORTAL_PRIVATE_DATA"), "L2", "dete-2026.json")) as [string, number][]).map(([name]) => cleanEmployerName(name)));
  const boards = json(need("FETCHER_BOARDS_FILE")) as BoardsFile;
  const log = (line: string) => console.log(line);

  // The model's address, key and id, the occupation lists, and the most requests this run may make (the free service allows a fixed number a day).
  const modelId = need("FETCHER_MODEL_ID");
  // A batch of 13 adverts can take a large free model minutes (the 60 s default timed out); calls start a gap apart for the per-minute limit.
  const client = spacedClient(
    chatClient({ fetch: deps.fetch, baseUrl: need("FETCHER_MODEL_URL"), key: need("FETCHER_MODEL_KEY"), model: modelId, timeoutMs: whole("FETCHER_MODEL_TIMEOUT_MS", 60_000) }),
    whole("FETCHER_MODEL_GAP_MS", 0),
  );
  const maxModelRequests = Number(need("FETCHER_MAX_MODEL_REQUESTS"));
  if (!Number.isInteger(maxModelRequests) || maxModelRequests < 0) throw new Error("FETCHER_MAX_MODEL_REQUESTS must be a whole number, 0 or more");

  const db = deps.pool(need("FETCHER_DATABASE_URL"));
  try {
    // The rules first (#229): a kind with no version, a list that loads empty or a minimum missing ends the run here, before any board or model request.
    const rules = await rulesInForce(db, started.toISOString().slice(0, 10));
    const entries = rules.occupationLists as ListEntry[];
    const reports = await runBoards({
      db,
      now: () => new Date(),
      chain: { deteNames, ...chainRules(rules) },
      matcher,
      checkBatch: createBatchChecker({ client, modelId, entries }),
      batchSize: process.env.FETCHER_BATCH_SIZE ? Number(process.env.FETCHER_BATCH_SIZE) : undefined,
      maxModelRequests,
      boards: atsTasks(boards, deps.fetch, log, deps.sleep),
      sleep: deps.sleep,
      // Stops assessing at this many minutes (default 55) so the run ends inside its job's time limit.
      deadline: new Date(started.getTime() + Math.max(1, whole("FETCHER_DEADLINE_MINUTES", 55)) * 60 * 1000),
      log,
    });
    console.table(reports.map(({ unsaved, ...r }) => ({ ...r, unsaved: unsaved.length })));
    return reports;
  } finally {
    await db.end();
  }
}
