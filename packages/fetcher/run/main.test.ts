// The fetch stops on bad rules (#229): the rules in force are read from the database and checked before any board or model request, and nothing is saved.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BIG_COMPANY_NAMES_V1, MINIMUMS_V1, rulesV1 } from "@portal/rules";
import { main } from "./main";

const DATA = new URL("../data/", import.meta.url).pathname;
afterEach(() => vi.unstubAllEnvs());

type Rows = { kind: string; data: unknown }[];
// The rows the rules query returns for version 1 (what the owner's seed writes).
const v1 = await rulesV1();
const today = (): Rows => [
  { kind: "minimums", data: MINIMUMS_V1 },
  { kind: "critical_skills_list", data: v1.occupationLists.filter((o) => o.list === "critical-skills") },
  { kind: "ineligible_list", data: v1.occupationLists.filter((o) => o.list === "ineligible") },
  { kind: "public_pay_employers", data: v1.publicPayEmployers },
  { kind: "big_company_names", data: BIG_COMPANY_NAMES_V1.map((name) => ({ name, test: "brand", link: null, readOn: null, reviewOn: null })) },
];

/** Every input set and a fake database that answers only the rules query, so only the rules can stop the run before the boards. */
function setUp(rows: Rows) {
  vi.stubEnv("PORTAL_PRIVATE_DATA", DATA);
  vi.stubEnv("FETCHER_BOARDS_FILE", `${DATA}boards.json`);
  vi.stubEnv("FETCHER_DATABASE_URL", "postgres://fake@127.0.0.1:1/none");
  vi.stubEnv("FETCHER_MODEL_ID", "fake"); vi.stubEnv("FETCHER_MODEL_URL", "https://model.example.test"); vi.stubEnv("FETCHER_MODEL_KEY", "k");
  vi.stubEnv("FETCHER_MAX_MODEL_REQUESTS", "1");
  const sql: string[] = [];
  const db = {
    query: vi.fn(async (text: string) => {
      sql.push(text);
      if (/rules_version/.test(text)) return { rows };
      throw new Error("no other query expected");
    }),
    end: vi.fn(async () => {}),
  };
  const deps = { fetch: vi.fn(async () => { throw new Error("no request expected"); }), pool: vi.fn(() => db) };
  return { deps, db, sql };
}

describe("the fetch refuses to start on bad rules", () => {
  const without = (kind: string) => today().filter((r) => r.kind !== kind);
  const emptied = (kind: string) => today().map((r) => (r.kind === kind ? { kind, data: Array.isArray(r.data) ? [] : {} } : r));
  it.each([
    ["no Critical Skills list", without("critical_skills_list"), /no critical_skills_list version/],
    ["no minimums", without("minimums"), /no minimums version/],
    ["an empty Ineligible list", emptied("ineligible_list"), /ineligible_list/],
    ["no public pay employers", emptied("public_pay_employers"), /public_pay_employers/],
    ["no big-company names", emptied("big_company_names"), /big_company_names/],
    ["nothing seeded", [], /version is in force/],
  ])("%s: no board and no model is touched, only the rules query ran", async (_n, rows, why) => {
    const { deps, db, sql } = setUp(rows);
    await expect(main(deps as never)).rejects.toThrow(why);
    await expect(main(deps as never)).rejects.toThrow(/the fetch did not start, nothing was saved/);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(sql.every((q) => /rules_version/.test(q))).toBe(true);
    expect(db.end).toHaveBeenCalled();
  });
  it("good rules get past the check: the run goes on to the boards (each refused by the fake database before any request)", async () => {
    const { deps, sql } = setUp(today());
    const reports = await main(deps as never);
    expect(reports.length).toBeGreaterThan(0);
    expect(sql.filter((q) => !/rules_version/.test(q)).length).toBeGreaterThan(0);
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});
