// Step 15 storage wave: the portal's case document routes end to end on the test database, through the real auth route and the real route
// handlers of apps/portal (connected as app_portal), with memoryStore() as the file store. A case is the requesting login's own (portal_user_id):
// neither the database design nor 20b shares cases with teammates. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { memoryStore, setFileStore, type MemoryStore } from "../src/file-store";
import { DOCX, PDF, PNG } from "../src/file-fixture";

const BUDGET = { docPost: { statements: 6, medianMs: 40 }, docList: { statements: 5, medianMs: 30 }, docLink: { statements: 4, medianMs: 30 } };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request, ctx: never) => Promise<Response>; // a route context is { params: Promise<...> }
type Route = Partial<Record<"GET" | "POST" | "PUT", Handler>>;
let db: TestDb, su: pg.Pool;
let AUTH: (r: Request) => Promise<Response>;
const R = {} as Record<"docs" | "doc" | "candidateCv" | "candidateDocs", Route>;
let F: { text(p?: string): Promise<string> };
let store: MemoryStore;
const answered: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret,
    CANDIDATE_AUTH_URL: "http://localhost:3000", CANDIDATE_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  R.docs = await import("../../../apps/portal/app/api/portal/cases/[id]/documents/route");
  R.doc = await import("../../../apps/portal/app/api/portal/cases/[id]/documents/[docId]/route");
  R.candidateCv = await import("../../../apps/candidate/app/api/candidate/cv/route");
  R.candidateDocs = await import("../../../apps/candidate/app/api/candidate/cases/[id]/documents/route");
  store = memoryStore();
  setFileStore(store);
});
afterAll(async () => {
  setFileStore(undefined);
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const uid = (p: string) => `${p}${++n}${Date.now().toString(36)}`;
async function login() {
  const email = `${uid("fake.")}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/portal/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...portalAnswers }) }))).status).toBe(200);
  await su.query("update portal_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/portal/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const id = (await su.query("select id from portal_user where email=$1", [email])).rows[0].id as string;
  return { cookie, id };
}
type Opts = { origin?: string | null; body?: BodyInit; params?: Record<string, string> };
const file = (bytes: Uint8Array, name = "file.pdf") => { const f = new FormData(); f.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>]), name); return f; };
async function call(route: Route, method: keyof Route, p: { cookie?: string }, o: Opts = {}) {
  const headers: Record<string, string> = p.cookie ? { cookie: p.cookie } : {};
  if (method !== "GET" && o.origin !== null) headers.origin = o.origin ?? BASE;
  const res = await route[method]!(new Request(`${BASE}/api/portal/x`, { method, headers, body: o.body }), { params: Promise.resolve(o.params ?? {}) } as never);
  const text = await res.text();
  answered.push(text);
  return { status: res.status, json: text ? JSON.parse(text) : null, code: text ? (JSON.parse(text).code as string | undefined) : undefined, headers: res.headers };
}
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows;
async function caseFor(portalUser: string, status = "received") {
  const k = (await one("insert into consent_record(portal_user_id, consent_text_id) values ($1, $2) returning id", [portalUser, await F.text("services_request")]))[0].id;
  const closed = status === "closed" ? ["closed_at, close_reason, ", "now(), 'withdrawn', "] : ["", ""];
  return String((await one(`insert into services_case(portal_user_id, consent_record_id, ${closed[0]}status, dedupe_key) values ($1, $2, ${closed[1]}$3, $4) returning id`, [portalUser, k, status, uid("dk")]))[0].id);
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}

describe("case documents, portal side", () => {
  it("upload, list and open one's own, with or without a company", async () => {
    const p = await login();
    const c = await caseFor(p.id);
    const up = await call(R.docs, "POST", p, { body: file(PNG, "contract scan.png"), params: { id: c } });
    expect(up.status).toBe(200);
    expect(up.json.document).toMatchObject({ fileName: "contract scan.png", contentType: "png", sizeBytes: PNG.length, copyDeleted: false });
    const row = (await one("select storage_key, portal_user_id, candidate_user_id from case_document where id=$1", [up.json.document.id]))[0];
    expect(row).toMatchObject({ portal_user_id: p.id, candidate_user_id: null });
    expect(store.objects.get(row.storage_key)!.contentType).toBe("image/png");
    expect((await call(R.docs, "GET", p, { params: { id: c } })).json.documents).toEqual([up.json.document]);
    const link = await call(R.doc, "GET", p, { params: { id: c, docId: up.json.document.id } });
    expect([link.status, link.headers.get("cache-control"), link.headers.get("referrer-policy")]).toEqual([302, "no-store", "no-referrer"]);
    expect(new URL(link.headers.get("location")!).pathname).toBe(`/${row.storage_key}`);
    expect((await call(R.docs, "POST", p, { body: file(DOCX, "a.docx"), params: { id: c } })).code).toBe("WRONG_FILE_TYPE");
  });
  it("a closed or decided case refuses uploads; the 21st copy is refused", async () => {
    const p = await login();
    for (const s of ["decision", "closed"]) expect((await call(R.docs, "POST", p, { body: file(PDF), params: { id: await caseFor(p.id, s) } })).code).toBe("CASE_CLOSED");
    const c = await caseFor(p.id);
    await su.query(`insert into case_document(services_case_id, storage_key, file_name, content_type, byte_size, portal_user_id)
      select $1, 'case/fake-' || g, 'f.pdf', 'pdf', 10, $2 from generate_series(1, 20) g`, [c, p.id]);
    expect((await call(R.docs, "POST", p, { body: file(PDF), params: { id: c } })).code).toBe("DOCUMENT_LIMIT");
  });
});

describe("security", () => {
  it("no login is 401; another portal user's case and document are 404", async () => {
    const a = await login(), b = await login();
    const ca = await caseFor(a.id), cb = await caseFor(b.id);
    const doc = (await call(R.docs, "POST", a, { body: file(PDF), params: { id: ca } })).json.document.id;
    for (const [route, m, params] of [[R.docs, "GET", { id: ca }], [R.docs, "POST", { id: ca }], [R.doc, "GET", { id: ca, docId: doc }]] as const)
      expect((await call(route, m, {}, { body: m === "POST" ? file(PDF) : undefined, params })).code).toBe("NO_SESSION");
    expect((await call(R.docs, "GET", b, { params: { id: ca } })).code).toBe("CASE_NOT_FOUND");
    expect((await call(R.docs, "POST", b, { body: file(PDF), params: { id: ca } })).code).toBe("CASE_NOT_FOUND");
    expect((await call(R.doc, "GET", b, { params: { id: ca, docId: doc } })).code).toBe("DOCUMENT_NOT_FOUND");
    expect((await call(R.doc, "GET", b, { params: { id: cb, docId: doc } })).code).toBe("DOCUMENT_NOT_FOUND");
  });
  it("a candidate's case is not a portal case, even for the same id", async () => {
    const p = await login();
    const cand = (await one("insert into candidate_user(id, name, email, email_verified, created_at, updated_at, last_active_at) values ($1, 'Fake', $2, true, now(), now(), now()) returning id", [uid("c"), `${uid("c")}@example.test`]))[0].id;
    const k = (await one("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [cand, await F.text("services_request")]))[0].id;
    const cc = String((await one("insert into services_case(candidate_user_id, consent_record_id) values ($1, $2) returning id", [cand, k]))[0].id);
    expect((await call(R.docs, "POST", p, { body: file(PDF), params: { id: cc } })).code).toBe("CASE_NOT_FOUND");
  });
  it("a blocked or deleted login is refused; a wrong or missing Origin is refused", async () => {
    const p = await login();
    const c = await caseFor(p.id);
    for (const origin of ["https://evil.example.test", "http://localhost:3000", null])
      expect((await call(R.docs, "POST", p, { body: file(PDF), params: { id: c }, origin })).code).toBe("BAD_ORIGIN");
    await su.query("update portal_user set deleted_at=now() where id=$1", [p.id]);
    expect((await call(R.docs, "GET", p, { params: { id: c } })).code).toBe("REFUSED");
    const q = await login();
    await su.query("update portal_user set status='blocked', blocked_at=now(), blocked_reason_code='x' where id=$1", [q.id]);
    expect((await call(R.docs, "POST", q, { body: file(PDF), params: { id: await caseFor(q.id) } })).code).toBe("REFUSED");
  });
  it("a portal login on the candidate's file routes is 401 (each app reads only its own cookie)", async () => {
    const p = await login();
    expect((await call(R.candidateCv, "GET", p)).code).toBe("NO_SESSION");
    expect((await call(R.candidateCv, "PUT", p, { body: file(PDF), origin: "http://localhost:3000" })).code).toBe("NO_SESSION");
    expect((await call(R.candidateDocs, "POST", p, { body: file(PDF), origin: "http://localhost:3000", params: { id: await caseFor(p.id) } })).code).toBe("NO_SESSION");
  });
  it("hostile input: a case id that is not a number, a body that is not multipart, an HTML 'image'", async () => {
    const p = await login();
    for (const id of ["abc", "1 or 1=1", "-5", "1e3"]) expect((await call(R.docs, "POST", p, { body: file(PDF), params: { id } })).code).toBe("BAD_REQUEST");
    const c = await caseFor(p.id);
    expect((await call(R.docs, "POST", p, { body: "x", params: { id: c } })).code).toBe("BAD_REQUEST");
    expect((await call(R.docs, "POST", p, { body: file(new TextEncoder().encode("<svg onload=alert(1)>"), "x.png"), params: { id: c } })).code).toBe("WRONG_FILE_TYPE");
  });
  it("no key appears in any answer", () => {
    const all = answered.join("\n");
    for (const k of store.objects.keys()) expect(all).not.toContain(k.slice(k.indexOf("/") + 1));
  });
});

describe("performance: statements per call and median time (database part)", () => {
  it("stays inside the budgets", async () => {
    const p = await login();
    const c = await caseFor(p.id);
    const doc = (await call(R.docs, "POST", p, { body: file(PDF), params: { id: c } })).json.document.id;
    const cases: [keyof typeof BUDGET, () => Promise<unknown>][] = [
      ["docPost", () => call(R.docs, "POST", p, { body: file(PDF), params: { id: c } })],
      ["docList", () => call(R.docs, "GET", p, { params: { id: c } })],
      ["docLink", () => call(R.doc, "GET", p, { params: { id: c, docId: doc } })],
    ];
    const lines: string[] = [];
    for (const [name, fn] of cases) {
      const times: number[] = [];
      let statements = 0;
      for (let i = 0; i < 9; i++) {
        await su.query("delete from portal_rate_limit");
        await su.query("delete from case_document where services_case_id=$1 and id <> $2", [c, doc]);
        const t0 = performance.now();
        [, statements] = await counted(fn);
        times.push(performance.now() - t0);
      }
      const median = [...times].sort((x, y) => x - y)[4]!;
      lines.push(`${name}: ${statements} statements, median ${median.toFixed(1)} ms`);
      expect(statements, name).toBeLessThanOrEqual(BUDGET[name].statements);
      expect(median, name).toBeLessThan(BUDGET[name].medianMs);
    }
    process.stdout.write(`files-portal perf: ${lines.join("; ")}\n`);
  });
});
