// The candidate data export, end to end on the test database: real sign-up and sign-in, then the real route handler. Fake people only; no outside service.
// Sections: what is in the file, what is never in it, another candidate's rows, the audit row, hostile input, and a budget for a full candidate.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
const BUDGET = { statements: 4, medianMs: 60 }; // a full candidate (200 saved, 200 tracked, 200 asked), measured 13 Nov 2026: 4 statements (2 session, export, extras)
let db: TestDb, su: pg.Pool, F: { org(o?: object): Promise<string>; staff(): Promise<string>; portal(): Promise<string>; member(org: string, user: string): Promise<string> };
let AUTH: (r: Request) => Promise<Response>, ROUTE: Record<string, (r: Request) => Promise<Response>>;
let org: string, src: string;
// app_admin runs it too since 0050 (the staff export of a data request, data-requests.test.ts)
const ROLES = ["app_portal", "app_fetcher", "anon", "authenticated"] as const;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ROUTE = await import("../../../apps/candidate/app/api/candidate/export/route");
  org = await F.org({ name: "Fake Org" });
  src = (await su.query("insert into job_source(kind,board) values ('portal','export-test') returning id")).rows[0].id;
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const uid = (p: string) => `${p}${++n}${Date.now().toString(36)}`;
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows;
async function job(title: string, status = "live"): Promise<string> {
  return (await one(
    `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,search_vector,salary_low,pay_grade,application_route)
     values ($1,'admin_manual',$2,$3,$4,'it','critical_skills',$5,now()+interval '20 days','https://example.test/apply',to_tsvector('english','cook'),30000,'g1','own_page') returning id::text`,
    [org, src, title, `Employer of ${title}`, status]))[0].id;
}
async function login() {
  const email = `${uid("fake.")}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  const up = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...answers }) }));
  expect(up.status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const id = (await one("select id from candidate_user where email=$1", [email]))[0].id as string;
  return { cookie, id, email };
}
const get = (cookie?: string, query = "") => ROUTE.GET!(new Request(`${BASE}/api/candidate/export${query}`, { headers: cookie ? { cookie } : {} }));

/** A row in every section, every text tagged so another candidate's rows can be searched for. Returns the values that must never appear in a file. */
async function fill(p: Awaited<ReturnType<typeof login>>, tag: string) {
  const [saved, tracked, clicked] = [await job(`Saved ${tag}`), await job(`Tracked ${tag}`), await job(`Clicked ${tag}`)];
  const text = (await one("select id from consent_text where purpose='signup_terms' limit 1"))[0].id;
  await su.query("insert into candidate_profile(candidate_user_id, full_name, phone, location_kind, current_stamp) values ($1,$2,'+353 1 234 5678','ireland','1G')", [p.id, `Name ${tag}`]);
  await su.query("insert into candidate_cv(candidate_user_id, storage_key, file_name, content_type, size_bytes) values ($1,$2,$3,'pdf',1000)", [p.id, `STORAGEKEY-${tag}`, `cv-${tag}.pdf`]);
  await su.query("insert into saved_job(candidate_user_id, job_id) values ($1,$2)", [p.id, saved]);
  await su.query("insert into tracker_entry(candidate_user_id, job_id, route, origin, stage) values ($1,$2,'redirect','mark_applied','applied')", [p.id, tracked]);
  await su.query("insert into apply_click(candidate_user_id, job_id, status, times_asked, answered_at) values ($1,$2,'yes',1,now())", [p.id, clicked]);
  await su.query("insert into alert(candidate_user_id, county, frequency, unsubscribe_token) values ($1,$2,'daily',$3)", [p.id, "Dublin", `UNSUBTOKEN-${tag}`]);
  await su.query("insert into notification_preference(candidate_user_id, category, channel, enabled) values ($1,'job_alerts','email',false)", [p.id]);
  await su.query("insert into notification(candidate_user_id, category, template_key, params, dedupe_key) values ($1,'account',$2,'{}',$3)", [p.id, `tpl-${tag}`, `DEDUPEKEY-${tag}`]);
  await su.query("insert into consent_record(candidate_user_id, consent_text_id, organisation_id, details) values ($1,$2,$3,$4)", [p.id, text, org, JSON.stringify({ for: tag })]);
  const staff = await F.staff();
  const caseId = (await one(
    "insert into services_case(candidate_user_id, consent_record_id) select $1, id from consent_record where candidate_user_id=$1 limit 1 returning id", [p.id]))[0].id;
  await su.query("insert into case_note(services_case_id, author_staff_user_id, body) values ($1,$2,$3)", [caseId, staff, `INTERNALNOTE-${tag}`]);
  await su.query("insert into email_outbox(template, candidate_user_id, params, dedupe_key) values ('job_alert',$1,$2,$3)", [p.id, JSON.stringify({ m: `OUTBOXPARAMS-${tag}` }), `OUTBOXKEY-${tag}`]);
  await su.query("insert into audit_event(kind, actor_system, action, subject_candidate_user_id, reason_text, source) values ('data_access','x','system.read',$1,$2,'scheduled_job')", [p.id, `AUDITREASON-${tag}`]);
  await su.query("update staff_user set name=$2 where id=$1", [staff, `STAFFNAME-${tag}`]);
  await su.query("insert into audit_event(kind, actor_staff_user_id, action, subject_candidate_user_id, reason_text, source) values ('data_access',$1,'staff.view',$2,$3,'panel')", [staff, p.id, `STAFFREASON-${tag}`]);
  const pu = await F.portal(), eorg = await F.org({ name: `Employer ${tag}` });
  await su.query("update portal_user set name=$2, email=$3 where id=$1", [pu, `PORTALNAME-${tag}`, `portal-${tag}@example.test`]);
  await F.member(eorg, pu);
  await su.query("insert into audit_event(kind, actor_portal_user_id, action, subject_candidate_user_id, source) values ('data_access',$1,'employer.view',$2,'site')", [pu, p.id]);
  await su.query("insert into audit_event(kind, actor_candidate_user_id, action, object_type, object_id, before, after, source) values ('security',$1,'candidate.signin','candidate_user',$1,$2,$2,'site')", [p.id, JSON.stringify({ m: `AUDITBODY-${tag}` })]);
  await su.query("insert into candidate_rate_limit(id, key, count, last_request) values ($1,$2,1,1)", [uid("rl"), `RATELIMITKEY-${tag}`]);
  await su.query("insert into candidate_verification(id, identifier, value, expires_at, created_at, updated_at) values ($1,$2,$3,now()+interval '1 day',now(),now())", [uid("v"), p.email, `VERIFYTOKEN-${tag}`]);
  await su.query("update candidate_account set access_token=$2, refresh_token=$3, id_token=$4 where user_id=$1", [p.id, `ACCESSTOKEN-${tag}`, `REFRESHTOKEN-${tag}`, `IDTOKEN-${tag}`]);
  const row = (await one("select a.password hash, s.token session from candidate_account a join candidate_session s on s.user_id=a.user_id where a.user_id=$1 limit 1", [p.id]))[0];
  return [row.hash, row.session, staff, pu, `portal-${tag}@example.test`, ...["STAFFNAME", "STAFFREASON", "PORTALNAME", "AUDITBODY", "UNSUBTOKEN", "STORAGEKEY", "DEDUPEKEY", "INTERNALNOTE", "OUTBOXPARAMS", "OUTBOXKEY", "AUDITREASON", "RATELIMITKEY", "VERIFYTOKEN", "ACCESSTOKEN", "REFRESHTOKEN", "IDTOKEN"].map((k) => `${k}-${tag}`)] as string[];
}

describe("what the file holds", () => {
  it("answers one downloadable JSON file with a row in every section, saved jobs with title and employer, and honest lists for what is not available", async () => {
    const p = await login();
    await fill(p, "mine");
    const res = await get(p.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="my-data-${new Date().toISOString().slice(0, 10)}.json"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
    const f = JSON.parse(await res.text());
    expect(f.account).toMatchObject({ name: "Fake", email: p.email, emailConfirmed: true, signInMethods: ["credential"] });
    expect(f.account.createdAt).toBeTruthy();
    expect(f.account.lastActiveAt).toBeTruthy();
    expect(f.profile).toMatchObject({ fullName: "Name mine", phone: "+353 1 234 5678", currentStamp: "1G", locationKind: "ireland", visibleToEmployers: false });
    expect(f.cv).toEqual([expect.objectContaining({ fileName: "cv-mine.pdf", contentType: "pdf", sizeBytes: 1000 })]);
    expect(f.savedJobs).toEqual([expect.objectContaining({ title: "Saved mine", employerName: "Employer of Saved mine" })]);
    expect(f.tracker).toEqual([expect.objectContaining({ title: "Tracked mine", stage: "applied", origin: "mark_applied", route: "redirect" })]);
    expect(f.didYouApply).toEqual([expect.objectContaining({ title: "Clicked mine", status: "yes", timesAsked: 1 })]);
    expect(f.alerts).toEqual([expect.objectContaining({ county: "Dublin", frequency: "daily", status: "active" })]);
    expect(f.consents.map((c: { purpose: string }) => c.purpose).sort()).toEqual(["signup_terms", "signup_terms"]); // the sign-up one and the filled one
    expect(f.consents.find((c: { organisation: string | null }) => c.organisation)).toMatchObject({ organisation: "Fake Org", details: { for: "mine" } });
    expect(f.consents[0]).toHaveProperty("textVersion");
    expect(f.notificationSettings).toEqual([{ category: "job_alerts", channel: "email", enabled: false }]);
    expect(f.notifications).toEqual([expect.objectContaining({ templateKey: "tpl-mine" })]);
    expect(f.applications).toEqual([]);
    expect(f.contactRequests).toEqual([]);
    expect(f.emailsWeSent).toEqual([{ template: "job_alert", status: "pending", sendAfter: expect.any(String), sentAt: null }]);
    expect(f.yourActionsOnTheSite).toEqual([
      expect.objectContaining({ kind: "data_access", action: "candidate.export", objectType: "candidate_user" }), // this export, written before the extras are read
      expect.objectContaining({ kind: "security", action: "candidate.signin", objectType: "candidate_user" }),
    ]);
    expect(Object.keys(f.yourActionsOnTheSite[0]).sort()).toEqual(["action", "at", "kind", "objectType"]);
    expect(f.whoAccessedOrReceivedYourData.map((x: { by: string; action: string }) => [x.by, x.action]).sort()).toEqual([
      ["Employer mine", "employer.view"], ["Portal staff", "staff.view"], ["Portal system", "system.read"]]);
    expect(Object.keys(f.whoAccessedOrReceivedYourData[0]).sort()).toEqual(["action", "at", "by"]);
    expect(f.notIncluded.map((x: { section: string }) => x.section)).toEqual(["contactFormMessages", "reportsYouMade"]);
    expect(new Date(f.exportedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
  it("a new candidate gets every section as an empty list or null, never a missing key", async () => {
    const p = await login();
    const f = JSON.parse(await (await get(p.cookie)).text());
    for (const k of ["emailsWeSent", "whoAccessedOrReceivedYourData", "savedJobs", "tracker", "didYouApply", "alerts", "notificationSettings", "notifications", "cv", "applications", "contactRequests"]) expect(f[k], k).toEqual([]);
    expect(f.profile).toBeNull();
    expect(f.consents).toHaveLength(1);
    expect(f.yourActionsOnTheSite).toEqual([expect.objectContaining({ action: "candidate.export" })]); // only this export
  });
  it("shows a saved job that has since closed with its title and employer", async () => {
    const p = await login();
    const j = await job("Closed later");
    await su.query("insert into saved_job(candidate_user_id, job_id) values ($1,$2)", [p.id, j]);
    await su.query("update job set status='closed', closed_at=now(), close_reason='expired' where id=$1", [j]);
    const f = JSON.parse(await (await get(p.cookie)).text());
    expect(f.savedJobs).toEqual([expect.objectContaining({ title: "Closed later", employerName: "Employer of Closed later" })]);
  });
});

describe("security", () => {
  it("never holds a hash, token, key, staff note, log or queue value, and never another candidate's rows, anywhere in the text", async () => {
    const a = await login(), b = await login();
    const secretsA = await fill(a, "alpha"), secretsB = await fill(b, "bravo");
    expect(secretsA.length).toBeGreaterThan(14);
    for (const [who, other, mine, theirs] of [[a, b, "alpha", "bravo"], [b, a, "bravo", "alpha"]] as const) {
      const text = await (await get(who.cookie)).text();
      for (const s of [...secretsA, ...secretsB]) expect(text, s).not.toContain(s);
      for (const s of [other.id, other.email, theirs]) expect(text, s).not.toContain(s);
      expect(text).toContain(mine);
      expect(text).toContain(who.email);
      expect(text).not.toMatch(/password|token|storage_key|storageKey|dedupe/i);
    }
  });
  it("no sign-in, a junk cookie, a suspended and a deleted candidate are refused with no data", async () => {
    const s = await login(), d = await login();
    await su.query("update candidate_user set suspended_at=now() where id=$1", [s.id]);
    await su.query("update candidate_user set deleted_at=now() where id=$1", [d.id]);
    const before = await one("select count(*)::int c from audit_event where action='candidate.export'");
    const none = await get();
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ code: "NO_SESSION" });
    expect(none.headers.get("content-disposition")).toBeNull();
    expect(none.headers.get("cache-control")).toBe("no-store");
    expect((await get("better-auth.session_token=junk")).status).toBe(401);
    const sus = await get(s.cookie);
    expect(sus.status).toBe(403);
    expect(await sus.text()).not.toContain(s.email);
    expect([401, 403]).toContain((await get(d.cookie)).status);
    expect(await one("select count(*)::int c from audit_event where action='candidate.export'")).toEqual(before); // a refusal leaves no row
  });
  it("the extras function returns only the given candidate's rows, and no other role can run it", async () => {
    const a = await login(), b = await login();
    await fill(a, "echo"); await fill(b, "foxtrot");
    const call = async (id: string) => (await db.pool("app_candidate").query("select private.candidate_export_extras($1) x", [id])).rows[0].x;
    const x = JSON.stringify(await call(a.id));
    expect(x).toContain("Employer echo");
    expect(x).not.toMatch(/foxtrot|echo.*foxtrot/);
    expect(x).not.toContain(b.id);
    expect(await call("no-such-candidate")).toEqual({ emailsWeSent: [], yourActionsOnTheSite: [], whoAccessedOrReceivedYourData: [] });
    for (const role of ROLES) {
      const pool = db.pool(role);
      await expect(pool.query("select private.candidate_export_extras($1)", [a.id]), role).rejects.toThrow(/permission denied/);
    }
    await expect(db.pool("app_candidate").query("select * from audit_event limit 1")).rejects.toThrow(/permission denied/);
    await expect(db.pool("app_candidate").query("select template from email_outbox limit 1")).rejects.toThrow(/permission denied/);
  });
  it("only GET exists on the route", () => {
    expect(Object.keys(ROUTE)).toEqual(["GET"]);
  });
  it("unknown query parameters are ignored: same file, someone else's id in the query changes nothing, and nothing but one audit row is written", async () => {
    const a = await login(), b = await login();
    await fill(a, "gamma"); await fill(b, "delta");
    const tables = ["candidate_user", "candidate_profile", "saved_job", "tracker_entry", "apply_click", "alert", "notification", "notification_preference", "consent_record", "email_outbox", "candidate_session", "candidate_account"];
    const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await one(`select count(*)::int c from ${t}`))[0].c])));
    const before = await counts();
    const plain = JSON.parse(await (await get(a.cookie)).text()), hostile = await get(a.cookie, `?userId=${b.id}&candidate_user_id=${b.id}&id=1&format=csv&download=0&x=%00'%3B%20drop%20table%20alert%3B--`);
    expect(hostile.status).toBe(200);
    const h = JSON.parse(await hostile.text());
    expect(h.yourActionsOnTheSite.length).toBe(plain.yourActionsOnTheSite.length + 1); // the earlier export is now one of the candidate's actions
    for (const f of [plain, h]) { delete f.exportedAt; delete f.yourActionsOnTheSite; }
    expect(h).toEqual(plain);
    expect(JSON.stringify(h)).not.toContain("delta");
    expect(await counts()).toEqual(before);
    expect(Number((await one("select count(*) c from alert"))[0].c)).toBeGreaterThan(0);
  });
});

