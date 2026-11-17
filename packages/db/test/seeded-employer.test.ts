// Integration (D2, #246): a fetched advert under a brand name the company seed loaded attaches to the seeded company, through the fetcher's own
// store (runBoards as app_fetcher), not a second unclaimed company. Real test database, fake names, no network.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { main } from "../src/company-seed-cli";
import { importPermits } from "../src/dete";
import { createTestDb, urlFor, type TestDb } from "./db";
import { runBoards } from "../../fetcher/src";
import { advert, deps, plan, task } from "../../fetcher/test/helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());

it("a fetched job under a seeded brand name lands on the seeded company, which already has its permit history", async () => {
  await importPermits(db.pool("app_admin"), [{ deteName: "Seedfake Ireland Limited", year: 2026, permits: 9, sourceFile: null }]);
  const f = join(mkdtempSync(join(tmpdir(), "seeded-")), "seed.tsv");
  writeFileSync(f, "display_name\tkind\tbrand_names\tdete_names\nSeedfake\temployer\tSeedfake ;; Seedfake Careers\tSeedfake Ireland Limited\n");
  expect(await main([f], { DETE_ADMIN_DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" }, () => {})).toBe(0);
  const org = (await db.query("postgres", "select id, permit_history from organisation where display_name = 'Seedfake'")).rows[0];
  expect(org.permit_history).toBe("has_history");

  const a = advert("s1", { employer: "SEEDFAKE careers." }); // another case and a full stop: the same normalised form
  const [r] = await runBoards(deps(db.pool("app_fetcher"), [task("fake", "seeded", [a])]), (x) => plan(x, "passed"));
  expect(r).toMatchObject({ ok: true, passed: 1 });
  const job = (await db.query("postgres", "select organisation_id, permit_history from job where employer_name = 'SEEDFAKE careers.'")).rows[0];
  expect(job).toEqual({ organisation_id: org.id, permit_history: "has_history" });
  expect(Number((await db.query("postgres", "select count(*) from organisation")).rows[0].count)).toBe(1);
});
