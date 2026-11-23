// Step 15 P3 and P12: the company profile, the logo and the owner's close, end to end on the test database through the real auth route and the real
// route handlers of apps/portal (connected as app_portal), with memoryStore() as the file store and the fake email sender. Every role is tried, then
// hostile input. Companies, members and jobs are written as postgres. No network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { answers, makeAuth, portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { memoryStore, setFileStore, type MemoryStore } from "../src/file-store";
import { EXE, JPEG, PDF, PNG, WEBP } from "../src/file-fixture";
import { loadSpec, replyProblems } from "./openapi";

// Statements counted on every pg.Client.query call, measured on 18 November 2026: the edit 5 and the close 5 (requirePortal 3, the rate count, the function),
// the logo 6 (requirePortal 3, the rate count, the owner check, the function). Medians of 9 warm calls: edit 2.1 ms, logo 2.6 ms, close 3.5 ms (a small company;
// the close of 200 jobs and 20 members is in perf/company.perf.ts). Time budgets are about 8 times the measure. Raise these only on purpose.
const BUDGET = { edit: { statements: 5, medianMs: 20 }, logo: { statements: 6, medianMs: 25 }, close: { statements: 5, medianMs: 30 } };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
type Route = Partial<Record<"GET" | "POST" | "PUT", Handler>>;
let db: TestDb, su: pg.Pool;
let AUTH: Handler;
const R = {} as Record<"profile" | "logo" | "close" | "team" | "claim", Route>;
let F: { org(o?: object): Promise<number>; member(org: string, user: string | null, o?: object): Promise<number> };
let store: MemoryStore;
let logoView: (r: Request, c: { params: Promise<{ file: string }> }) => Promise<Response>;
let src: number, fetchedSrc: number;
let candidateCookie: string;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  R.profile = await import("../../../apps/portal/app/api/portal/company/route");
  R.logo = await import("../../../apps/portal/app/api/portal/company/logo/route");
  R.close = await import("../../../apps/portal/app/api/portal/company/close/route");
  ({ GET: logoView } = await import("../../../apps/portal/app/api/portal/company/logo/[file]/route"));
  R.team = await import("../../../apps/portal/app/api/portal/team/route");
  R.claim = await import("../../../apps/portal/app/api/portal/claim/route");
  store = memoryStore();
  setFileStore(store);
  src = (await su.query("select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
  fetchedSrc = (await su.query("insert into job_source(kind, board) values ('board', 'fake-board') returning id")).rows[0].id;
  // a real candidate session (the candidate pool, its own cookie), to show the portal routes do not take it
  const cand = makeAuth("candidate", db.pool("app_candidate"));
  const h = { "content-type": "application/json", origin: "http://localhost:3000", "x-vercel-forwarded-for": "198.51.100.250" };
  const body = { email: "fake.candidate.p3@example.test", password: "Fake-password-12345", name: "Fake" };
  expect((await cand.handler(new Request("http://localhost:3000/api/auth/candidate/sign-up/email", { method: "POST", headers: h, body: JSON.stringify({ ...body, ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified = true where email = $1", [body.email]);
  const r = await cand.handler(new Request("http://localhost:3000/api/auth/candidate/sign-in/email", { method: "POST", headers: h, body: JSON.stringify({ email: body.email, password: body.password }) }));
  candidateCookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  expect(candidateCookie).toContain("candidate.session_token");
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
async function login() {
  const email = `${uid("fake.")}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/portal/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...portalAnswers }) }))).status).toBe(200);
  await su.query("update portal_user set email_verified = true where email = $1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/portal/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const id = (await su.query("select id from portal_user where email = $1", [email])).rows[0].id as string;
  return { cookie, id };
}
type Who = { cookie?: string };
// A company with an owner and one member of each other role, all signed in.
async function company(status = "verified") {
  const name = `Fake Widgets ${uid("")} Limited`;
  const org = String(await F.org({ name, status }));
  const [owner, recruiter, poster, viewer] = [await login(), await login(), await login(), await login()];
  const m = {
    owner: await F.member(org, owner.id, { role: "account_owner", signer: true }), recruiter: await F.member(org, recruiter.id, { role: "recruiter" }),
    poster: await F.member(org, poster.id, { role: "poster" }), viewer: await F.member(org, viewer.id, { role: "viewer" }),
  };
  return { org, name, owner, recruiter, poster, viewer, m };
}
type Opts = { origin?: string | null; body?: BodyInit; raw?: string; length?: string };
async function call(route: Route, method: keyof Route, who: Who, json?: unknown, o: Opts = {}) {
  const headers: Record<string, string> = who.cookie ? { cookie: who.cookie } : {};
  if (method !== "GET" && o.origin !== null) headers.origin = o.origin ?? BASE;
  if (json !== undefined || o.raw !== undefined) headers["content-type"] = "application/json";
  if (o.length) headers["content-length"] = o.length;
  const body = o.body ?? o.raw ?? (json === undefined ? undefined : JSON.stringify(json));
  const res = await route[method]!(new Request(`${BASE}/api/portal/company`, { method, headers, body }));
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, json: parsed, code: parsed?.code as string | undefined, type: res.headers.get("content-type") };
}
const file = (bytes: Uint8Array, name = "logo.png") => { const f = new FormData(); f.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>]), name); return f; };
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
const orgRow = (org: string) => one("select display_name, status, cro_number, slug, verified_at, short_description, website, county, logo_key, member_limit from organisation where id = $1", [org]);
const profile = { description: "We make fake widgets in Cork.\nSince 2020.", website: "https://fake-widgets.example.test", county: "Cork" };
async function job(org: string, status: string, o: { source?: string } = {}) {
  const fetched = o.source === "fetched";
  return (await one(`insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, salary_low, search_vector, badge, application_route)
    values ($1, $2, $3, 'Fake role', 'Fake', 'IT', 'critical_skills', $4, now() + interval '20 days', 'https://example.test', 40000, 'x', $5, 'own_page') returning id`,
    [org, o.source ?? "employer", fetched ? fetchedSrc : src, status, fetched ? "critical_skills_eligible" : null])).id as string;
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}

describe("P3: the profile", () => {
  it("the owner edits description, website and county; every member reads it back; one audit row names the columns only", async () => {
    const c = await company();
    const r = await call(R.profile, "POST", c.owner, profile);
    expect([r.status, r.json]).toEqual([200, { organisationId: c.org, changed: ["short_description", "website", "county"] }]);
    for (const who of [c.owner, c.recruiter, c.viewer]) {
      const g = await call(R.profile, "GET", who);
      expect(g.json.company).toMatchObject({ organisationId: c.org, name: c.name, status: "verified", ...profile, hasLogo: false, memberLimit: 10 }); // B54 added fields: portal-extras-p2.test.ts
    }
    const a = await one("select kind, actor_portal_user_id, action, changed_columns, before, after, reason_text from audit_event where action = 'organisation.profile' and object_id = $1", [String(c.org)]);
    expect(a).toEqual({ kind: "security", actor_portal_user_id: c.owner.id, action: "organisation.profile", changed_columns: ["short_description", "website", "county"], before: null, after: null, reason_text: null });
    // null clears; an unchanged field is not named
    expect((await call(R.profile, "POST", c.owner, { ...profile, website: null })).json.changed).toEqual(["website"]);
    expect((await orgRow(c.org)).website).toBeNull();
  });
  it("only the account owner edits: recruiter, poster and viewer are refused, another company's owner changes only their own", async () => {
    const c = await company(), d = await company();
    for (const who of [c.recruiter, c.poster, c.viewer]) expect((await call(R.profile, "POST", who, profile)).code).toBe("NOT_OWNER");
    const before = await orgRow(c.org);
    expect((await call(R.profile, "POST", d.owner, profile)).status).toBe(200);
    expect(await orgRow(c.org)).toEqual(before);
    expect((await orgRow(d.org)).county).toBe("Cork");
  });
  it("no login, a candidate session, a login with no company, a blocked login: refused", async () => {
    const c = await company();
    expect((await call(R.profile, "POST", {}, profile)).code).toBe("NO_SESSION");
    expect((await call(R.profile, "GET", {})).code).toBe("NO_SESSION");
    expect((await call(R.profile, "POST", { cookie: candidateCookie }, profile)).code).toBe("NO_SESSION");
    expect((await call(R.profile, "POST", await login(), profile)).code).toBe("NOT_OWNER");
    await su.query("update portal_user set status = 'blocked', blocked_at = now(), blocked_reason_code = 'fake' where id = $1", [c.owner.id]);
    expect((await call(R.profile, "POST", c.owner, profile)).code).toBe("REFUSED");
  });
  it("a suspended company cannot edit", async () => {
    const c = await company("suspended");
    expect((await call(R.profile, "POST", c.owner, profile)).code).toBe("ORGANISATION_NOT_AVAILABLE");
  });
  it("hostile input: fields that must not change, script, javascript: and http: websites, big body, wrong Origin", async () => {
    const c = await company();
    const before = await orgRow(c.org);
    for (const extra of [{ displayName: "Evil Ltd" }, { name: "Evil" }, { status: "verified" }, { croNumber: "1" }, { slug: "evil" }, { memberLimit: 50 }, { logoKey: "logo/x" }])
      expect((await call(R.profile, "POST", c.owner, { ...profile, ...extra })).code, JSON.stringify(extra)).toBe("BAD_REQUEST");
    for (const website of ["javascript:alert(1)", "http://fake.example.test", "https://", "//fake.example.test"])
      expect((await call(R.profile, "POST", c.owner, { ...profile, website })).code, website).toBe("BAD_REQUEST");
    expect((await call(R.profile, "POST", c.owner, { ...profile, description: "x".repeat(2001) })).code).toBe("BAD_REQUEST");
    expect((await call(R.profile, "POST", c.owner, { ...profile, county: "Narnia" })).code).toBe("BAD_REQUEST");
    expect((await call(R.profile, "POST", c.owner, undefined, { raw: "x".repeat(9000) })).code).toBe("BODY_TOO_LARGE");
    expect((await call(R.profile, "POST", c.owner, profile, { length: "100000" })).code).toBe("BODY_TOO_LARGE");
    expect((await call(R.profile, "POST", c.owner, undefined, { raw: "{bad" })).code).toBe("BAD_REQUEST");
    for (const origin of ["https://evil.example.test", "http://localhost:3000", null]) expect((await call(R.profile, "POST", c.owner, profile, { origin })).code).toBe("BAD_ORIGIN");
    expect(await orgRow(c.org)).toEqual(before);
    const s = await call(R.profile, "POST", c.owner, { ...profile, description: "<script>alert(1)</script>" });
    expect(s.status).toBe(200);
    expect((await orgRow(c.org)).short_description).toBe("<script>alert(1)</script>"); // stored as text; the reply is JSON, never HTML
    expect((await call(R.profile, "GET", c.owner)).type).toMatch(/^application\/json/);
  });
  it("app_portal cannot write organisation itself (name, status, CRO, member limit, logo), nor run the staff function", async () => {
    const c = await company();
    const p = db.pool("app_portal");
    for (const set of ["display_name = 'Evil'", "status = 'verified'", "cro_number = '1'", "member_limit = 50", "short_description = 'x'", "logo_key = null"])
      await expect(p.query(`update organisation set ${set} where id = $1`, [c.org]), set).rejects.toThrow(/permission denied/);
    await expect(p.query("select private.member_limit_set('x', $1, 50, 'fake')", [c.org])).rejects.toThrow(/permission denied/);
    // and the edit function changes nothing it was not given: the protected columns stay
    const before = await orgRow(c.org);
    await call(R.profile, "POST", c.owner, profile);
    const after = await orgRow(c.org);
    for (const k of ["display_name", "status", "cro_number", "slug", "verified_at", "member_limit"] as const) expect(after[k], k).toEqual(before[k]);
  });
});

describe("P3: the logo", () => {
  it("upload, then replace: the new file is stored, the old one removed from the store, the key never in a reply", async () => {
    const c = await company();
    const a = await call(R.logo, "PUT", c.owner, undefined, { body: file(PNG) });
    expect([a.status, a.json]).toEqual([200, { logo: { contentType: "image/png", sizeBytes: PNG.length } }]);
    const k1 = (await orgRow(c.org)).logo_key as string;
    expect(k1).toMatch(/^logo\/[0-9a-f-]{36}\.png$/);
    expect(store.objects.get(k1)!.contentType).toBe("image/png");
    const b = await call(R.logo, "PUT", c.owner, undefined, { body: file(WEBP, "logo.webp") });
    expect(b.json.logo.contentType).toBe("image/webp");
    const k2 = (await orgRow(c.org)).logo_key as string;
    expect(k2).toMatch(/\.webp$/);
    expect([store.objects.has(k1), store.objects.has(k2)]).toEqual([false, true]);
    expect((await call(R.logo, "PUT", c.owner, undefined, { body: file(JPEG, "a.jpg") })).status).toBe(200);
    expect(store.objects.has(k2)).toBe(false);
    expect((await call(R.profile, "GET", c.viewer)).json.company.hasLogo).toBe(true);
    expect(JSON.stringify([a.json, b.json])).not.toContain(k1.slice(5, 41));
    expect(Number((await one("select count(*) from audit_event where action = 'organisation.logo' and object_id = $1", [String(c.org)])).count)).toBe(3);
  });
  it("refuses other types (a program named .png, a PDF, an SVG), an empty file and over 1 MB; nothing is stored", async () => {
    const c = await company();
    const keys = store.objects.size;
    expect((await call(R.logo, "PUT", c.owner, undefined, { body: file(EXE, "logo.png") })).code).toBe("WRONG_FILE_TYPE");
    expect((await call(R.logo, "PUT", c.owner, undefined, { body: file(PDF, "logo.png") })).code).toBe("WRONG_FILE_TYPE");
    expect((await call(R.logo, "PUT", c.owner, undefined, { body: file(new TextEncoder().encode("<svg onload=alert(1)>"), "logo.svg") })).code).toBe("WRONG_FILE_TYPE");
    expect((await call(R.logo, "PUT", c.owner, undefined, { body: file(new Uint8Array(), "logo.png") })).code).toBe("EMPTY_FILE");
    const big = new Uint8Array(1024 * 1024 + 1); big.set(PNG);
    expect((await call(R.logo, "PUT", c.owner, undefined, { body: file(big) })).code).toBe("FILE_TOO_LARGE");
    expect((await call(R.logo, "PUT", c.owner, undefined, { body: file(PNG), length: String(2 * 1024 * 1024) })).code).toBe("FILE_TOO_LARGE");
    // the 1 MiB cap by header comes before the session: no session, a non-owner and a stranger all get 413 and no statement runs
    for (const who of [{}, c.viewer]) {
      const [r, n] = await counted(() => call(R.logo, "PUT", who, undefined, { body: file(PNG), length: String(1024 * 1024 + 16 * 1024 + 1) }));
      expect([r.status, r.code, n]).toEqual([413, "FILE_TOO_LARGE", 0]);
    }
    expect((await call(R.logo, "PUT", c.owner, undefined, { body: "x" })).code).toBe("BAD_REQUEST");
    expect(store.objects.size).toBe(keys);
    expect((await orgRow(c.org)).logo_key).toBeNull();
  });
  it("only the owner; no login, a candidate session, a wrong Origin are refused; a company that cannot edit leaves no file behind", async () => {
    const c = await company();
    const keys = store.objects.size;
    for (const who of [c.recruiter, c.poster, c.viewer, await login()]) expect((await call(R.logo, "PUT", who, undefined, { body: file(PNG) })).code).toBe("NOT_OWNER");
    expect((await call(R.logo, "PUT", {}, undefined, { body: file(PNG) })).code).toBe("NO_SESSION");
    expect((await call(R.logo, "PUT", { cookie: candidateCookie }, undefined, { body: file(PNG) })).code).toBe("NO_SESSION");
    for (const origin of ["https://evil.example.test", null]) expect((await call(R.logo, "PUT", c.owner, undefined, { body: file(PNG), origin })).code).toBe("BAD_ORIGIN");
    const s = await company("suspended");
    expect((await call(R.logo, "PUT", s.owner, undefined, { body: file(PNG) })).code).toBe("ORGANISATION_NOT_AVAILABLE");
    expect(store.objects.size).toBe(keys); // the suspended company's file was stored, then removed when the database refused
  });
});

// Step 16 B54 (frame E18): the company read's facts from the records, and the logo's public address.
const KEYS = ["claimed", "county", "croNumber", "croStatus", "description", "descriptionMax", "hasLogo", "kind", "labels", "legalNames", "logoUrl", "memberLimit", "name", "organisationId",
  "permitCount", "permitsSince", "slug", "status", "website"];
// An organisation update with its guard triggers off (a status the real flows reach only through staff steps).
async function setOrg(org: string, sql: string) {
  const k = await su.connect();
  try { await k.query("begin"); await k.query("set local session_replication_role = replica"); await k.query(`update organisation set ${sql} where id = $1`, [org]); await k.query("commit"); } finally { k.release(); }
}
const publicLogo = (file: string) => logoView(new Request(`${BASE}/api/portal/company/logo/${file}`), { params: Promise.resolve({ file }) });
describe("B54: the company read", () => {
  it("every member reads the same fields; a company with nothing linked shows the not-linked label, no CRO status, no permit count", async () => {
    const c = await company();
    for (const who of [c.owner, c.recruiter, c.poster, c.viewer]) {
      const g = await call(R.profile, "GET", who);
      expect(Object.keys(g.json.company).sort()).toEqual(KEYS);
      expect(replyProblems(loadSpec("portal"), "GET", "/api/portal/company", g.status, g.json)).toEqual([]);
      expect(g.json.company).toMatchObject({ kind: "employer", claimed: false, labels: ["Permit history not linked yet"], croNumber: null, croStatus: null, legalNames: [], logoUrl: null,
        permitCount: null, permitsSince: 2019, descriptionMax: 2000, slug: expect.stringMatching(/^[a-z0-9-]+$/) });
    }
  });
  it("claimed, the labels, the register's number and status, the legal names and the permits since 2019 come from the records", async () => {
    const c = await company(), other = await company();
    const cro = `${uid("9")}`.replace(/\D/g, "").slice(0, 7);
    await su.query("insert into cro_company(cro_number, name, normalised_name, status, last_seen_on) values ($1, 'Fake Widgets Limited', 'fake widgets', 'Normal', now())", [cro]);
    await su.query("update organisation set cro_number = $2, claimed_at = now(), permit_history = 'first_time' where id = $1", [c.org, cro]);
    const mk = async (org: string, name: string, kind: string, source: string) => String((await one("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, lower($2), $3, $4) returning id", [org, name, kind, source])).id);
    const dete = await mk(c.org, `Fake Widgets ${uid("L")} Ltd`, "legal", "dete");
    await mk(c.org, `Fake Alias ${uid("A")}`, "alias", "admin");
    await mk(other.org, `Other Company ${uid("O")} Ltd`, "legal", "dete");
    for (const [year, month, permits] of [[2018, null, 50], [2022, null, 4], [2023, 3, 1], [2023, 7, 2]] as const)
      await su.query("insert into dete_permit_count(dete_name, organisation_name_id, year, month, permits) values ($1, $2, $3, $4, $5)", [`fake dete ${uid("")}`, dete, year, month, permits]);
    const g = (await call(R.profile, "GET", c.viewer)).json.company;
    expect(g).toMatchObject({ claimed: true, labels: ["First-time sponsor"], croNumber: cro, croStatus: "Normal", permitsSince: 2019, permitCount: 7 }); // 2018 is before 2019; 2022 + (1 + 2)
    expect(g.legalNames).toHaveLength(1);
    expect(g.legalNames[0]).toMatch(/^fake widgets .* ltd$/i);
    expect(JSON.stringify(g)).not.toMatch(/other company|alias/i);
    // not claimed until verified: a pending company that has claimed_at is not "claimed"; claims removed adds its label; a restricted company is still claimed
    await su.query("update organisation set status = 'pending_review' where id = $1", [c.org]);
    expect((await call(R.profile, "GET", c.owner)).json.company.claimed).toBe(false);
    await setOrg(c.org, "status = 'verified_restricted', restricted_until = now() + interval '30 days', claims_removed_at = now()");
    expect((await call(R.profile, "GET", c.owner)).json.company).toMatchObject({ claimed: true, labels: ["First-time sponsor", "Sponsorship claims removed"] });
  });
  it("no login, a candidate session and a login with no company get nothing; another company's data never shows", async () => {
    expect((await call(R.profile, "GET", {})).code).toBe("NO_SESSION");
    expect((await call(R.profile, "GET", { cookie: candidateCookie })).code).toBe("NO_SESSION");
    expect((await call(R.profile, "GET", await login())).code).toBe("NO_COMPANY");
    const c = await company(), d = await company();
    const g = await call(R.profile, "GET", c.owner);
    expect(g.json.company.organisationId).toBe(c.org);
    expect(JSON.stringify(g.json)).not.toContain(d.name);
  });
  it("stays within 5 statements (requirePortal 3, the company, its permits) and its time budget", async () => {
    const c = await company();
    await call(R.profile, "GET", c.owner);
    const [r, n] = await counted(() => call(R.profile, "GET", c.owner));
    expect([r.status, n]).toEqual([200, 5]);
    const ms: number[] = [];
    for (let i = 0; i < 9; i++) { const t = performance.now(); await call(R.profile, "GET", c.owner); ms.push(performance.now() - t); }
    expect(ms.sort((a, b) => a - b)[4]!).toBeLessThan(25);
  });
});

describe("B54: the logo's public address", () => {
  it("an upload sets organisation.logo_url to this app's public address; the address serves the stored file with no login; a replaced logo's old address is gone", async () => {
    const c = await company();
    expect((await call(R.logo, "PUT", c.owner, undefined, { body: file(PNG) })).status).toBe(200);
    const o = await one("select logo_key, logo_url from organisation where id = $1", [c.org]);
    expect(o.logo_url).toBe(`${BASE}/api/portal/company/logo/${o.logo_key.slice(5)}`);
    expect((await call(R.profile, "GET", c.viewer)).json.company).toMatchObject({ hasLogo: true, logoUrl: o.logo_url });
    const r = await publicLogo(o.logo_key.slice(5));
    expect([r.status, r.headers.get("content-type"), r.headers.get("x-content-type-options"), r.headers.get("cross-origin-resource-policy"), r.headers.get("set-cookie")]).toEqual([200, "image/png", "nosniff", "cross-origin", null]);
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array(store.objects.get(o.logo_key)!.bytes));
    expect((await call(R.logo, "PUT", c.owner, undefined, { body: file(WEBP, "l.webp") })).status).toBe(200);
    expect((await publicLogo(o.logo_key.slice(5))).status).toBe(404);
    const n = await one("select logo_key, logo_url from organisation where id = $1", [c.org]);
    expect(n.logo_url).toMatch(/\.webp$/);
    expect((await publicLogo(n.logo_key.slice(5))).headers.get("content-type")).toBe("image/webp");
  });
  it("404 and nothing else for: another name, a made-up key, bad names, a file not scanned yet or with a threat, a rejected, closed or banned company", async () => {
    const c = await company();
    await call(R.logo, "PUT", c.owner, undefined, { body: file(PNG) });
    const key = (await orgRow(c.org)).logo_key as string, name = key.slice(5);
    expect((await publicLogo(name)).status).toBe(200);
    const other = `${crypto.randomUUID()}.png`;
    store.objects.set(`logo/${other}`, { bytes: PNG, contentType: "image/png" }); // a stored file no company points at
    for (const bad of [other, name.replace(".png", ".jpg"), `../${name}`, `${name}/x`, `logo/${name}`, name.toUpperCase(), name.replace(".png", ".svg"), name + "%00", "x".repeat(10_000), "", "case/1.pdf"])
      expect((await publicLogo(bad)).status, bad.slice(0, 60)).toBe(404);
    store.tags.set(key, null);
    expect((await publicLogo(name)).status).toBe(404); // no scan result yet
    store.tags.set(key, "THREATS_FOUND");
    expect((await publicLogo(name)).status).toBe(404);
    store.tags.delete(key);
    for (const status of ["rejected", "closed", "banned"]) {
      await setOrg(c.org, `status = '${status}'`); // the status guards (a ban row for banned) are not under test here
      expect((await publicLogo(name)).status, status).toBe(404);
    }
    await setOrg(c.org, "status = 'verified'");
    expect((await publicLogo(name)).status).toBe(200);
    store.objects.delete(`logo/${other}`);
    const body = await (await publicLogo(other)).text();
    expect(body).not.toMatch(/logo\//);
  });
  it("the database refuses a logo address that is not this key's own public path, and the old two-argument function is gone", async () => {
    const c = await company();
    const p = db.pool("app_portal");
    const key = `logo/${crypto.randomUUID()}.png`, ok = `https://portal.example.test/api/portal/company/logo/${key.slice(5)}`;
    for (const url of [null, "", "javascript:alert(1)", "https://portal.example.test/x.png", ok.replace(".png", ".webp"), `${ok}?x=1`, `${ok}#x`, ok.replace("portal.example.test", "a b"), `https://x.example.test/api/portal/company/logo/${crypto.randomUUID()}.png`, "x".repeat(400)])
      await expect(p.query("select private.company_logo($1, $2, $3)", [c.owner.id, key, url]), String(url).slice(0, 50)).rejects.toThrow(/BAD_REQUEST|violates|invalid input/);
    await expect(p.query("select private.company_logo($1, $2)", [c.owner.id, key])).rejects.toThrow(/does not exist/);
    expect((await orgRow(c.org)).logo_key).toBeNull();
    expect((await p.query("select private.company_logo($1, $2, $3) r", [c.owner.id, key, ok])).rows[0].r).toEqual({ organisationId: Number(c.org), oldKey: null });
    await expect(p.query("select private.company_logo($1, $2, $3)", [c.viewer.id, key.replace(/.{36}/, crypto.randomUUID()), ok])).rejects.toThrow(/NOT_OWNER/);
  });
  it("a public logo read is one statement and quick (no login, one lookup, one scan check, one read)", async () => {
    const c = await company();
    await call(R.logo, "PUT", c.owner, undefined, { body: file(PNG) });
    const name = ((await orgRow(c.org)).logo_key as string).slice(5);
    await publicLogo(name);
    const [r, n] = await counted(() => publicLogo(name));
    expect([r.status, n]).toEqual([200, 1]);
    const ms: number[] = [];
    for (let i = 0; i < 9; i++) { const t = performance.now(); await publicLogo(name); ms.push(performance.now() - t); }
    expect(ms.sort((a, b) => a - b)[4]!).toBeLessThan(15);
    const plan = (await su.query("explain select 1 from organisation where logo_key = $1", [`logo/${name}`])).rows.map((x) => x["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/organisation_logo_key_idx|Index|Seq Scan/); // a tiny table may still scan; the index exists for the real one
    expect((await one("select count(*)::int n from pg_indexes where indexname = 'organisation_logo_key_idx'")).n).toBe(1);
  });
});

describe("P12: the owner closes the company", () => {
  async function busy() {
    const c = await company();
    const jobs = { live: await job(c.org, "live"), draft: await job(c.org, "draft"), inReview: await job(c.org, "in_review"), underReview: await job(c.org, "under_review"),
      done: await job(c.org, "closed"), fetched: await job(c.org, "live", { source: "fetched" }) };
    await su.query("insert into review_item(queue, organisation_id, reason) values ('account_review', $1, 'fake')", [c.org]);
    const invitee = await F.member(c.org, null, { role: "poster", status: "invited", email: `${uid("inv")}@example.test` });
    await su.query("update membership set invite_token_hash = encode(sha256(convert_to($2, 'utf8')), 'hex'), invite_expires_at = now() + interval '7 days' where id = $1", [invitee, uid("t")]);
    const requester = await login();
    await F.member(c.org, requester.id, { role: "viewer", status: "join_requested" });
    return { ...c, jobs, invitee, requester };
  }
  const state = async (org: string) => ({
    org: (await orgRow(org)).status,
    jobs: (await su.query("select id::text, status, close_reason from job where organisation_id = $1 order by id", [org])).rows,
    items: (await su.query("select status, outcome from review_item where organisation_id = $1 or job_id in (select id from job where organisation_id = $1) order by id", [org])).rows,
    members: (await su.query("select status, invite_token_hash from membership where organisation_id = $1 order by id", [org])).rows,
    notices: Number((await one("select count(*) from notification where organisation_id = $1", [org])).count),
    emails: Number((await one("select count(*) from email_outbox where template = 'organisation_closed' and params->>'organisationId' = $1", [String(org)])).count),
  });

  it("closes jobs, drops items, ends memberships, cancels invites, tells every member, in one go; the records stay", async () => {
    const c = await busy();
    const jobCount = (await state(c.org)).jobs.length, memberCount = (await state(c.org)).members.length;
    const r = await call(R.close, "POST", c.owner, { confirmName: ` ${c.name} ` });
    expect([r.status, r.json]).toEqual([200, { organisationId: c.org, jobsClosed: 4, itemsDropped: 1, membershipsEnded: 4, invitesCancelled: 2 }]);
    const s = await state(c.org);
    expect(s.org).toBe("closed");
    const byId = Object.fromEntries(s.jobs.map((j) => [j.id, j]));
    for (const k of ["live", "draft", "inReview", "underReview"] as const) expect(byId[c.jobs[k]], k).toMatchObject({ status: "closed", close_reason: "closed" });
    expect(byId[c.jobs.fetched]).toMatchObject({ status: "live" }); // a board's advert is not the employer's to close
    expect(byId[c.jobs.done]).toMatchObject({ status: "closed", close_reason: null });
    expect(s.items.every((i) => i.status === "dropped")).toBe(true);
    expect(s.items.map((i) => i.outcome).sort()).toEqual(["job_closed", "organisation_closed"]); // the scam item goes with its job (0028), the account item here
    expect(s.members.every((m) => m.status === "removed" && m.invite_token_hash === null)).toBe(true);
    expect([s.jobs.length, s.members.length]).toEqual([jobCount, memberCount]); // nothing deleted
    expect([s.notices, s.emails]).toEqual([4, 4]);
    const mine = await one("select category, template_key, params from notification where portal_user_id = $1 and organisation_id = $2", [c.viewer.id, c.org]);
    expect(mine).toEqual({ category: "account", template_key: "organisation_closed", params: { organisationId: Number(c.org) } }); // the stored row; the reply sends it as text
    const a = await one("select actor_portal_user_id, before, after from audit_event where action = 'organisation.close' and object_id = $1", [String(c.org)]);
    expect(a).toEqual({ actor_portal_user_id: c.owner.id, before: { status: "verified" }, after: { status: "closed", jobs_closed: 4, items_dropped: 1, memberships_ended: 4, invites_cancelled: 2 } });
  });
  it("after the close: no edit, no invite, no logo, no second close, no claim by the same flow", async () => {
    const c = await busy();
    expect((await call(R.close, "POST", c.owner, { confirmName: c.name })).status).toBe(200);
    expect((await call(R.profile, "POST", c.owner, profile)).code).toBe("NOT_OWNER");
    expect((await call(R.close, "POST", c.owner, { confirmName: c.name })).code).toBe("NOT_OWNER");
    expect((await call(R.logo, "PUT", c.owner, undefined, { body: file(PNG) })).code).toBe("NOT_OWNER");
    expect((await call(R.team, "POST", c.owner, { action: "invite", email: "fake.next@example.test", role: "poster", isSigner: false })).code).toBe("NOT_OWNER");
    expect((await call(R.team, "POST", c.requester, { action: "request", organisationId: c.org })).code).toBe("ORGANISATION_NOT_AVAILABLE");
    expect((await call(R.claim, "POST", c.owner, { organisationId: c.org })).code).toBe("ORGANISATION_NOT_AVAILABLE"); // the claim needs 'unclaimed'
    await expect(su.query("insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url) values ($1, 'employer', $2, 'x', 'x', 'IT', 'general', 'live', now() + interval '1 day', 'https://example.test')", [c.org, src]))
      .rejects.toThrow(/closed/);
  });
  it("the wrong name, and every member who is not the owner, are refused and change nothing", async () => {
    const c = await busy();
    const before = await state(c.org);
    for (const confirmName of [c.name.toUpperCase(), c.name.slice(0, -1), "Fake Widgets"]) expect((await call(R.close, "POST", c.owner, { confirmName })).code).toBe("NAME_MISMATCH");
    for (const who of [c.recruiter, c.poster, c.viewer, c.requester]) expect((await call(R.close, "POST", who, { confirmName: c.name })).code).toBe("NOT_OWNER");
    const d = await company();
    expect((await call(R.close, "POST", d.owner, { confirmName: c.name })).code).toBe("NAME_MISMATCH"); // another company's owner names this company: their own is checked
    expect((await call(R.close, "POST", {}, { confirmName: c.name })).code).toBe("NO_SESSION");
    expect((await call(R.close, "POST", { cookie: candidateCookie }, { confirmName: c.name })).code).toBe("NO_SESSION");
    expect((await call(R.close, "POST", c.owner, { confirmName: c.name }, { origin: "https://evil.example.test" })).code).toBe("BAD_ORIGIN");
    expect((await call(R.close, "POST", c.owner, { confirmName: c.name, organisationId: d.org })).code).toBe("BAD_REQUEST");
    expect((await call(R.close, "POST", c.owner, undefined, { raw: "x".repeat(9000) })).code).toBe("BODY_TOO_LARGE");
    expect(await state(c.org)).toEqual(before);
    expect((await orgRow(d.org)).status).toBe("verified");
  });
  it("a suspended company cannot close itself (staff hold it)", async () => {
    const c = await company("suspended");
    expect((await call(R.close, "POST", c.owner, { confirmName: c.name })).code).toBe("ORGANISATION_NOT_AVAILABLE");
  });
  it("all or nothing: a failure at the last step leaves every row as it was", async () => {
    const c = await busy();
    const before = await state(c.org);
    // an outbox row already holding one member's key makes the last insert fail
    await su.query("insert into email_outbox(template, portal_user_id, dedupe_key) values ('fake', $1, $2)", [c.viewer.id, `organisation_closed:${c.org}:${c.viewer.id}`]);
    await expect(call(R.close, "POST", c.owner, { confirmName: c.name })).rejects.toThrow(/duplicate key/);
    expect(await state(c.org)).toEqual(before);
    expect(await one("select count(*)::int n from audit_event where action = 'organisation.close' and object_id = $1", [String(c.org)])).toEqual({ n: 0 });
  });
});

describe("performance: statements per call and median time", () => {
  it("edit, logo and close stay inside their budgets", async () => {
    const lines: string[] = [];
    const run = async (name: keyof typeof BUDGET, fn: (i: number) => Promise<{ status: number }>) => {
      const times: number[] = [];
      let statements = 0;
      for (let i = 0; i < 9; i++) {
        await su.query("delete from portal_rate_limit");
        const t0 = performance.now();
        const [r, s] = await counted(() => fn(i));
        times.push(performance.now() - t0);
        expect(r.status, name).toBe(200);
        statements = s;
      }
      const median = [...times].sort((x, y) => x - y)[4]!;
      lines.push(`${name}: ${statements} statements, median ${median.toFixed(1)} ms`);
      expect(statements, name).toBeLessThanOrEqual(BUDGET[name].statements);
      expect(median, name).toBeLessThan(BUDGET[name].medianMs);
    };
    const c = await company();
    await run("edit", (i) => call(R.profile, "POST", c.owner, { ...profile, county: i % 2 ? "Cork" : "Kerry" }));
    await run("logo", () => call(R.logo, "PUT", c.owner, undefined, { body: file(PNG) }));
    const cs = await Promise.all(Array.from({ length: 9 }, () => company()));
    await run("close", (i) => call(R.close, "POST", cs[i]!.owner, { confirmName: cs[i]!.name }));
    process.stdout.write(`company-profile perf: ${lines.join("; ")}\n`);
  });
});