describe("the audit record", () => {
  it("writes one row per export, the candidate as the actor and the subject, and nothing else changes", async () => {
    const p = await login();
    const where = "action='candidate.export' and actor_candidate_user_id=$1";
    expect(await one(`select count(*)::int c from audit_event where ${where}`, [p.id])).toEqual([{ c: 0 }]);
    await get(p.cookie); await get(p.cookie);
    const rows = await one(`select kind, actor_staff_user_id, actor_portal_user_id, actor_system, subject_candidate_user_id, object_type, object_id, source from audit_event where ${where}`, [p.id]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ kind: "data_access", actor_staff_user_id: null, actor_portal_user_id: null, actor_system: null, subject_candidate_user_id: p.id, object_type: "candidate_user", object_id: p.id, source: "site" });
  });
});

describe("performance", () => {
  it("a full candidate (200 saved, 200 tracked, 200 asked, 10 alerts) stays inside the statement and time budget", async () => {
    const p = await login();
    const ids = (await one(
      `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,search_vector,application_route)
       select $1,'admin_manual',$2,'Bulk '||g,'Bulk Employer','it','critical_skills','live',now()+interval '20 days','https://example.test/apply',to_tsvector('english','cook'),'own_page' from generate_series(1,200) g returning id`,
      [org, src])).map((r) => r.id);
    await su.query("insert into saved_job(candidate_user_id, job_id) select $1, unnest($2::bigint[])", [p.id, ids]);
    await su.query("insert into tracker_entry(candidate_user_id, job_id, route, origin, stage) select $1, unnest($2::bigint[]), 'redirect','mark_applied','applied'", [p.id, ids]);
    await su.query("insert into apply_click(candidate_user_id, job_id, status, times_asked) select $1, unnest($2::bigint[]), 'yes', 1", [p.id, ids]);
    await su.query("insert into alert(candidate_user_id, frequency, unsubscribe_token) select $1,'daily','perf-'||g||'-'||$1 from generate_series(1,10) g", [p.id]);
    const q = pg.Client.prototype.query;
    const times: number[] = []; let statements = 0;
    for (let i = 0; i < 9; i++) {
      let c = 0;
      pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
      const t = performance.now();
      try { const r = await get(p.cookie); expect(r.status).toBe(200); expect(JSON.parse(await r.text()).savedJobs).toHaveLength(200); } finally { pg.Client.prototype.query = q; }
      times.push(performance.now() - t); statements = Math.max(statements, c);
    }
    const median = [...times].sort((a, b) => a - b)[4]!;
    console.log(`candidate-export: ${statements} statements, median ${median.toFixed(1)} ms`);
    expect(statements).toBeLessThanOrEqual(BUDGET.statements);
    expect(median).toBeLessThan(BUDGET.medianMs);
  });
});
