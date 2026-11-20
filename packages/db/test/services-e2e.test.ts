// End to end (step 15 services wave combine): one candidate case and one portal case through the real route handlers of all three apps, the real
// auth routes and the real database functions and triggers, on the real test database. Each app runs as its own login: the pool is swapped per
// call (as data-requests.test.ts), so each app's auth keeps the login it first saw. memoryStore() is the file store (no S3, no network); the
// consent texts come from the real seed command. Fake people only. No SQL stands in for a route; SQL only makes fixtures and reads results.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type Role, type TestDb } from "./db";
import { answers, portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { staffHarness, BASE as ADMIN } from "./staff-routes-harness";
import { memoryStore, setFileStore, type MemoryStore } from "../src/file-store";
import { PNG } from "../src/file-fixture";
import { saveServicesTexts } from "../src/services-texts-cli";
import { REFERRAL_FIRM_SHOWN } from "../src/services-board";

vi.setConfig({ testTimeout: 180000, hookTimeout: 120000 });
const secret = "trial-only-secret-trial-only-secret-32", CAND = "http://localhost:3000", PORT = "http://localhost:3001";
type Handler = (r: Request, ctx: never) => Promise<Response>;
type Route = Partial<Record<"GET" | "POST", Handler>>;
let db: TestDb, su: pg.Pool, h: Awaited<ReturnType<typeof staffHarness>>, store: MemoryStore;
let F: { org(o?: object): Promise<string>; member(o: string, u: string, x?: { role?: string }): Promise<string> };
const A = {} as Record<"cases" | "sol" | "docs" | "doc", Route>;
const C = {} as Record<"auth" | "cases" | "one" | "timeline" | "withdraw" | "docs", Route>, P = {} as typeof C;

/** Runs `fn` as one app's database login (the routes and the auth read globalThis.__portalPool). */
async function as<T>(role: Role, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { __portalPool?: pg.Pool }, before = g.__portalPool;
  g.__portalPool = db.pool(role);
  try { return await fn(); } finally { g.__portalPool = before; }
}

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su);
  await seedSignupTerms(su, "portal_signup_terms");
  const c = await db.pool("app_admin").connect();
  try { expect(await saveServicesTexts(c)).toEqual(["services_request", "employer_contact"]); } finally { c.release(); } // the live step, as the admin login
  h = await staffHarness(db); // sets DATABASE_URL (unused: every call below picks its login) and the staff auth settings
  Object.assign(process.env, { CANDIDATE_AUTH_URL: CAND, CANDIDATE_AUTH_SECRET: secret, PORTAL_AUTH_URL: PORT, PORTAL_AUTH_SECRET: secret });
  await as("app_admin", async () => { for (const [n, r] of [["h1", "services_case_handler"], ["h2", "services_case_handler"], ["ad", "administrator"]]) await h.makeStaff(n!, [r!]); });
  A.cases = await import("../../../apps/admin/app/api/services/cases/route");
  A.sol = await import("../../../apps/admin/app/api/services/solicitors/route");
  A.docs = await import("../../../apps/admin/app/api/services/cases/[id]/documents/route");
  A.doc = await import("../../../apps/admin/app/api/services/cases/[id]/documents/[docId]/route");
  for (const [side, R] of [["candidate", C], ["portal", P]] as const) {
    R.auth = await import(`../../../apps/${side}/app/api/auth/${side}/[...all]/route`);
    R.cases = await import(`../../../apps/${side}/app/api/${side}/cases/route`);
    R.one = await import(`../../../apps/${side}/app/api/${side}/cases/[id]/route`);
    R.timeline = await import(`../../../apps/${side}/app/api/${side}/cases/[id]/timeline/route`);
    R.withdraw = await import(`../../../apps/${side}/app/api/${side}/cases/[id]/withdraw/route`);
    R.docs = await import(`../../../apps/${side}/app/api/${side}/cases/[id]/documents/route`);
  }
  store = memoryStore();
  store.scanDefault = null; // the scan has not tagged anything yet
  setFileStore(store);
});
afterAll(async () => {
  setFileStore(undefined);
  await db.drop();
});

