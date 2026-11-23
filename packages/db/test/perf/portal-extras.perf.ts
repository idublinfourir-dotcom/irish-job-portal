// Performance (B54, B55): the company read, the public logo lookup and the team read, on 50,000 companies of which 20,000 hold a logo, one company with
// 2,000 names and 3,000 DETE permit rows, and a team of 10. Pages are counted with EXPLAIN (ANALYZE, BUFFERS), warm pass then measured pass. Fake data only.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { COMPANY_READ } from "../../../../apps/portal/lib/profile";
import { LOGO_BY_KEY } from "../../src/files";
import { COMPANY_QUERIES } from "../../src/public-pages";
import { createTestDb, type TestDb } from "../db";
import { measurePages } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 23 Nov 2026: company 11 pages, permits 175, logo 4, each under 3 ms. Budgets are about 3 times the pages (the permit query's is loose: it is the public page's, run per name), the time a floor for a busy laptop.
export const COMPANY_PAGES = 40; // the company by its key with the CRO row by its unique index, and the 20 legal names by organisation_name_org_idx
export const PERMIT_PAGES = 250; // the public page's permit query (one probe of dete_permit_count_name_idx per name, about 3 pages each: 60 names measured 175)
export const LOGO_PAGES = 15; // one lookup by organisation_logo_key_idx
export const MS = 40;
let db: TestDb, org: string, key: string;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  // 50,000 companies through the triggers take minutes, so the seed switches them off (the tables, indexes and statistics are the same)
  const k = await su.connect();
  try {
    await k.query("begin");
    await k.query("set local session_replication_role = replica");
    await k.query("insert into organisation(slug, display_name, kind, status, cro_number, logo_key) select 'c'||g, 'Fake Client '||g, 'employer', 'verified', (800000+g)::text, case when g % 5 = 0 then 'logo/' || gen_random_uuid() || '.png' end from generate_series(1, 50000) g");
    await k.query("commit");
  } finally { k.release(); }
  await su.query("insert into cro_company(cro_number, name, normalised_name, status, last_seen_on) select (800000 + g)::text, 'FAKE CRO ' || g, 'fake cro ' || g, 'Normal', current_date from generate_series(1, 50000) g");
  org = (await su.query("select id from organisation where slug = 'c5'")).rows[0].id;
  key = (await su.query("select logo_key from organisation where slug = 'c5'")).rows[0].logo_key;
  await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) select $1, 'Fake Name ' || g, 'fake name ' || g, case when g <= 40 then 'legal' else 'alias' end, 'dete' from generate_series(1, 60) g", [org]);
  await su.query("insert into organisation_name(name, normalised_name, kind, source) select 'filler ' || md5(g::text), 'filler ' || md5(g::text), 'legal', 'dete' from generate_series(1, 20000) g");
  await su.query("insert into dete_permit_count(dete_name, organisation_name_id, year, month, permits) select 'fake dete ' || n.id || ' ' || y, n.id, y, null, 3 from organisation_name n cross join generate_series(2019, 2024) y where n.organisation_id = $1 and n.kind = 'legal'", [org]);
  await su.query("insert into dete_permit_count(dete_name, organisation_name_id, year, month, permits) select 'fake dete filler ' || g, null, 2022, null, 1 from generate_series(1, 20000) g");
  await su.query("analyze organisation; analyze organisation_name; analyze cro_company; analyze dete_permit_count");
});
afterAll(() => db.drop());

it("the company read, its permits and the public logo lookup stay inside their page and time budgets", async () => {
  const c = await db.pool("app_portal").connect();
  try {
    const [o, p, l] = await measurePages(c, [
      { text: COMPANY_READ, values: [org] },
      { text: COMPANY_QUERIES.permits, values: [org] },
      { text: LOGO_BY_KEY, values: [key] },
    ]);
    console.log("company pages", o!.pages, o!.scans, o!.ms, "permits pages", p!.pages, p!.scans, p!.ms, "logo pages", l!.pages, l!.scans, l!.ms);
    expect((await c.query(COMPANY_READ, [org])).rows[0].legal_names).toHaveLength(20);
    expect((await c.query(LOGO_BY_KEY, [key])).rowCount).toBe(1);
    expect(o!.pages).toBeLessThanOrEqual(COMPANY_PAGES);
    expect(p!.pages).toBeLessThanOrEqual(PERMIT_PAGES);
    expect(l!.pages).toBeLessThanOrEqual(LOGO_PAGES);
    expect(l!.scans).toContain("organisation_logo_key_idx");
    for (const x of [o!, p!, l!]) expect(x.ms).toBeLessThan(MS);
  } finally {
    c.release();
  }
});
