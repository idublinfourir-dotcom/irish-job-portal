// Audit of 27 Nov 2026, SEC-1 (migration 0078): the four public-facing owner actions (profile edit, logo, close, "I don't recognise this")
// only once staff have verified the company, and a rejected claim clears website, text and logo. End to end on the test database: claims
// through the real claim route, staff decisions through src/account-review.ts as app_admin, the owner actions through the real portal route
// handlers (app_portal) and straight through the database functions for the full status and role matrix. memoryStore() is the file store.
// Fake people and companies only; no network.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { approveAccount, askForMoreInfo, claimReview, rejectAccount } from "../src/account-review";
import { memoryStore, setFileStore, type MemoryStore } from "../src/file-store";
import { PNG } from "../src/file-fixture";
import { getCompanyPage } from "../src/public-pages";
import { seedStaff } from "../src/staff-seed-cli";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool, portal: pg.Pool, admin: pg.Pool;
let AUTH: Handler, CLAIM: Handler, PROFILE: Handler, LOGO: Handler, CLOSE: Handler, PRESS: Handler;
let logoView: (r: Request, c: { params: Promise<{ file: string }> }) => Promise<Response>;
let F: { org(o?: object): Promise<string>; member(org: string, user: string | null, o?: object): Promise<string> };
let store: MemoryStore, reviewer: string, src: string;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  portal = db.pool("app_portal");
  admin = db.pool("app_admin");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ POST: CLAIM } = await import("../../../apps/portal/app/api/portal/claim/route"));
  ({ POST: PROFILE } = await import("../../../apps/portal/app/api/portal/company/route"));
  ({ PUT: LOGO } = await import("../../../apps/portal/app/api/portal/company/logo/route"));
  ({ POST: CLOSE } = await import("../../../apps/portal/app/api/portal/company/close/route"));
  ({ POST: PRESS } = await import("../../../apps/portal/app/api/portal/agency-jobs/not-recognised/route"));
  ({ GET: logoView } = await import("../../../apps/portal/app/api/portal/company/logo/[file]/route"));
  store = memoryStore();
  setFileStore(store);
  const k = await su.connect();
  try { reviewer = await seedStaff(k, { email: "fake.reviewer.sec1@example.test", name: "Fake Reviewer", roles: ["account_reviewer"] }, "Fake-reviewer-password-1"); } finally { k.release(); }
  src = (await su.query("select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
});
afterAll(async () => {
  setFileStore(undefined);
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
beforeEach(async () => { await su.query("delete from portal_rate_limit"); });

let n = 0;
const uid = (p: string) => `${p}${++n}${Date.now().toString(36)}`;
type Login = { cookie: string; id: string };
async function login(): Promise<Login> {
  const email = `${uid("fake.")}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/portal/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...portalAnswers }) }))).status).toBe(200);
  await su.query("update portal_user set email_verified = true where email = $1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/portal/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), id: (await su.query("select id from portal_user where email = $1", [email])).rows[0].id };
}
async function send(route: Handler, method: string, who: Login, body: BodyInit, json = true) {
  const headers: Record<string, string> = { cookie: who.cookie, origin: BASE };
  if (json) headers["content-type"] = "application/json";
  const res = await route(new Request(`${BASE}/api/portal/x`, { method, headers, body }));
  const text = await res.text();
  return { status: res.status, code: (text ? JSON.parse(text) : {}).code as string | undefined };
}
const logoFile = () => { const f = new FormData(); f.append("file", new Blob([PNG as Uint8Array<ArrayBuffer>]), "logo.png"); return f; };
const profile = { description: "We make fake widgets in Cork.", website: "https://fake-widgets.example.test", county: "Cork" };
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
const named = (org: string, name: string) =>
  su.query("insert into organisation_name(organisation_id,name,normalised_name,kind,source) values ($1,$2,btrim(regexp_replace(lower($2),'[^a-z0-9]+',' ','g')),'legal','admin')", [org, name]);
/** A live agency job of a separate agency that names `client` as its client (job_defaults links the name to the company). */
async function agencyJobFor(clientName: string): Promise<string> {
  const agency = await F.org({ name: `Fake Recruit ${uid("")} Ltd`, kind: "agency" });
  return (await one(`insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,search_vector,salary_low,
       permit_employer_kind,permit_employer_name) values ($1,'agency',$2,'Fake role','Fake Recruit','it','critical_skills','live',now()+interval '20 days','https://example.test/a',
       to_tsvector('english','x'),40000,'client',$3) returning id`, [agency, src, clientName])).id as string;
}
/** A real sponsor (unclaimed), claimed through the real claim route by a new login: the company waits in pending_review with the claimant as owner. */
async function claimed() {
  const name = `Fake Sponsor ${uid("")} Limited`;
  const org = await F.org({ name, status: "unclaimed" });
  await named(org, name);
  const owner = await login();
  const r = await send(CLAIM, "POST", owner, JSON.stringify({ organisationId: org }));
  expect(r.status).toBe(200);
  const item = (await one("select id::text from review_item where queue = 'account_review' and organisation_id = $1 and status in ('open','claimed')", [org])).id as string;
  await claimReview(admin, reviewer, item);
  return { org, name, owner, item, job: await agencyJobFor(name) };
}
const snapshot = async (org: string, job: string) => ({
  org: await one("select status, website, short_description, county, logo_key, logo_url from organisation where id = $1", [org]),
  audit: (await one("select count(*)::int n from audit_event where object_type = 'organisation' and object_id = $1 and action like 'organisation.%'", [org])).n,
  job: (await one("select status from job where id = $1", [job])).status,
  reports: (await one("select count(*)::int n from report where target_job_id = $1", [job])).n,
  members: (await one("select count(*)::int n from membership where organisation_id = $1 and status = 'active'", [org])).n,
  files: store.objects.size,
});
/** The four actions through the real routes, as `who`. */
async function four(c: { owner: Login; name: string; job: string }) {
  return {
    edit: await send(PROFILE, "POST", c.owner, JSON.stringify(profile)),
    logo: await send(LOGO, "PUT", c.owner, logoFile(), false),
    press: await send(PRESS, "POST", c.owner, JSON.stringify({ jobId: c.job })),
    close: await send(CLOSE, "POST", c.owner, JSON.stringify({ confirmName: c.name })),
  };
}
const REFUSED = { status: 409, code: "ORGANISATION_NOT_AVAILABLE" };

describe("SEC-1: migration 0078 is in the schema", () => {
  it("private.company_live is true only for verified and verified_restricted", async () => {
    const r = (await su.query("select s, private.company_live(s) live from unnest(array['unclaimed','pending_review','needs_info','verified','verified_restricted','suspended','rejected','banned','closed']) s")).rows;
    expect(r.filter((x) => x.live).map((x) => x.s)).toEqual(["verified", "verified_restricted"]);
  });
});

describe("SEC-1: an unverified claimant cannot touch the public page", () => {
  it("pending_review (a claim by the real route): all four actions answer 409 and change nothing; after staff approve, all four pass", async () => {
    const c = await claimed();
    expect((await one("select status from organisation where id = $1", [c.org])).status).toBe("pending_review");
    const before = await snapshot(c.org, c.job);
    expect(await four(c)).toEqual({ edit: REFUSED, logo: REFUSED, press: REFUSED, close: REFUSED });
    expect(await snapshot(c.org, c.job)).toEqual(before); // no profile, no logo row or file, no report, the job still live, the company still open
    expect(before).toMatchObject({ org: { website: null, short_description: null, logo_key: null }, job: "live", reports: 0, members: 1, files: 0 });

    await approveAccount(admin, reviewer, c.item);
    const ok = await four(c);
    expect([ok.edit.status, ok.logo.status, ok.press.status, ok.close.status]).toEqual([200, 200, 200, 200]);
    expect(await snapshot(c.org, c.job)).toMatchObject({ org: { status: "closed", website: profile.website }, job: "hidden", reports: 1, members: 0, files: 1 });
  });
  it("needs_info (staff asked a question): the same four refusals, nothing changes", async () => {
    const c = await claimed();
    await askForMoreInfo(admin, reviewer, c.item, "needs_info", "Please send a letter on company paper.");
    expect((await one("select status from organisation where id = $1", [c.org])).status).toBe("needs_info");
    const before = await snapshot(c.org, c.job);
    expect(await four(c)).toEqual({ edit: REFUSED, logo: REFUSED, press: REFUSED, close: REFUSED });
    expect(await snapshot(c.org, c.job)).toEqual(before);
  });
  it("an unverified owner cannot probe job ids: a real job of theirs, another's job and a made-up id all give the same 409", async () => {
    const c = await claimed();
    const other = await agencyJobFor(`Someone Else ${uid("")} Ltd`);
    for (const jobId of [c.job, other, "999999999"]) expect(await send(PRESS, "POST", c.owner, JSON.stringify({ jobId })), jobId).toEqual(REFUSED);
  });
  it("the refused calls cost no extra statement: the edit refusal is the same 5 round trips as an edit (requirePortal 3, the rate count, the function)", async () => {
    const c = await claimed();
    const q = pg.Client.prototype.query;
    let count = 0;
    pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { count++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
    try { expect(await send(PROFILE, "POST", c.owner, JSON.stringify(profile))).toEqual(REFUSED); } finally { pg.Client.prototype.query = q; }
    expect(count).toBe(5);
  });
});

// ===== the full matrix, straight through the database functions as app_portal, each call rolled back =====
const STATUSES = ["pending_review", "needs_info", "verified", "verified_restricted", "suspended", "banned", "closed", "rejected", "unclaimed"] as const;
const ROLES = ["account_owner", "recruiter", "poster", "viewer"] as const;
/** Puts a company in a status with its guard triggers off (banned needs a ban row, restricted a strike: their own rules are tested elsewhere). */
async function setStatus(org: string, status: string) {
  const k = await su.connect();
  try {
    await k.query("begin"); await k.query("set local session_replication_role = replica");
    await k.query("update organisation set status = $2, restricted_until = case when $2 = 'verified_restricted' then now() + interval '30 days' end where id = $1", [org, status]);
    await k.query("commit");
  } finally { k.release(); }
}
async function attempt(sql: string, args: unknown[], pool = portal): Promise<string> {
  const k = await pool.connect();
  try {
    await k.query("begin");
    await k.query(sql, args);
    return "ok";
  } catch (e) {
    const { code, message = "" } = e as { code?: string; message?: string };
    return code === "P0001" ? (/refused: ([A-Z_]+)/.exec(message)?.[1] ?? message) : `${code}`;
  } finally { await k.query("rollback").catch(() => {}); k.release(); }
}
type Action = (u: string, c: { name: string; job: string }) => [string, unknown[]];
const ACTIONS: Record<"edit" | "logo" | "close" | "press", Action> = {
  edit: (u) => ["select private.company_edit($1, $2, $3, $4)", [u, profile.description, profile.website, profile.county]],
  logo: (u) => { const f = `${crypto.randomUUID()}.png`; return ["select private.company_logo($1, $2, $3)", [u, `logo/${f}`, `${BASE}/api/portal/company/logo/${f}`]]; },
  close: (u, c) => ["select private.company_close($1, $2)", [u, c.name]],
  press: (u, c) => ["select private.client_not_recognised($1, $2)", [u, c.job]],
};

describe("SEC-1: status times role, for the four actions", () => {
  it("only the account owner of a verified or verified_restricted company passes; every other owner gets ORGANISATION_NOT_AVAILABLE, every other role NOT_OWNER", async () => {
    const got: Record<string, string> = {}, want: Record<string, string> = {};
    for (const status of STATUSES) {
      const name = `Fake Matrix ${uid("")} Limited`;
      const org = await F.org({ name, status: "verified" });
      await named(org, name);
      const c = { name, job: await agencyJobFor(name) };
      const users: Record<string, string> = {};
      for (const role of ROLES) { users[role] = (await login()).id; await F.member(org, users[role]!, { role, signer: role === "account_owner" }); }
      await setStatus(org, status);
      for (const role of ROLES) for (const [a, fn] of Object.entries(ACTIONS)) {
        const [sql, args] = fn(users[role]!, c);
        got[`${status} ${role} ${a}`] = await attempt(sql, args);
        want[`${status} ${role} ${a}`] = role !== "account_owner" ? "NOT_OWNER" : status === "verified" || status === "verified_restricted" ? "ok" : "ORGANISATION_NOT_AVAILABLE";
      }
    }
    expect(got).toEqual(want);
  });
  it("another company's owner changes only their own company, and cannot press on a job that names a company they are not in", async () => {
    const a = await claimed(), b = await claimed();
    await approveAccount(admin, reviewer, a.item);
    await approveAccount(admin, reviewer, b.item);
    expect(await send(PRESS, "POST", a.owner, JSON.stringify({ jobId: b.job }))).toEqual({ status: 404, code: "JOB_NOT_FOUND" });
    expect((await send(PROFILE, "POST", a.owner, JSON.stringify(profile))).status).toBe(200);
    expect(await one("select website from organisation where id = $1", [b.org])).toEqual({ website: null });
    expect(await one("select status from job where id = $1", [b.job])).toEqual({ status: "live" });
  });
  it("staff: app_admin cannot run the four functions at all, and a staff id given as the login is refused", async () => {
    const c = { name: "x", job: await agencyJobFor("Nobody Ltd") };
    for (const [a, fn] of Object.entries(ACTIONS)) {
      const [sql, args] = fn(reviewer, c);
      expect(await attempt(sql, args, admin), `admin ${a}`).toBe("42501");
      expect(await attempt(sql, args), `staff id ${a}`).toBe("REFUSED");
    }
  });
  it("hostile input from a verified owner: javascript:, userinfo and plain http websites are refused by the database itself", async () => {
    const c = await claimed();
    await approveAccount(admin, reviewer, c.item);
    for (const w of ["javascript:alert(1)", "https://user@evil.example.test", "https://fake.example.test@evil.example.test", "http://fake.example.test", "https://"])
      expect(await attempt("select private.company_edit($1, 'x', $2, null)", [c.owner.id, w]), w).toBe("BAD_REQUEST");
    for (const w of ["https://fake.example.test/a@b", "https://fake.example.test?x=@y", "https://fake.example.test#@z", "https://www.fake.example.test"])
      expect(await attempt("select private.company_edit($1, 'x', $2, null)", [c.owner.id, w]), w).toBe("ok"); // an @ after the host is a path, not a login
    for (const w of ["javascript:alert(1)", "https://user@evil.example.test", "https://fake.example.test@evil.example.test"])
      expect(await send(PROFILE, "POST", c.owner, JSON.stringify({ ...profile, website: w })), w).toEqual({ status: 400, code: "BAD_REQUEST" });
    expect(await one("select website from organisation where id = $1", [c.org])).toEqual({ website: null });
  });
});

describe("SEC-1: a rejected claim clears website, text and logo", () => {
  const fill = (org: string) => {
    const f = `${crypto.randomUUID()}.png`;
    return su.query("update organisation set website = 'https://claimant.example.test', short_description = 'Claimant text', logo_key = $2, logo_url = $3 where id = $1",
      [org, `logo/${f}`, `${BASE}/api/portal/company/logo/${f}`]).then(() => f);
  };
  const fields = (org: string) => one("select status, website, short_description, logo_key, logo_url, county from organisation where id = $1", [org]);
  it("staff reject a claim (back to unclaimed): the four fields are null, the public page shows none of them and the logo address is 404", async () => {
    const c = await claimed();
    const file = await fill(c.org); // what a claimant could write before 0078 (or an approved owner before a later rejection)
    store.objects.set(`logo/${file}`, { bytes: PNG, contentType: "image/png" });
    expect((await logoView(new Request(`${BASE}/x`), { params: Promise.resolve({ file }) })).status).toBe(200);
    await rejectAccount(admin, reviewer, c.item, "not_verified");
    expect(await fields(c.org)).toEqual({ status: "unclaimed", website: null, short_description: null, logo_key: null, logo_url: null, county: null });
    const page = await getCompanyPage(db.pool("app_candidate"), (await one("select slug from organisation where id = $1", [c.org])).slug);
    expect(page).toMatchObject({ website: null, shortDescription: null, logoUrl: null });
    expect((await logoView(new Request(`${BASE}/x`), { params: Promise.resolve({ file }) })).status).toBe(404);
    expect(await one("select status from job where id = $1", [c.job])).toEqual({ status: "live" }); // the sponsor's other jobs stay listed
  });
  it("0078's one-off update (run from the migration's own text, as portal_owner) clears unclaimed and rejected rows only", async () => {
    const sql = /^update organisation set website = null[\s\S]*?;$/m.exec(readFileSync(new URL("../migrations/0078_verified_company_gate.sql", import.meta.url), "utf8"))![0];
    const rows: Record<string, string> = {};
    for (const status of ["unclaimed", "rejected", "pending_review", "verified"]) { rows[status] = await F.org({ name: `Fake Old ${status} Ltd`, status: "verified" }); await fill(rows[status]!); await setStatus(rows[status]!, status); }
    const k = await su.connect();
    try { await k.query("begin"); await k.query("set local role portal_owner"); await k.query(sql); await k.query("commit"); } finally { k.release(); }
    for (const status of ["unclaimed", "rejected"]) expect(await fields(rows[status]!), status).toMatchObject({ website: null, short_description: null, logo_key: null, logo_url: null });
    for (const status of ["pending_review", "verified"]) expect(await fields(rows[status]!), status).toMatchObject({ website: "https://claimant.example.test", short_description: "Claimant text" });
  });
  it("a first-time registration rejected (to rejected), and any move to unclaimed, clear them too; other moves keep them", async () => {
    const reg = await login();
    const regOrg = String((await portal.query("select private.register_organisation($1, 'employer', 'Fake Fresh Start Ltd', $2, null) r", [reg.id, uid("cro")])).rows[0].r.organisation_id);
    const item = (await one("select id::text from review_item where queue = 'account_review' and organisation_id = $1", [regOrg])).id;
    await fill(regOrg);
    await claimReview(admin, reviewer, item);
    await rejectAccount(admin, reviewer, item, "not_verified");
    expect(await fields(regOrg)).toMatchObject({ status: "rejected", website: null, short_description: null, logo_key: null, logo_url: null });

    const plain = await F.org({ name: "Fake Plain Ltd", status: "verified" });
    await fill(plain);
    await su.query("update organisation set status = 'suspended' where id = $1", [plain]);
    expect(await fields(plain)).toMatchObject({ status: "suspended", website: "https://claimant.example.test", short_description: "Claimant text" });
    await su.query("update organisation set status = 'unclaimed' where id = $1", [plain]);
    expect(await fields(plain)).toMatchObject({ status: "unclaimed", website: null, short_description: null, logo_key: null, logo_url: null });
  });
});
