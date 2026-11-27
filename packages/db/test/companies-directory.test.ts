// B25 (C13): GET /api/companies end to end on the test database as app_candidate, through the real route handler. Every shown company once over
// all pages, never a rejected, closed or merged one, the permits since 2019 as the company page counts them, search by legal or alias name, hostile
// search and cursor input, the reply's exact keys (no private column), the OpenAPI shape and the visitor rate limit. Fake data only; no network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool, GET: Handler;
const SHOWN = 45; // over two pages of 20

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ GET } = await import("../../../apps/candidate/app/api/companies/route"));
  await su.query("insert into organisation(slug, display_name, kind, status, county) select 'fake-'||g, 'Fake Co '||lpad(g::text, 3, '0'), 'employer', 'unclaimed', 'Cork' from generate_series(1, $1) g", [SHOWN]);
  await su.query(`insert into organisation(slug, display_name, kind, status, cro_number, website) values
    ('hidden-rejected', 'Fake Co Rejected', 'employer', 'rejected', '1', null), ('hidden-closed', 'Fake Co Closed', 'employer', 'closed', '2', null)`);
  await su.query("insert into organisation(slug, display_name, kind, status, merged_into_id) select 'hidden-merged', 'Fake Co Merged', 'employer', 'unclaimed', id from organisation where slug = 'fake-1'");
  // fake-2: claimed, a legal name and an alias, DETE rows (2018 not counted; 2024 yearly total wins over its months; 2025 months only), 3 live jobs and 1 closed
  await su.query("update organisation set status = 'verified', claimed_at = now(), permit_history = 'has_history', display_name = 'Fake Co 002' where slug = 'fake-2'");
  const id = (await su.query("select id from organisation where slug = 'fake-2'")).rows[0].id;
  const legal = (await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, 'Quayside 100% O''Brien_Care Limited', 'quayside 100 o brien care', 'legal', 'admin') returning id", [id])).rows[0].id;
  await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, 'Harbour Nursing', 'harbour nursing', 'alias', 'admin')", [id]);
  const hidden = (await su.query("select id from organisation where slug = 'hidden-rejected'")).rows[0].id;
  await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, 'Harbour Rejected Ltd', 'harbour rejected', 'legal', 'admin')", [hidden]);
  await su.query(`insert into dete_permit_count(dete_name, organisation_name_id, year, month, permits) values
    ('FAKE Q', $1, 2018, null, 50), ('FAKE Q', $1, 2024, null, 10), ('FAKE Q', $1, 2024, 3, 4), ('FAKE Q', $1, 2025, 1, 2), ('FAKE Q', $1, 2025, 2, 3)`, [legal]);
  const src = (await su.query("insert into job_source(kind, board) values ('portal', 'fake-board') returning id")).rows[0].id;
  await su.query(`insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, search_vector)
    select $1, 'admin_manual', $2, 'Fake role '||g, 'Fake', 'it', 'critical_skills', case when g = 4 then 'closed' else 'live' end, now() + interval '20 days', 'https://example.test', 'x'
    from generate_series(1, 4) g`, [id, src]);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
async function get(path: string, ip = `203.0.113.${(++n % 240) + 10}`) {
  const res = await GET(new Request(`${BASE}${path}`, { headers: { "x-vercel-forwarded-for": ip } }));
  return { status: res.status, body: (await res.json()) as { companies: Record<string, unknown>[]; next: string | null; code?: string } };
}
const KEYS = ["county", "initials", "labels", "liveJobs", "name", "permitsSince2019", "slug"];

describe("GET /api/companies", () => {
  it("pages every shown company exactly once by name, never a rejected, closed or merged one, with only the public keys", async () => {
    const slugs: string[] = [];
    let path = "/api/companies", pages = 0;
    for (;;) {
      const g = await get(path);
      expect(g.status).toBe(200);
      expect(g.body.companies.length).toBeLessThanOrEqual(20);
      for (const c of g.body.companies) expect(Object.keys(c).sort()).toEqual(KEYS);
      slugs.push(...g.body.companies.map((c) => c.slug as string));
      pages++;
      if (!g.body.next) break;
      path = `/api/companies?after=${g.body.next}`;
    }
    expect(pages).toBe(3);
    expect(slugs.length).toBe(SHOWN); // hidden-merged (into fake-1), rejected and closed left out
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.some((s) => s.startsWith("hidden"))).toBe(false);
    expect(slugs.slice(0, 2)).toEqual(["fake-1", "fake-2"]);
  });

  it("gives the company page's figures: permits since 2019, live jobs only, labels and initials", async () => {
    const c = (await get("/api/companies?q=harbour")).body.companies;
    expect(c).toEqual([{ slug: "fake-2", name: "Fake Co 002", initials: "FC", county: "Cork", labels: ["Claimed"], permitsSince2019: 15, liveJobs: 3 }]);
    const other = (await get("/api/companies")).body.companies[0]!;
    expect([other.permitsSince2019, other.liveJobs, other.labels]).toEqual([null, 0, ["Permit history not linked yet"]]);
  });

  it("searches legal and alias names; hostile input is plain text or a 400, never an error or a hidden company", async () => {
    expect((await get("/api/companies?q=O'BRIEN_care")).body.companies.map((c) => c.slug)).toEqual(["fake-2"]);
    expect((await get(`/api/companies?q=${encodeURIComponent("100%")}`)).body.companies.map((c) => c.slug)).toEqual(["fake-2"]);
    expect((await get("/api/companies?q=rejected")).body.companies).toEqual([]);
    for (const q of ["%", "_", "%%%", "'", "\"", "日本", "\u0000", "' or 1=1 --", "\\"]) {
      const g = await get(`/api/companies?q=${encodeURIComponent(q)}`);
      expect([g.status, g.body], q).toEqual([200, { companies: [], next: null }]);
    }
    expect((await get(`/api/companies?q=${"a".repeat(101)}`)).status).toBe(400);
    for (const after of ["x", "W10", Buffer.from(JSON.stringify(["a", "1 or 1=1"])).toString("base64url"), "a".repeat(2000)])
      expect((await get(`/api/companies?after=${after}`)).body, after).toEqual({ code: "BAD_REQUEST" });
  });

  it("matches docs/openapi/candidate.yaml (decision #248)", async () => {
    const spec = loadSpec("candidate");
    for (const path of ["/api/companies", "/api/companies?q=harbour", `/api/companies?q=${"a".repeat(101)}`]) {
      const g = await get(path);
      expect(replyProblems(spec, "GET", "/api/companies", g.status, g.body), path).toEqual([]);
    }
  });

  it("answers 429 after 60 reads a minute from one address", async () => {
    const ip = "192.0.2.77";
    for (let i = 0; i < 60; i++) expect((await get("/api/companies?q=harbour", ip)).status).toBe(200);
    expect(await get("/api/companies", ip)).toEqual({ status: 429, body: { code: "TOO_MANY_REQUESTS" } });
  });
});
