// #257 (P6): the care and hospitality sectors end to end on the test database. The candidate job list (GET /api/jobs) and the alert route
// (POST /api/candidate/alerts) through their real handlers, the alert run sending a care job, and the one-off backfill
// (src/sector-backfill-cli.ts): dry run, apply, a second run that moves nothing, the CLI's refusals and the roles that may not run it.
// Fake people and jobs only; no network (vitest.setup.ts refuses it).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { queueAlerts } from "../src/alerts-run-cli";
import { APPLY, backfillSectors, main, PARAMS } from "../src/sector-backfill-cli";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let AUTH: Handler, JOBS: Handler, ALERTS: Handler;
let org: string, pharma: string, src: string;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ GET: JOBS } = await import("../../../apps/candidate/app/api/jobs/route"));
  ({ POST: ALERTS } = await import("../../../apps/candidate/app/api/candidate/alerts/route"));
  org = (await su.query("insert into organisation(slug, display_name, kind, status) values ('fake-care-org', 'Fake Care Ltd', 'employer', 'verified') returning id::text")).rows[0].id;
  pharma = (await su.query("insert into organisation(slug, display_name, kind, status) values ('fake-pharma-org', 'Pfizer Fake', 'employer', 'verified') returning id::text")).rows[0].id;
  src = (await su.query("insert into job_source(kind, board) values ('portal', 'fake-board') returning id::text")).rows[0].id;
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

async function job(sector: string, occ: string | null, o: { status?: string; org?: string; county?: string } = {}) {
  const status = o.status ?? "live";
  return (await su.query(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, badge, status, closes_at, own_page_url, search_vector${status === "closed" ? ", close_reason" : ""})
     values ($1, 'admin_manual', $2, 'Fake job', 'Fake Care Ltd', $3, $4, $5, 'critical_skills', 'critical_skills_eligible', $6, now() + interval '20 days', 'https://example.test/a', to_tsvector('english', 'fake')${status === "closed" ? ", 'closed'" : ""})
     returning id::text`,
    [o.org ?? org, src, o.county ?? "Dublin", sector, occ, status])).rows[0].id as string;
}
const sectorOf = async (id: string) => (await su.query("select sector from job where id = $1", [id])).rows[0].sector as string;

let n = 0;
async function login() {
  const email = `fake.sector${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), id: (await su.query("select id from candidate_user where email=$1", [email])).rows[0].id as string };
}
const list = async (q: string) => {
  const res = await JOBS(new Request(`${BASE}/api/jobs${q}`, { headers: { "x-vercel-forwarded-for": `203.0.113.${(++n % 240) + 10}` } }));
  return { status: res.status, ids: res.status === 200 ? ((await res.json()) as { jobs: { id: string }[] }).jobs.map((j) => j.id).sort() : [] };
};
const alert = async (cookie: string, body: object) =>
  (await ALERTS(new Request(`${BASE}/api/candidate/alerts`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify(body) }))).status;

describe("the new sectors in search and alerts (real routes)", () => {
  it("GET /api/jobs filters by care and by hospitality; a wrong spelling is 400", async () => {
    const care = await job("care", "6145"), hosp = await job("hospitality", "5434", { county: "Cork" }), other = await job("other", "3542");
    expect(await list("?sector=care")).toEqual({ status: 200, ids: [care] });
    expect(await list("?sector=hospitality")).toEqual({ status: 200, ids: [hosp] });
    expect(await list("?sector=hospitality&county=Dublin")).toEqual({ status: 200, ids: [] });
    expect((await list("?sector=other")).ids).toContain(other);
    for (const bad of ["Care", "care%20", "HOSPITALITY", "care,hospitality", "c".repeat(300), "care%00"]) expect((await list(`?sector=${bad}`)).status, bad).toBe(400);
    await su.query("update job set status = 'closed', close_reason = 'closed' where id = any($1::bigint[])", [[care, hosp, other]]);
  });

  it("POST /api/candidate/alerts takes care and hospitality, refuses near misses and a visitor; the alert run sends the care job", async () => {
    const p = await login();
    expect(await alert(p.cookie, { sector: "care", frequency: "daily" })).toBe(200);
    expect(await alert(p.cookie, { sector: "hospitality", frequency: "daily" })).toBe(200);
    for (const bad of ["Care", " care", "hospitality ", "carer", 6145]) expect(await alert(p.cookie, { sector: bad, frequency: "daily" }), String(bad)).toBe(400);
    expect(await alert("", { sector: "care", frequency: "daily" })).toBe(401);
    const care = await job("care", "6146");
    await job("health", "2231");
    await su.query("update alert set created_at = now() - interval '30 days' where candidate_user_id = $1", [p.id]);
    await queueAlerts(db.pool("app_admin"));
    const sent = (await su.query("select params from email_outbox where candidate_user_id = $1", [p.id])).rows[0].params.alerts as { job_ids: number[] }[];
    expect(sent.map((a) => a.job_ids.map(String))).toEqual([[care]]); // the care alert only; hospitality has no job
    await su.query("update job set status = 'closed', close_reason = 'closed' where status = 'live'");
  });
});