let n = 0;
type Login = { cookie: string; id: string };
async function login(side: "candidate" | "portal"): Promise<Login> {
  const R = side === "candidate" ? C : P, base = side === "candidate" ? CAND : PORT, role = side === "candidate" ? "app_candidate" : "app_portal";
  const email = `fake.e2e.${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const hd = { "content-type": "application/json", origin: base, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  return as(role, async () => {
    const up = await R.auth.POST!(new Request(`${base}/api/auth/${side}/sign-up/email`, { method: "POST", headers: hd, body: JSON.stringify({ email, password, name: "Fake", ...(side === "candidate" ? answers : portalAnswers) }) }), undefined as never);
    expect(up.status).toBe(200);
    await su.query(`update ${side}_user set email_verified = true where email = $1`, [email]);
    const r = await R.auth.POST!(new Request(`${base}/api/auth/${side}/sign-in/email`, { method: "POST", headers: hd, body: JSON.stringify({ email, password }) }), undefined as never);
    expect(r.status).toBe(200);
    return { cookie: r.headers.getSetCookie().map((x) => x.split(";")[0]).join("; "), id: (await su.query(`select id from ${side}_user where email = $1`, [email])).rows[0].id as string };
  });
}
type Reply = { status: number; json: Record<string, any>; code?: string; headers: Headers; bytes: Uint8Array }; // eslint-disable-line @typescript-eslint/no-explicit-any
/** One call to a requester route of one side. A body (JSON or a form) makes it a POST with the site's Origin. */
async function side(s: "candidate" | "portal", route: Handler, who: Login, o: { body?: unknown; form?: FormData; id?: string } = {}): Promise<Reply> {
  const base = s === "candidate" ? CAND : PORT, post = o.body !== undefined || o.form !== undefined;
  const headers: Record<string, string> = { cookie: who.cookie, ...(post ? { origin: base } : {}) };
  return as(s === "candidate" ? "app_candidate" : "app_portal", async () => {
    const res = await route(new Request(`${base}/api/${s}/cases`, { method: post ? "POST" : "GET", headers, body: o.form ?? (post ? (typeof o.body === "string" ? o.body : JSON.stringify(o.body)) : undefined) }), { params: Promise.resolve({ id: o.id ?? "" }) } as never);
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, json, code: json?.code, headers: res.headers, bytes: new Uint8Array() };
  });
}
const cand = (r: Handler, who: Login, o?: Parameters<typeof side>[3]) => side("candidate", r, who, o);
const port = (r: Handler, who: Login, o?: Parameters<typeof side>[3]) => side("portal", r, who, o);
/** One staff action on the board, as the admin app's login. */
const act = (who: string, body: Record<string, unknown>) => as("app_admin", () => h.ok(h.call(A.cases as never, "/api/services/cases", who, body)));
/** A staff open of one stored copy (M4), as the admin app's login. */
const openDoc = (who: string, c: string, docId: string) => as("app_admin", async () => {
  const res = await A.doc.GET!(new Request(`${ADMIN}/api/services/cases/${c}/documents/${docId}`, { headers: { cookie: h.signedIn(who) } }), { params: Promise.resolve({ id: c, docId }) } as never);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, json: /json/.test(res.headers.get("content-type") ?? "") ? JSON.parse(new TextDecoder().decode(bytes)) : null };
});
const rows = async (sql: string, a: unknown[] = []) => (await su.query(sql, a)).rows;
const file = (bytes: Uint8Array, name: string) => { const f = new FormData(); f.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>]), name); return f; };

describe("services wave end to end", () => {
  it("a candidate case from the request to a refused decision and a referral, through every app's real routes", async () => {
    // a live fetched job of an employer
    const org = await F.org();
    const src = (await rows("insert into job_source(kind, board) values ('greenhouse', 'e2e-board') returning id"))[0].id;
    const advert = (await rows("insert into fetched_advert(job_source_id, external_id, url, title, employer_name, result) values ($1, 'e2e-1', 'https://jobs.example.test/e2e', 'Fake Engineer', 'Fake Org', 'passed') returning id", [src]))[0].id;
    const jobId = String((await rows(`insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, sector, permit_type, badge, status, closes_at, own_page_url, search_vector)
      values ($1, 'fetched', $2, $3, 'Fake Engineer', 'Fake Org', 'IT', 'critical_skills', 'critical_skills_eligible', 'live', now() + interval '20 days', 'https://jobs.example.test/e2e', to_tsvector('english', 'engineer')) returning id`, [org, src, advert]))[0].id);
    const me = await login("candidate");

    // 1. the request (SV-A) with the HR-contact tick: two consent records, the case, the received event, one in-app notice, no email
    const req = await cand(C.cases.POST!, me, { body: { permitType: "critical_skills", jobId, servicesConsent: true, employerContact: true, offerDetails: { occupationCode: "2136", annualPay: "50000", relevantDegree: "true", title: "Fake Engineer" } } });
    expect(req.status, JSON.stringify(req.json)).toBe(200);
    const c = req.json.case.id as string;
    expect((await rows("select payer, organisation_id::text org, employer_contact_consent_record_id is not null hr from services_case where id = $1", [c]))[0]).toEqual({ payer: "employer", org, hr: true });
    const notices = () => rows("select params from notification where candidate_user_id = $1 order by id", [me.id]);
    const mails = () => rows("select template, params from email_outbox where candidate_user_id = $1 order by id", [me.id]);
    expect(await notices()).toEqual([{ params: { caseId: c, kind: "received" } }]);
    expect(await mails()).toEqual([]);

    // 2. the handler takes it and asks for documents (SV-B2): the documents step gives one notice and one case_update email with the case id only
    await act("h1", { action: "assign", caseId: c, staffUserId: h.staff.h1 });
    await act("h1", { action: "status", caseId: c, status: "documents_needed" });
    const [n0, m0] = [(await notices()).length, (await mails()).length];
    await act("h1", { action: "documents", caseId: c, codes: ["passport_copy", "offer_letter"] });
    expect((await notices()).slice(n0)).toEqual([{ params: { caseId: c, kind: "documents_needed" } }]);
    expect((await mails()).slice(m0)).toEqual([{ template: "case_update", params: { caseId: c } }]);
    await act("h1", { action: "note", caseId: c, body: "Secret staff note e2e" });

    // 3. the candidate uploads (existing route, SV-B1 disarm): a PNG with a script after its end is stored re-encoded; an active PDF is refused
    const up = await cand(C.docs.POST!, me, { id: c, form: file(new Uint8Array([...PNG, ...Buffer.from("<script>alert(1)</script>")]), "passport.png") });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    const docId = up.json.document.id as string;
    const key = (await rows("select storage_key from case_document where id = $1", [docId]))[0].storage_key as string;
    expect(store.objects.get(key)).toEqual({ bytes: PNG, contentType: "image/png" });
    const bad = await cand(C.docs.POST!, me, { id: c, form: file(new Uint8Array(Buffer.from("%PDF-1.7\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1")), "offer.pdf") });
    expect([bad.status, bad.code]).toEqual([422, "FILE_ACTIVE_CONTENT"]);
    expect(await rows("select count(*)::int n from case_document where services_case_id = $1", [c])).toEqual([{ n: 1 }]);

    // 4. the handler opens the copy (SV-B1): scan_pending until the store's tag says NO_THREATS_FOUND, then the file inline and one data_access row
    const audits = () => rows("select actor_staff_user_id s, reason_code, related_case from audit_event where kind = 'data_access' and object_type = 'case_document' and object_id = $1", [docId]);
    expect(await openDoc("h1", c, docId).then((r) => [r.status, r.json])).toEqual([409, { error: "scan_pending" }]);
    store.tags.set(key, "NO_THREATS_FOUND");
    const o = await openDoc("h1", c, docId);
    expect([o.status, o.headers.get("content-type"), o.headers.get("content-disposition"), o.headers.get("x-content-type-options"), o.headers.get("cache-control")])
      .toEqual([200, "image/png", "inline; filename*=UTF-8''passport.png", "nosniff", "no-store"]);
    expect(o.bytes).toEqual(PNG);
    expect(await audits()).toEqual([{ s: h.staff.h1, reason_code: "services_case", related_case: `services_case:${c}` }]);
    // a second handler (not assigned) and an administrator are refused, and leave no audit row
    expect(await openDoc("h2", c, docId).then((r) => [r.status, r.json])).toEqual([404, { error: "case_not_found" }]);
    expect(await openDoc("ad", c, docId).then((r) => [r.status, r.json])).toEqual([403, { error: "not_case_handler" }]);
    expect(await audits()).toHaveLength(1);

    // 5. the decision is refused and the case is referred to an active solicitor (M9)
    const firm = await as("app_admin", () => h.ok(h.call(A.sol as never, "/api/services/solicitors", "ad", { action: "add", firm: "Fake E2E Solicitors", contact: "e2e.firm@example.test" })));
    for (const status of ["submitted", "decision"]) await act("h1", { action: "status", caseId: c, status });
    await act("h1", { action: "decision", caseId: c, outcome: "refused" });
    await act("h1", { action: "refer", caseId: c, solicitorId: firm.id });

    // 6. the candidate's timeline: every step, document labels, the generic referral (firm hidden), never a staff id, name or note
    expect(REFERRAL_FIRM_SHOWN).toBe(false);
    const t = await cand(C.timeline.GET!, me, { id: c });
    expect(t.status).toBe(200);
    expect(t.json.events.map((e: Record<string, unknown>) => { const { at, ...rest } = e; expect(at).toEqual(expect.any(String)); return rest; })).toEqual([
      { kind: "received", status: "received" },
      { kind: "assigned", status: "received" },
      { kind: "status_changed", status: "documents_needed" },
      { kind: "documents_needed", status: "documents_needed", documentsNeeded: [{ code: "passport_copy", label: "Passport copy" }, { code: "offer_letter", label: "Job offer letter" }] },
      { kind: "status_changed", status: "submitted" },
      { kind: "status_changed", status: "decision" },
      { kind: "decision", status: "decision", outcome: { code: "refused", label: "Permit refused" } },
      { kind: "referred", status: "closed", referral: { code: "referred_to_solicitor" } },
    ]);
    for (const hidden of [h.staff.h1!, "Fake h1", "h1@example.test", "Secret staff note", "Fake E2E Solicitors", "e2e.firm", "assignedStaffUserId", "referralSolicitorId"]) expect(JSON.stringify(t.json)).not.toContain(hidden);
    // the tracker (M2): closed, outcome refused
    expect((await cand(C.one.GET!, me, { id: c })).json.case).toMatchObject({ id: c, status: "closed", decisionOutcome: "refused", jobId, documentCount: 1 });
    // every in-app notice and email the case made came from 0063's trigger, one per event; emails only for documents, decision and the referral
    expect((await notices()).map((x) => x.params.kind)).toEqual(t.json.events.map((e: { kind: string }) => e.kind));
    expect((await mails()).map((x) => x.params)).toEqual([{ caseId: c }, { caseId: c }, { caseId: c }]);
  });

  it("the portal side once: an Owner asks with a key, a replay is the same case, a Recruiter reads it, a Poster and another company get 404, only the requester withdraws", async () => {
    const org = await F.org(), other = await F.org();
    const owner = await login("portal"), recruiter = await login("portal"), poster = await login("portal"), stranger = await login("portal");
    await F.member(org, owner.id, { role: "account_owner" });
    await F.member(org, recruiter.id, { role: "recruiter" });
    await F.member(org, poster.id, { role: "poster" });
    await F.member(other, stranger.id, { role: "account_owner" });
    const body = { permitType: "general", offerDetails: { employerName: "Fake Employer Limited" }, servicesConsent: true, idempotencyKey: "e2e-portal-key-0123456789" };
    const first = await port(P.cases.POST!, owner, { body });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.replayed).toBe(false);
    const c = first.json.case.id as string;
    const again = await port(P.cases.POST!, owner, { body });
    expect([again.status, again.json.replayed, again.json.case.id]).toEqual([200, true, c]);
    expect(await rows("select count(*)::int n from services_case where portal_user_id = $1", [owner.id])).toEqual([{ n: 1 }]);
    // the Recruiter reads the tracker and the timeline
    expect((await port(P.cases.GET!, recruiter)).json.cases.map((x: { id: string }) => x.id)).toEqual([c]);
    expect((await port(P.one.GET!, recruiter, { id: c })).json.case).toMatchObject({ id: c, status: "received" });
    expect((await port(P.timeline.GET!, recruiter, { id: c })).json.events.map((e: { kind: string }) => e.kind)).toEqual(["received"]);
    // a Poster and another company's Owner see nothing
    for (const who of [poster, stranger]) {
      for (const r of [P.one.GET!, P.timeline.GET!]) expect([(await port(r, who, { id: c })).status]).toEqual([404]);
      expect((await port(P.cases.GET!, who)).json?.cases ?? []).toEqual([]);
      expect((await port(P.withdraw.POST!, who, { id: c, body: "" })).status).toBe(404);
    }
    // only the requester withdraws: the Recruiter reads the case but did not ask
    expect([(await port(P.withdraw.POST!, recruiter, { id: c, body: "" })).code]).toEqual(["NOT_REQUESTER"]);
    const w = await port(P.withdraw.POST!, owner, { id: c, body: "" });
    expect([w.status, w.json.case.status]).toEqual([200, "closed"]);
    expect((await port(P.timeline.GET!, recruiter, { id: c })).json.events.map((e: { kind: string }) => e.kind)).toEqual(["received", "withdrawn"]);
    expect(await rows("select params->>'kind' k from notification where portal_user_id = any($1) order by id", [[owner.id, recruiter.id, poster.id, stranger.id]])).toEqual([{ k: "received" }, { k: "withdrawn" }]);
    expect(await rows("select count(*)::int n from email_outbox where params->>'caseId' = $1", [c])).toEqual([{ n: 0 }]);
  });
});
