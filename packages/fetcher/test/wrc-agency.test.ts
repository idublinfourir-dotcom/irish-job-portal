// D8 (#212, migration 0042): the fetcher's adverts are flagged wrc_agency when the employer name matches an agency or trading name on the WRC
// licensed agency list, through the real runBoards as app_fetcher. Staff only: app_fetcher still cannot read the list, the candidate and portal
// roles cannot read the flag, and the name pattern in @portal/rules is unchanged. Fake names only; no network.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isAgencyName } from "@portal/rules";
import { createTestDb, type TestDb } from "../../db/test/db";
import { assertPageBudget, measurePages } from "../../db/test/perf/pages";
import { runBoards, type BoardTask } from "../src";
import { advert, deps, plan, task } from "./helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb;
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p).then((r) => r.rows);
const run = (boards: BoardTask[], kind: "passed" | "reject") => runBoards(deps(db.pool("app_fetcher"), boards), (x) => plan(x, kind));
let n = 0;
const flag = async (externalId: string) => (await su("select wrc_agency from fetched_advert where external_id = $1", [externalId]))[0]?.wrc_agency;

beforeAll(async () => {
  db = await createTestDb();
  await su("insert into wrc_licence(licence_number, agency_name, trading_name) values ('EA9001', 'FAKE PLACEMENTS IRELAND LIMITED', 'Quick Fake Staff'), ('EA9002', 'Other Fake Agency Ltd', null)");
});
afterAll(() => db.drop());

describe("the WRC agency flag on fetched adverts", () => {
  it.each([
    ["the agency name, other case and punctuation", "Fake Placements Ireland Limited", true, "passed"],
    ["the trading name", "quick-fake staff", true, "passed"],
    ["a rejected advert too", "Other Fake Agency Ltd.", true, "reject"],
    ["a name on no licence", "Fake Placements Ireland", false, "passed"],
    ["an empty name", "", false, "reject"],
  ] as const)("%s", async (_, employer, expected, kind) => {
    const a = advert(`w${++n}`, { employer });
    await run([task("fake", `wrc${n}`, [a])], kind);
    expect(await flag(a.id)).toBe(expected);
  });

  it("follows the employer name when the advert is rewritten, and the fetcher cannot set it itself", async () => {
    const a = advert(`w${++n}`, { employer: "Plain Fake Bakery Ltd" });
    await run([task("fake", `wrc${n}`, [a])], "reject");
    expect(await flag(a.id)).toBe(false);
    const fetcher = db.pool("app_fetcher");
    await fetcher.query("update fetched_advert set employer_name = 'Quick Fake Staff' where external_id = $1", [a.id]);
    expect(await flag(a.id)).toBe(true);
    await fetcher.query("update fetched_advert set wrc_agency = false where external_id = $1", [a.id]);
    expect(await flag(a.id)).toBe(true); // the trigger decides, whatever the writer sends
  });

  it("the name pattern is kept: a WRC match is a separate signal and changes no verdict", () => {
    expect(isAgencyName("Fake Placements Ireland Limited")).toBe(true); // "placement": both signals
    for (const name of ["Quick Fake Staff", "Other Fake Agency Ltd"]) expect(isAgencyName(name), name).toBe(false); // on the WRC list, missed by the pattern: what the flag adds
  });

  it.each(["app_candidate", "app_portal", "anon", "authenticated"] as const)("%s cannot read the flag", async (role) => {
    await expect(db.query(role, "select wrc_agency from fetched_advert limit 1")).rejects.toMatchObject({ code: "42501" });
  });

  it("app_fetcher still cannot read the WRC list or call the trigger function, and app_admin reads the flag", async () => {
    await expect(db.query("app_fetcher", "select 1 from wrc_licence limit 1")).rejects.toMatchObject({ code: "42501" });
    await expect(db.query("app_fetcher", "select private.fetched_advert_wrc()")).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("app_admin", "select count(*)::int n from fetched_advert where wrc_agency")).rows[0].n).toBeGreaterThan(0);
  });

  it("hostile names are only data", async () => {
    for (const [employer, expected] of [["x'; update wrc_licence set agency_name = null; --", false], ["a".repeat(300), false], ["\u202eQuick Fake Staff", true]] as const) {
      const a = advert(`w${++n}`, { employer });
      await run([task("fake", `wrc${n}`, [a])], "reject");
      expect(await flag(a.id), employer).toBe(expected); // a direction mark is dropped by the normalising, as in the fetcher's own employer lookup
    }
    expect((await su("select count(*)::int n from wrc_licence where agency_name is null"))[0].n).toBe(0);
  });

  it("the lookup reads the WRC list by index: within 20 pages with 5,000 licences", async () => {
    await su("insert into wrc_licence(licence_number, agency_name, trading_name) select 'EA' || (100000 + i), 'Fake Bulk Agency ' || i, 'Fake Bulk Trading ' || i from generate_series(1, 5000) i");
    await su("analyze wrc_licence");
    const client = await db.pool("postgres").connect();
    try {
      const k = "fake bulk trading 4321";
      const costs = await measurePages(client, [{
        text: "select exists (select 1 from wrc_licence w where btrim(regexp_replace(lower(w.agency_name), '[^a-z0-9]+', ' ', 'g')) = $1 or btrim(regexp_replace(lower(w.trading_name), '[^a-z0-9]+', ' ', 'g')) = $1)",
        values: [k],
      }]);
      console.log(`wrc lookup: ${costs[0]!.pages} pages, ${costs[0]!.ms} ms, ${costs[0]!.scans}`);
      expect(costs[0]!.scans).toContain("wrc_licence_trading_norm_idx");
      assertPageBudget("wrc lookup", costs, 20);
    } finally {
      client.release();
    }
  });
});
