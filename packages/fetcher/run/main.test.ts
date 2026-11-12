// The fetch stops on bad rules (#229): the snapshot is checked before any board or database request, and nothing is saved.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./main";

const DATA = new URL("../data/", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of the data folder with one file changed, and every other input set, so only the rules can stop the run. */
function setUp(file: string, change: (v: unknown) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), "rules-"));
  dirs.push(dir);
  cpSync(DATA, dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(change(JSON.parse(readFileSync(join(dir, file), "utf8")))));
  vi.stubEnv("PORTAL_PRIVATE_DATA", dir);
  vi.stubEnv("FETCHER_BOARDS_FILE", join(dir, "boards.json"));
  vi.stubEnv("FETCHER_DATABASE_URL", "postgres://fake@127.0.0.1:1/none");
  vi.stubEnv("FETCHER_MODEL_ID", "fake"); vi.stubEnv("FETCHER_MODEL_URL", "https://model.example.test"); vi.stubEnv("FETCHER_MODEL_KEY", "k");
  vi.stubEnv("FETCHER_MAX_MODEL_REQUESTS", "1");
  const deps = { fetch: vi.fn(async () => { throw new Error("no request expected"); }), pool: vi.fn(() => { throw new Error("no database expected"); }) };
  return deps;
}

describe("the fetch refuses to start on bad rules", () => {
  type Entry = { list: string };
  it.each([
    ["the Critical Skills list empty", "occupation-lists.json", (v: unknown) => (v as Entry[]).filter((e) => e.list !== "critical-skills"), /Critical Skills list is empty/],
    ["the Ineligible list empty", "occupation-lists.json", (v: unknown) => (v as Entry[]).filter((e) => e.list !== "ineligible"), /Ineligible list is empty/],
    ["the occupation lists empty", "occupation-lists.json", () => [], /list is empty/],
    ["the public pay employers empty", "L2/public_employers_candidates.json", () => ({}), /public pay employers list is empty/],
  ])("%s: no board, no model and no database is touched", async (_n, file, change, why) => {
    const deps = setUp(file, change);
    await expect(main(deps as never)).rejects.toThrow(why);
    await expect(main(deps as never)).rejects.toThrow(/the fetch did not start, nothing was saved/);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.pool).not.toHaveBeenCalled();
  });
  it("good rules get past the check to the database (the fake pool is the first thing that stops it)", async () => {
    const deps = setUp("occupation-lists.json", (v) => v);
    await expect(main(deps as never)).rejects.toThrow(/no database expected/);
    expect(deps.pool).toHaveBeenCalledTimes(1);
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});
