// Small wave 2, agent A: a real portal session and a real staff session on the candidate site's public reads (GET /api/updates, /api/checker,
// /api/jobs) are visitors: counted per address, 6 jobs, no cursor. The three login pools are separate (#97). All three real auth routes run as the
// database owner here (the only way one process can hold the three logins, as contact-cross-login.test.ts); the grants are in dal-reads.test.ts.
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { seedStaff } from "../src/staff-seed-cli";
import { answers, portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const CAND = "http://localhost:3000", PORT = "http://localhost:3001", STAFF = "http://localhost:3002";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let candAuth: Handler, portAuth: Handler, staffAuth: Handler, UPDATES: Handler, CHECKER: Handler, JOBS: Handler;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, {
    DATABASE_URL: urlFor(db.name), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: CAND, CANDIDATE_AUTH_SECRET: secret, PORTAL_AUTH_URL: PORT, PORTAL_AUTH_SECRET: secret,
    STAFF_AUTH_URL: STAFF, STAFF_AUTH_SECRET: secret,
  });
  ({ POST: candAuth } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ POST: portAuth } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ POST: staffAuth } = await import("../../../apps/admin/app/api/auth/staff/[...all]/route"));
  ({ GET: UPDATES } = await import("../../../apps/candidate/app/api/updates/route"));
  ({ GET: CHECKER } = await import("../../../apps/candidate/app/api/checker/route"));
  ({ GET: JOBS } = await import("../../../apps/candidate/app/api/jobs/route"));
  const org = (await su.query("insert into organisation(slug, display_name, kind, status) values ('fake-x-org', 'Fake', 'employer', 'verified') returning id")).rows[0].id;
  const src = (await su.query("insert into job_source(kind, board) values ('portal', 'fake-x') returning id")).rows[0].id;
  await su.query(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, occupation_code, permit_type, badge, quota_full, status, closes_at, own_page_url, search_vector)
     select $1, 'admin_manual', $2, 'Fake ' || g, 'Fake', 'it', '2136', 'critical_skills', 'critical_skills_eligible', false, 'live', now() + interval '9 days', 'https://example.test/a', to_tsvector('english','x')
     from generate_series(1, 9) g`, [org, src]);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const H = (base: string) => ({ "content-type": "application/json", origin: base, "x-vercel-forwarded-for": "198.51.100.90" });
const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
async function signUpIn(auth: Handler, base: string, pool: "candidate" | "portal", email: string, extra: object) {
  const password = "Fake-password-12345";
  expect((await auth(new Request(`${base}/api/auth/${pool}/sign-up/email`, { method: "POST", headers: H(base), body: JSON.stringify({ email, password, name: "Fake", ...extra }) }))).status).toBe(200);
  await su.query(`update ${pool}_user set email_verified=true where email=$1`, [email]);
  const r = await auth(new Request(`${base}/api/auth/${pool}/sign-in/email`, { method: "POST", headers: H(base), body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return cookieOf(r);
}

it("a portal and a staff session are visitors on the public reads; a candidate session is a candidate", async () => {
  const cand = await signUpIn(candAuth, CAND, "candidate", "x.cand@example.test", answers);
  const portal = await signUpIn(portAuth, PORT, "portal", "x.portal@example.test", portalAnswers);
  const c = await su.connect();
  try { await seedStaff(c, { email: "x.staff@example.test", name: "Fake Staff", roles: ["administrator"] }, "Fake-staff-password-1"); } finally { c.release(); }
  const sr = await staffAuth(new Request(`${STAFF}/api/auth/staff/sign-in/email`, { method: "POST", headers: H(STAFF), body: JSON.stringify({ email: "x.staff@example.test", password: "Fake-staff-password-1" }) }));
  expect(sr.status).toBe(200);
  const staff = cookieOf(sr);

  let n = 0;
  for (const [who, cookie, visitor] of [["portal", portal, true], ["staff", staff, true], ["candidate", cand, false]] as const) {
    const ip = `192.0.2.${100 + ++n}`;
    const get = (route: Handler, path: string, base = CAND) => route(new Request(`${base}${path}`, { headers: { cookie, "x-vercel-forwarded-for": ip } }));
    expect((await get(UPDATES, "/api/updates")).status, who).toBe(200);
    const check = await get(CHECKER, "/api/checker?occupationCode=2136&annualPay=70000&relevantDegree=true");
    expect([check.status, ((await check.json()) as { qualifies: boolean }).qualifies], who).toEqual([200, true]);
    const jobs = (await (await get(JOBS, "/api/jobs")).json()) as { jobs: unknown[]; signInForMore: boolean };
    expect([jobs.jobs.length, jobs.signInForMore], who).toEqual(visitor ? [6, true] : [9, false]);
    const counted = (await su.query("select count(*)::int as n from candidate_rate_limit where key like $1", [`read:ip:${ip}:%`])).rows[0].n;
    expect(counted, who).toBe(visitor ? 2 : 0); // a visitor is counted per address (minute and hour), a candidate per login
  }
});
