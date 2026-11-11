// The entry: one fetch of every board in FETCHER_BOARDS_FILE, saved through the app_fetcher login. The only file that reads the environment.
// It runs under vitest because the packages import each other without file endings (see vitest.run.config.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { test } from "vitest";
import { chatClient, createBatchChecker, rulesMatcher, type ListEntry } from "@portal/matcher";
import { cleanEmployerName } from "@portal/rules";
import { atsTasks, runBoards, type BoardReport, type BoardsFile, type FetcherMatcher } from "../src";

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const json = (file: string) => JSON.parse(readFileSync(file, "utf8")) as unknown;

// The rules matcher never fails. Its answer only feeds the rules chain; every badge is then checked by the model (`checkBatch` below).
const matcher: FetcherMatcher = async (title, description) => ({ match: await rulesMatcher(title, description), quote: null, modelId: "rules", failure: null });

export async function main(): Promise<BoardReport[]> {
  const started = new Date();
  // Same files and same loading as packages/rules/src/chain/assess.parity.ts.
  const lane = join(need("PORTAL_PRIVATE_DATA"), "L2");
  const deteNames = new Set((json(join(lane, "dete-2026.json")) as [string, number][]).map(([name]) => cleanEmployerName(name)));
  const publicPayCandidates = new Map<string, 1 | 2>(
    Object.entries(json(join(lane, "public_employers_candidates.json")) as Record<string, { tier: 1 | 2 }>).map(([k, v]) => [k, v.tier]),
  );
  const boards = json(need("FETCHER_BOARDS_FILE")) as BoardsFile;
  const log = (line: string) => console.log(line);

  // The model's address, key and id, the occupation lists, and the most requests this run may make (the free service allows a fixed number a day).
  const modelId = need("FETCHER_MODEL_ID");
  const client = chatClient({ fetch: globalThis.fetch, baseUrl: need("FETCHER_MODEL_URL"), key: need("FETCHER_MODEL_KEY"), model: modelId });
  const entries = json(join(need("PORTAL_PRIVATE_DATA"), "occupation-lists.json")) as ListEntry[];
  const maxModelRequests = Number(need("FETCHER_MAX_MODEL_REQUESTS"));
  if (!Number.isInteger(maxModelRequests) || maxModelRequests < 0) throw new Error("FETCHER_MAX_MODEL_REQUESTS must be a whole number, 0 or more");

  const db = new pg.Pool({ connectionString: need("FETCHER_DATABASE_URL"), max: 4 });
  try {
    const reports = await runBoards({
      db,
      now: () => new Date(),
      chain: { deteNames, publicPayCandidates },
      matcher,
      checkBatch: createBatchChecker({ client, modelId, entries }),
      batchSize: process.env.FETCHER_BATCH_SIZE ? Number(process.env.FETCHER_BATCH_SIZE) : undefined,
      maxModelRequests,
      boards: atsTasks(boards, globalThis.fetch, log),
      deadline: new Date(started.getTime() + 55 * 60 * 1000),
      log,
    });
    console.table(reports.map(({ unsaved, ...r }) => ({ ...r, unsaved: unsaved.length })));
    return reports;
  } finally {
    await db.end();
  }
}

test("fetch every board once", async () => {
  await main();
});