describe("the backfill (src/sector-backfill-cli.ts)", () => {
  it("dry run counts and writes nothing; apply moves only 'other' jobs of the new codes, every status; a second run moves nothing", async () => {
    const want = {
      care: [await job("other", "6145"), await job("other", "1242", { status: "closed" }), await job("other", "6147", { status: "draft" })],
      hospitality: [await job("other", "5434"), await job("other", "9274", { status: "closed" })],
    };
    const keep = {
      [await job("pharma and science", "6145", { org: pharma })]: "pharma and science", // the pharma employer rule won
      [await job("other", "6141")]: "other",
      [await job("other", null)]: "other",
      [await job("health", "2231")]: "health",
      [await job("IT", "2136")]: "IT",
    };
    const admin = db.pool("app_admin");
    expect(await backfillSectors(admin, { apply: false })).toEqual({ care: 3, hospitality: 2 });
    for (const id of [...want.care, ...want.hospitality]) expect(await sectorOf(id)).toBe("other");
    expect(await backfillSectors(admin, { apply: true })).toEqual({ care: 3, hospitality: 2 });
    for (const [s, ids] of Object.entries(want)) for (const id of ids) expect(await sectorOf(id), id).toBe(s);
    for (const [id, s] of Object.entries(keep)) expect(await sectorOf(id), id).toBe(s);
    expect(await backfillSectors(admin, { apply: false })).toEqual({ care: 0, hospitality: 0 });
    expect(await backfillSectors(admin, { apply: true })).toEqual({ care: 0, hospitality: 0 });
  });

  it("the CLI: dry run by default, --apply writes, bad arguments and a missing login are refused", async () => {
    const id = await job("other", "9273");
    const lines: string[] = [];
    const env = { SECTOR_ADMIN_DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" };
    expect(await main([], env, (l) => lines.push(l))).toBe(0);
    expect(await sectorOf(id)).toBe("other");
    expect(await main(["--apply"], env, (l) => lines.push(l))).toBe(0);
    expect(await sectorOf(id)).toBe("hospitality");
    expect(lines).toEqual(["dry run, nothing written: 0 jobs would move to care, 1 to hospitality (add --apply to write)", "0 jobs moved to care, 1 to hospitality"]);
    expect(await main(["--apply", "x"], env, () => {})).toBe(2);
    expect(await main(["--aply"], env, () => {})).toBe(2);
    expect(await main([], { DATABASE_SSL: "disable" }, () => {})).toBe(2);
    const refused: string[] = [];
    expect(await main(["--apply"], { SECTOR_ADMIN_DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable" }, (l) => refused.push(l))).toBe(1);
    expect(refused[0]).toMatch(/^refused: permission denied/);
  });

  it("the other app logins cannot run it", async () => {
    const id = await job("other", "6145");
    for (const role of ["app_candidate", "anon", "authenticated", "app_backup"] as const) await expect(db.query(role, APPLY, PARAMS), role).rejects.toThrow(/permission denied/);
    // the fetcher may write only fetched jobs (job_guard); the portal only its own company's jobs. Neither moves this admin job.
    await expect(db.query("app_fetcher", APPLY, PARAMS)).rejects.toThrow(/job guard|permission denied/);
    await db.query("app_portal", APPLY, PARAMS).catch(() => {});
    expect(await sectorOf(id)).toBe("other");
  });
});
