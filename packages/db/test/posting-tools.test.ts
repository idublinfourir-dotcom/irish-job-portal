// Step 15 small wave 1 (audit rows P2, P4, P5, P6, P8), end to end on the test database through the real route handlers of apps/portal, connected
// as app_portal, with real portal sessions and memoryStore() as the file store. No test reaches the network. Fake people and companies only.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { memoryStore, setFileStore, type MemoryStore } from "../src/file-store";
import { DOCX, PDF } from "../src/file-fixture";

// Statements counted on every pg.Client.query call and median of 9 warm calls, measured on 18 November 2026: search 5 (session 3, rate 1, the query),
// check 6 (session 3, rate 1, the company, the rules: read fresh since B66, 25 Nov 2026, so the check answers what the save will), suggest 3 (the session only), authority upload 6 (session 3, upload limit, the job, the insert), list 5 and link 5 (session 3, the job, the read). Times are about 4 times the
// measured median with a floor for a busy laptop: search 2.8 ms, check 2.0 ms, suggest 1.4 ms. Pages: the search on 50,000 CRO rows and 20,000
// names read 61 shared pages through the two trigram indexes (a sequential scan of cro_company alone is over 1,000); the budget is about 4 times that.
const BUDGET = { search: 5, check: 6, suggest: 3, upload: 6, list: 5, link: 5, searchMs: 25, checkMs: 25, suggestMs: 15, searchPages: 250 };

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request, ctx: never) => Promise<Response>;
let db: TestDb, su: pg.Pool, store: MemoryStore;
let AUTH: (r: Request) => Promise<Response>;
const R = {} as Record<"search" | "check" | "suggest" | "post" | "docs" | "doc", Record<string, Handler>>;
let F: { org(o?: object): Promise<number>; member(org: string, user: string | null, o?: object): Promise<number> };
let SEARCH: string;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  R.search = await import("../../../apps/portal/app/api/portal/claim/search/route") as never;
  R.check = await import("../../../apps/portal/app/api/portal/jobs/check/route") as never;
  R.suggest = await import("../../../apps/portal/app/api/portal/jobs/suggest/route") as never;
  R.post = await import("../../../apps/portal/app/api/portal/jobs/route") as never;
  R.docs = await import("../../../apps/portal/app/api/portal/jobs/[id]/authority/route") as never;
  R.doc = await import("../../../apps/portal/app/api/portal/jobs/[id]/authority/[docId]/route") as never;
  ({ SEARCH } = await import("../../../apps/portal/lib/company"));
  store = memoryStore();
  setFileStore(store);
});
afterAll(async () => {
  setFileStore(undefined);
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
beforeEach(async () => { await su.query("delete from portal_rate_limit where key not like '%:sign-%'"); });

let n = 0;
async function login() {
  const email = `fake.s1.${++n}.${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/portal/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...portalAnswers }) }))).status).toBe(200);
  await su.query("update portal_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/portal/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), id: (await su.query("select id from portal_user where email=$1", [email])).rows[0].id as string };
}
type Login = { cookie?: string; id?: string };
type Opts = { origin?: string | null; body?: BodyInit; params?: Record<string, string>; query?: string };
async function call(h: Handler, p: Login, o: Opts = {}) {
  const method = o.body === undefined ? "GET" : "POST";
  const headers: Record<string, string> = p.cookie ? { cookie: p.cookie } : {};
  if (method === "POST" && o.origin !== null) headers.origin = o.origin ?? BASE;
  if (typeof o.body === "string") headers["content-type"] = "application/json";
  const res = await h(new Request(`${BASE}/api/portal/x${o.query ?? ""}`, { method, headers, body: o.body }), { params: Promise.resolve(o.params ?? {}) } as never);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, code: json?.code as string | undefined, headers: res.headers };
}
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => {
  const ms = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
  return ms.sort((a, b) => a - b)[4]!;
};
async function company(kind = "employer", name = "Fake Payments Limited") {
  const org = String(await F.org({ kind, name, wrc: kind === "agency" ? `EA9${++n}` : null }));
  const m = async (role: string) => { const l = await login(); return { ...l, mem: String(await F.member(org, l.id, { role, signer: role !== "viewer" && role !== "poster" })) }; };
  return { org, owner: await m("account_owner"), poster: await m("poster"), viewer: await m("viewer") };
}
const desc = "We are hiring a software engineer to build our payments platform in Dublin. Full sponsorship offered.";
const good = { status: "live", title: "Software Engineer", description: desc, county: "Dublin", occupationCode: "2136", contractType: "permanent",
  salaryLow: 50000, salaryHigh: 60000, ownPageUrl: "https://careers.example.ie/jobs/1" };
const spec = () => loadSpec("portal");

describe("P2: GET /api/portal/claim/search", () => {
  let unclaimed: string;
  beforeAll(async () => {
    unclaimed = String(await F.org({ name: "Fake Zephyrwind Limited", status: "unclaimed", cro: "900001" }));
    const claimed = String(await F.org({ name: "Fake Zephyrwind Two Limited", status: "verified" }));
    const merged = String(await F.org({ name: "Fake Zephyrwind Old Limited", status: "unclaimed" }));
    await su.query("update organisation set merged_into_id = $1 where id = $2", [unclaimed, merged]);
    for (const [org, name, cro] of [[unclaimed, "fake zephyrwind", "900001"], [claimed, "fake zephyrwind two", "900002"], [merged, "fake zephyrwind old", null]])
      await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source, cro_number) values ($1, $2, $2, 'legal', 'dete', $3)", [org, name, cro]);
    await su.query(`insert into cro_company(cro_number, name, normalised_name, status, county, last_seen_on) values
      ('900001', 'FAKE ZEPHYRWIND LIMITED', 'fake zephyrwind', 'Normal', 'Cork', current_date), ('900002', 'FAKE ZEPHYRWIND TWO LIMITED', 'fake zephyrwind two', 'Normal', 'Cork', current_date),
      ('900003', 'FAKE ZEPHYRWIND THREE LIMITED', 'fake zephyrwind three', 'Normal', 'Kerry', current_date)`);
  });
  const search = (p: Login, q: string) => call(R.search.GET!, p, { query: q });

  it("finds the unclaimed company and the CRO row no company holds, and nothing claimed, merged or internal", async () => {
    const p = await login(); // a login with no company: the claim screen's user
    const r = await search(p, "?q=zephyrwind");
    expect(r.status).toBe(200);
    expect(r.json.results).toEqual([
      { organisationId: unclaimed, name: "Fake Zephyrwind Limited", croNumber: "900001", county: null },
      { organisationId: null, name: "FAKE ZEPHYRWIND THREE LIMITED", croNumber: "900003", county: "Kerry" },
    ]);
    expect(replyProblems(spec(), "get", "/api/portal/claim/search", 200, r.json)).toEqual([]);
    expect((await search(p, "?q=" + encodeURIComponent("Fake Zephyrwind Ltd."))).json.results[0].organisationId).toBe(unclaimed); // the legal form is dropped
  });
  it("finds by CRO number, typed the way people type it", async () => {
    const p = await login();
    expect((await search(p, "?q=" + encodeURIComponent("IE 0900001"))).json.results).toEqual([{ organisationId: unclaimed, name: "Fake Zephyrwind Limited", croNumber: "900001", county: null }]);
    expect((await search(p, "?q=900003")).json.results).toEqual([{ organisationId: null, name: "FAKE ZEPHYRWIND THREE LIMITED", croNumber: "900003", county: "Kerry" }]);
    expect((await search(p, "?q=900002")).json.results).toEqual([]); // the claimed company's number
  });
  it("refuses bad queries, no session, and over 60 searches in 10 minutes; hostile text finds nothing and leaks nothing", async () => {
    const p = await login();
    for (const q of ["", "?q=ab", "?q=" + "a".repeat(161), "?q=%25%25%25", "?q=acme%00", "?q=a&q=b", "?q=acme&organisationId=1"])
      expect((await search(p, q)).code, q).toBe("BAD_REQUEST");
    for (const q of ["'; drop table organisation; --", "zephyr%wind", "zephyr_wind", "<script>zephyrwind</script>"]) {
      const r = await search(p, "?q=" + encodeURIComponent(q));
      expect(r.status, q).toBe(200);
      for (const row of r.json.results) expect(Object.keys(row).sort()).toEqual(["county", "croNumber", "name", "organisationId"]);
    }
    expect((await search({}, "?q=zephyrwind")).code).toBe("NO_SESSION");
    for (let i = 0; i < 60 - 4; i++) expect((await search(p, "?q=zephyrwind")).status).toBe(200);
    expect((await search(p, "?q=zephyrwind")).code).toBe("TOO_MANY_REQUESTS");
  });
  it("a blocked login is refused", async () => {
    const p = await login();
    await su.query("update portal_user set status='blocked', blocked_at=now(), blocked_reason_code='x' where id=$1", [p.id]);
    expect((await search(p, "?q=zephyrwind")).code).toBe("REFUSED");
  });
  it("performance: statements, time, and pages read through the trigram indexes on 50,000 CRO rows and 20,000 names", async () => {
    const p = await login();
    expect((await counted(() => search(p, "?q=zephyrwind")))[1]).toBeLessThanOrEqual(BUDGET.search);
    await su.query(`insert into cro_company(cro_number, name, normalised_name, status, last_seen_on)
      select (800000 + g)::text, 'FAKE FILLER ' || md5(g::text), 'fake filler ' || md5(g::text), 'Normal', current_date from generate_series(1, 50000) g`);
    await su.query(`insert into organisation_name(name, normalised_name, kind, source) select 'filler ' || md5(g::text), 'filler ' || md5(g::text), 'legal', 'dete' from generate_series(1, 20000) g`);
    // the GIN pending list is flushed by (auto)vacuum, as after the weekly CRO import on the live database
    await su.query("vacuum analyze cro_company"); await su.query("vacuum analyze organisation_name");
    const plan = (await su.query(`explain (analyze, buffers, format json) ${SEARCH}`, ["zephyrwind", null])).rows[0]["QUERY PLAN"][0];
    const pages = plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"];
    expect(JSON.stringify(plan)).toContain("cro_company_trgm");
    expect(JSON.stringify(plan)).toContain("organisation_name_trgm");
    expect(pages).toBeLessThanOrEqual(BUDGET.searchPages);
    expect(await median(() => search(p, "?q=zephyrwind"))).toBeLessThan(BUDGET.searchMs);
    await su.query("delete from portal_rate_limit where key like 'search:%'");
  });
});

describe("P4: POST /api/portal/jobs/check", () => {
  const check = (p: Login, body: unknown, o: Opts = {}) => call(R.check.POST!, p, { body: typeof body === "string" ? body : JSON.stringify(body), ...o });
  const jobs = async (org: string) => Number((await one("select count(*) n from job where organisation_id = $1", [org])).n);

  it("answers ok with what a save would do, writes nothing, and a refusal is the same reply as the post's", async () => {
    const c = await company();
    const r = await check(c.poster, good);
    expect([r.status, r.json]).toEqual([200, { ok: true, status: "live", passRoute: "stated_pay", sector: "IT", checks: expect.any(Array) }]);
    expect(replyProblems(spec(), "post", "/api/portal/jobs/check", 200, r.json)).toEqual([]);
    expect((await check(c.poster, { ...good, status: "draft" })).json).toMatchObject({ ok: true }); // the status does not matter
    for (const body of [{ ...good, salaryLow: 30000, salaryHigh: null }, { ...good, occupationCode: "5434", title: "Head Chef" }, { ...good, contractType: "fixed_term", contractMonths: 6 },
      { ...good, occupationCode: "6145", title: "Home Carer", permitType: "general" }]) {
      const dry = await check(c.poster, body), real = await call(R.post.POST!, c.poster, { body: JSON.stringify(body) });
      expect(dry.status).toBe(422);
      const { checks, ...answer } = dry.json; // the single answer is the post's own reply; the list is the check's addition (B50)
      expect(checks.some((c: { state: string; code?: string }) => c.state === "blocked" && c.code === answer.code)).toBe(true);
      expect([dry.status, answer]).toEqual([real.status, real.json]);
    }
    expect(await jobs(c.org)).toBe(0);
    expect((await one("select count(*)::int n from portal_rate_limit where key = $1", [`jobs:${c.poster.id}`])).n).toBe(1); // the four real posts, one row
    expect((await one("select count from portal_rate_limit where key = $1", [`jobcheck:${c.poster.id}`])).count).toBe(6);
  });
  it("runs the agency checks of a save", async () => {
    const e = await company(), a = await company("agency", "Fake Agency Limited");
    expect((await check(e.poster, { ...good, clientName: "Fake Client Limited" })).code).toBe("CLIENT_ONLY_FOR_AGENCIES");
    expect((await check(a.owner, { ...good, clientName: "Fake Client Limited", statement: { signerName: "Fake Signer", signerTitle: "Director" } })).code).toBe("WRITTEN_AUTHORITY_REQUIRED");
  });
  it("security: viewer, no company, no session, wrong Origin, bad bodies, and the limit of 120 checks", async () => {
    const c = await company(), loose = await login();
    expect((await check(c.viewer, good)).code).toBe("NOT_A_POSTER");
    expect((await check(loose, good)).code).toBe("NOT_A_MEMBER");
    expect((await check({}, good)).code).toBe("NO_SESSION");
    for (const origin of ["https://evil.example.test", null]) expect((await check(c.poster, good, { origin })).code).toBe("BAD_ORIGIN");
    for (const b of ["not json", "[]", JSON.stringify({ ...good, organisationId: "1" }), JSON.stringify({ ...good, occupationCode: "21a6" }), JSON.stringify({ ...good, title: "x".repeat(201) })])
      expect((await check(c.poster, b)).code).toBe("BAD_REQUEST");
    expect((await check(c.poster, { ...good, description: "x".repeat(30_000) })).code).toBe("BODY_TOO_LARGE");
    await su.query("insert into portal_rate_limit(id, key, count, last_request) values (gen_random_uuid()::text, $1, 120, $2)", [`jobcheck:${c.poster.id}`, Date.now() + 600_000]); // last_request is the window's end
    expect((await check(c.poster, good)).code).toBe("TOO_MANY_REQUESTS");
  });
  it("performance: statements and time", async () => {
    const c = await company();
    await check(c.poster, good); // the rules cache
    expect((await counted(() => check(c.poster, good)))[1]).toBeLessThanOrEqual(BUDGET.check);
    expect(await median(() => check(c.poster, good))).toBeLessThan(BUDGET.checkMs);
  });
});

describe("P5: GET /api/portal/jobs/suggest", () => {
  const suggest = (p: Login, q: string) => call(R.suggest.GET!, p, { query: q });
  it("answers up to 3 codes with their official titles for any signed-in portal login", async () => {
    const p = await login();
    const r = await suggest(p, "?title=" + encodeURIComponent("Staff Nurse"));
    expect([r.status, r.json]).toEqual([200, { suggestions: [{ code: "2231", title: "Nurses" }] }]);
    expect(replyProblems(spec(), "get", "/api/portal/jobs/suggest", 200, r.json)).toEqual([]);
    expect((await suggest(p, "?title=" + encodeURIComponent("Data Engineer Architect Developer Scientist"))).json.suggestions.map((s: { code: string }) => s.code)).toEqual(["2136", "2139", "2112"]);
    expect((await suggest(p, "?title=Zzzz")).json).toEqual({ suggestions: [] });
  });
  it("refuses no session, a missing, short, long or doubled title, an extra key and control characters", async () => {
    const p = await login();
    expect((await suggest({}, "?title=Nurse")).code).toBe("NO_SESSION");
    for (const q of ["", "?title=", "?title=x", "?title=" + "a".repeat(201), "?title=a&title=b", "?title=Nurse&x=1", "?title=Nur%00se", "?title=Nur%E2%80%AEse"])
      expect((await suggest(p, q)).code, q).toBe("BAD_REQUEST");
  });
  it("performance: the session only, and fast on a hostile 200-character title", async () => {
    const p = await login();
    expect((await counted(() => suggest(p, "?title=Nurse")))[1]).toBeLessThanOrEqual(BUDGET.suggest);
    expect(await median(() => suggest(p, "?title=" + encodeURIComponent(`${"operator ".repeat(21)}bim`)))).toBeLessThan(BUDGET.suggestMs);
  });
});

describe("P8: the client's written authority on an agency job", () => {
  const file = (bytes: Uint8Array, name = "authority.pdf") => { const f = new FormData(); f.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>]), name); return f; };
  const clientJob = async (p: Login) => {
    const r = await call(R.post.POST!, p, { body: JSON.stringify({ ...good, status: "draft", clientName: "Fake Client Limited" }) });
    expect(r.status).toBe(200);
    return String(r.json.jobId);
  };
  const up = (p: Login, job: string, bytes: Uint8Array = PDF, o: Opts = {}) => call(R.docs.POST!, p, { body: file(bytes), params: { id: job }, ...o });
  const list = (p: Login, job: string) => call(R.docs.GET!, p, { params: { id: job } });
  const link = (p: Login, job: string, doc: string) => call(R.doc.GET!, p, { params: { id: job, docId: doc } });

  it("a poster uploads a copy, any poster of the agency lists and opens it; the tick stays the rule", async () => {
    const a = await company("agency", "Fake Agency Limited");
    const job = await clientJob(a.poster);
    const r = await up(a.poster, job);
    expect(r.status).toBe(200);
    expect(r.json.document).toMatchObject({ fileName: "authority.pdf", contentType: "pdf", sizeBytes: PDF.length, copyDeleted: false });
    expect(replyProblems(spec(), "post", "/api/portal/jobs/{id}/authority", 200, r.json)).toEqual([]);
    const row = await one("select * from job_authority_document where id = $1", [r.json.document.id]);
    expect(row).toMatchObject({ job_id: job, organisation_id: a.org, uploaded_by_membership_id: a.poster.mem });
    expect(row.storage_key).toMatch(/^authority\//);
    expect(store.objects.get(row.storage_key)!.contentType).toBe("application/pdf");
    expect((await list(a.owner, job)).json.documents).toEqual([r.json.document]);
    const l = await link(a.owner, job, r.json.document.id);
    expect([l.status, l.headers.get("cache-control"), new URL(l.headers.get("location")!).pathname]).toEqual([302, "no-store", `/${row.storage_key}`]);
    expect((await up(a.poster, job, DOCX)).code).toBe("WRONG_FILE_TYPE");
  });
  it("security: a viewer, another agency, an employer's own job, no session, a wrong Origin and bad ids", async () => {
    const a = await company("agency", "Fake Agency Limited"), b = await company("agency", "Fake Other Agency Limited"), e = await company();
    const job = await clientJob(a.poster);
    const doc = (await up(a.poster, job)).json.document.id;
    for (const p of [a.viewer, b.owner, b.poster]) {
      expect((await up(p, job)).code).toBe("JOB_NOT_FOUND");
      expect((await list(p, job)).code).toBe("JOB_NOT_FOUND");
      expect((await link(p, job, doc)).code).toBe("JOB_NOT_FOUND");
    }
    const own = String((await call(R.post.POST!, e.poster, { body: JSON.stringify({ ...good, status: "draft" }) })).json.jobId);
    expect((await up(e.poster, own)).code).toBe("JOB_NOT_FOUND"); // an employer's own job names no client
    expect((await list({}, job)).code).toBe("NO_SESSION");
    for (const origin of ["https://evil.example.test", null]) expect((await up(a.poster, job, PDF, { origin })).code).toBe("BAD_ORIGIN");
    for (const id of ["0", "07", "-1", "x", "9223372036854775808", "1;drop"]) expect((await list(a.poster, id)).code, id).toBe("BAD_REQUEST");
    for (const d of ["0", "x"]) expect((await link(a.poster, job, d)).code).toBe("BAD_REQUEST");
    const otherJob = await clientJob(b.poster);
    expect((await link(b.poster, otherJob, doc)).code).toBe("DOCUMENT_NOT_FOUND"); // a document id of another job
    const loose = await login();
    expect((await list(loose, job)).code).toBe("JOB_NOT_FOUND");
  });
  it("at most 20 stored copies per job, and retention removes the copies 30 days after the job closes", async () => {
    const a = await company("agency", "Fake Agency Limited");
    const job = await clientJob(a.poster);
    const doc = (await up(a.poster, job)).json.document.id;
    const key = (await one("select storage_key from job_authority_document where id = $1", [doc])).storage_key;
    await su.query(`insert into job_authority_document(job_id, organisation_id, storage_key, file_name, content_type, byte_size)
      select $1, $2, 'authority/fake-' || g, 'f.pdf', 'pdf', 10 from generate_series(1, 19) g`, [job, a.org]);
    expect((await up(a.poster, job)).code).toBe("DOCUMENT_LIMIT");
    await su.query("update job set status = 'closed', closed_at = now() - interval '29 days', close_reason = 'closed' where id = $1", [job]);
    const admin = db.pool("app_admin");
    const run = async () => { for (;;) { const r = (await admin.query("select private.run_retention(1000) r")).rows[0].r; if (r.target === "job_authority_document" || r.rule === null) return r; } };
    expect((await run()).rule).toBeNull(); // 29 days: not yet
    await su.query("update job set closed_at = now() - interval '31 days' where id = $1", [job]);
    const r = await run();
    expect(r).toMatchObject({ rule: "services_case_copy", target: "job_authority_document", done: 20, left: 0 });
    expect(r.storage_keys).toContain(key);
    expect(await one("select count(*)::int n from job_authority_document where job_id = $1 and storage_key is null and file_name is null and copy_deleted_at is not null", [job])).toEqual({ n: 20 });
    expect((await list(a.poster, job)).json.documents.every((d: { copyDeleted: boolean }) => d.copyDeleted)).toBe(true);
    expect((await link(a.poster, job, doc)).code).toBe("DOCUMENT_NOT_FOUND");
  });
  it("gap 4: an upload racing another for the 20th copy waits on the job lock and is DOCUMENT_LIMIT, with no object left behind", async () => {
    const a = await company("agency", "Fake Agency Limited");
    const job = await clientJob(a.poster);
    const fill = `insert into job_authority_document(job_id, organisation_id, storage_key, file_name, content_type, byte_size) values ($1, $2, $3, 'f.pdf', 'pdf', 10)`;
    await su.query(`insert into job_authority_document(job_id, organisation_id, storage_key, file_name, content_type, byte_size)
      select $1, $2, 'authority/fake-race-' || g, 'f.pdf', 'pdf', 10 from generate_series(1, 19) g`, [job, a.org]);
    const objects = store.objects.size;
    // the other upload: its 20th copy is inserted and not yet committed, so it holds the lock on the job row
    const other = await db.pool("app_portal").connect();
    try {
      await other.query("begin");
      await other.query(fill, [job, a.org, "authority/fake-race-20"]);
      const racing = up(a.poster, job); // its first count sees 19 committed copies and passes; its insert waits on the lock
      await new Promise((r) => setTimeout(r, 300));
      expect((await su.query("select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")).rows[0].n).toBeGreaterThanOrEqual(1);
      await other.query("commit");
      const r = await racing;
      expect([r.status, r.code]).toEqual([409, "DOCUMENT_LIMIT"]);
    } finally { other.release(); }
    expect(await one("select count(*)::int n from job_authority_document where job_id = $1 and storage_key is not null", [job])).toEqual({ n: 20 });
    expect(store.objects.size).toBe(objects); // the refused upload's object was removed
    // any writer, not only the route: a 21st is refused by the database
    await expect(db.pool("app_portal").query(fill, [job, a.org, "authority/fake-direct"])).rejects.toThrow(/authority refused: DOCUMENT_LIMIT/);
    // a copy deleted by retention frees a place
    await su.query("update job_authority_document set storage_key = null, file_name = null, copy_deleted_at = now() where storage_key = 'authority/fake-race-1'");
    expect((await up(a.poster, job)).status).toBe(200);
  });
  it("performance: statements per call", async () => {
    const a = await company("agency", "Fake Agency Limited");
    const job = await clientJob(a.poster);
    const [r, nUp] = await counted(() => up(a.poster, job));
    expect(nUp).toBeLessThanOrEqual(BUDGET.upload);
    expect((await counted(() => list(a.poster, job)))[1]).toBeLessThanOrEqual(BUDGET.list);
    expect((await counted(() => link(a.poster, job, r.json.document.id)))[1]).toBeLessThanOrEqual(BUDGET.link);
  });
});
