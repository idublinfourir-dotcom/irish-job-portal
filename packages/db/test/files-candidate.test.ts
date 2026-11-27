// Step 15 storage wave: the candidate's CV and case document routes end to end on the test database, through the real auth route and the real
// route handlers of apps/candidate, with memoryStore() as the file store (no S3, no network). Fake people only.
// Measured on 16 November 2026 (warm, 9 calls each, printed below): statements per call and median ms; each budget has room of about 3 to 4 times.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { memoryStore, setFileStore, type MemoryStore } from "../src/file-store";
import { DOCX, JPEG, PDF, PNG } from "../src/file-fixture";
import { MAX_BODY } from "../src/file-check";

// A statement count includes the 2 session statements and the rate-limit statements (write 1, upload 1).
const BUDGET = {
  cvPut: { statements: 7, medianMs: 40 }, // session 2, limits 2, key 1, upsert 1 (measured 6)
  cvGet: { statements: 3, medianMs: 30 },
  cvLink: { statements: 3, medianMs: 30 },
  docPost: { statements: 7, medianMs: 40 }, // session 2, limits 2, case 1, insert 1 (measured 6)
  docList: { statements: 4, medianMs: 30 },
  docLink: { statements: 3, medianMs: 30 },
};
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request, ctx: never) => Promise<Response>; // a route context is { params: Promise<...> }
type Route = Partial<Record<"GET" | "POST" | "PUT" | "DELETE", Handler>>;
let db: TestDb, su: pg.Pool;
let AUTH: (r: Request) => Promise<Response>;
const R = {} as Record<"cv" | "download" | "docs" | "doc" | "export" | "account" | "portalDocs", Route>;
let F: { text(p?: string): Promise<string> };
let store: MemoryStore;
const logged: string[] = [];
const answered: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su);
  for (const k of ["FILES_S3_KEY_ID", "FILES_S3_SECRET", "FILES_S3_BUCKET", "FILES_S3_REGION"]) delete process.env[k];
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret,
    PORTAL_AUTH_URL: "http://localhost:3001", PORTAL_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  const api = "../../../apps/candidate/app/api/candidate";
  R.cv = await import(`${api}/cv/route`);
  R.download = await import(`${api}/cv/download/route`);
  R.docs = await import(`${api}/cases/[id]/documents/route`);
  R.doc = await import(`${api}/cases/[id]/documents/[docId]/route`);
  R.export = await import(`${api}/export/route`);
  R.account = await import(`${api}/account/route`);
  R.portalDocs = await import("../../../apps/portal/app/api/portal/cases/[id]/documents/route");
  store = memoryStore();
  setFileStore(store);
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
});
afterAll(async () => {
  vi.restoreAllMocks();
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
  expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const id = (await su.query("select id from candidate_user where email=$1", [email])).rows[0].id as string;
  return { cookie, id };
}
type P = { cookie?: string };
type Opts = { origin?: string | null; body?: BodyInit; headers?: Record<string, string>; params?: Record<string, string> };
const file = (bytes: Uint8Array, name = "file.pdf", field = "file") => { const f = new FormData(); f.append(field, new Blob([bytes as Uint8Array<ArrayBuffer>]), name); return f; };
async function call(route: Route, method: keyof Route, p: P, o: Opts = {}) {
  const headers: Record<string, string> = { ...(p.cookie ? { cookie: p.cookie } : {}), ...o.headers };
  if (method !== "GET" && o.origin !== null) headers.origin = o.origin ?? BASE;
  const res = await route[method]!(new Request(`${BASE}/api/candidate/x`, { method, headers, body: o.body }), { params: Promise.resolve(o.params ?? {}) } as never);
  const text = await res.text();
  answered.push(text, ...[...res.headers].filter(([k]) => k !== "location").map(([k, v]) => `${k}: ${v}`));
  return { status: res.status, json: text ? JSON.parse(text) : null, code: text ? (JSON.parse(text).code as string | undefined) : undefined, headers: res.headers };
}
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows;
const cvKey = async (id: string) => (await one("select storage_key from candidate_cv where candidate_user_id=$1", [id]))[0]?.storage_key as string | undefined;
async function caseFor(candidate: string, status = "received") {
  const k = (await one("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [candidate, await F.text("services_request")]))[0].id;
  const extra = status === "closed" ? ", closed_at, close_reason" : "";
  const vals = status === "closed" ? ", now(), 'withdrawn'" : "";
  return String((await one(`insert into services_case(candidate_user_id, consent_record_id, status${extra}) values ($1, $2, $3${vals}) returning id`, [candidate, k, status]))[0].id);
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
/** Makes the next query whose text starts with `prefix` fail, as a broken database would. */
function failNextQuery(prefix: string) {
  const q = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) {
    if (typeof a[0] === "string" && a[0].startsWith(prefix)) {
      pg.Client.prototype.query = q;
      const e = Object.assign(new Error("fake database failure"), { code: "XX000" });
      const cb = a.at(-1);
      if (typeof cb === "function") return void process.nextTick(() => cb(e)); // the pool's own call passes a callback
      return Promise.reject(e);
    }
    return (q as (...x: unknown[]) => unknown).apply(this, a);
  } as typeof q;
}

describe("the CV", () => {
  it("none at first; PUT stores the object under a random key, then the row; GET answers the details, never the key", async () => {
    const p = await login();
    expect((await call(R.cv, "GET", p)).status).toBe(404);
    const put = await call(R.cv, "PUT", p, { body: file(PDF, "My CV.pdf") });
    expect(put.status).toBe(200);
    expect(put.json.cv).toMatchObject({ fileName: "My CV.pdf", contentType: "pdf", sizeBytes: PDF.length });
    expect(Object.keys(put.json.cv).sort()).toEqual(["contentType", "fileName", "sizeBytes", "uploadedAt"]);
    const key = (await cvKey(p.id))!;
    expect(key).toMatch(/^cv\/[0-9a-f-]{36}$/);
    expect(store.objects.get(key)).toEqual({ bytes: PDF, contentType: "application/pdf" });
    expect((await call(R.cv, "GET", p)).json).toEqual({ cv: put.json.cv });
  });
  it("a replacement keeps the key, so the object is overwritten, and the row is updated", async () => {
    const p = await login();
    await call(R.cv, "PUT", p, { body: file(PDF, "a.pdf") });
    const key = (await cvKey(p.id))!;
    const before = store.objects.size;
    const put = await call(R.cv, "PUT", p, { body: file(DOCX, "b.docx") });
    expect(put.json.cv).toMatchObject({ fileName: "b.docx", contentType: "docx", sizeBytes: DOCX.length });
    expect(await cvKey(p.id)).toBe(key);
    expect(store.objects.size).toBe(before);
    expect(store.objects.get(key)!.contentType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(Buffer.from(store.objects.get(key)!.bytes).equals(Buffer.from(DOCX))).toBe(true);
    expect((await one("select count(*)::int n from candidate_cv where candidate_user_id=$1", [p.id]))[0].n).toBe(1);
  });
  it("download: a 302 to a 60-second link that downloads under the label, not cached, no referrer", async () => {
    const p = await login();
    await call(R.cv, "PUT", p, { body: file(PDF, "Ó Briain CV.pdf") });
    const r = await call(R.download, "GET", p);
    expect(r.status).toBe(302);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    const u = new URL(r.headers.get("location")!);
    expect(u.pathname).toBe(`/${await cvKey(p.id)}`);
    expect(u.searchParams.get("expires")).toBe("60");
    expect(u.searchParams.get("response-content-disposition")).toBe("attachment; filename*=UTF-8''%C3%93%20Briain%20CV.pdf");
    expect(u.searchParams.get("response-content-type")).toBe("application/pdf");
  });
  it("DELETE removes the row, then the object; after it GET, download and DELETE answer 404", async () => {
    const p = await login();
    await call(R.cv, "PUT", p, { body: file(PDF) });
    const key = (await cvKey(p.id))!;
    expect((await call(R.cv, "DELETE", p)).json).toEqual({ ok: true });
    expect(store.objects.has(key)).toBe(false);
    expect(await cvKey(p.id)).toBeUndefined();
    for (const [route, m] of [[R.cv, "GET"], [R.download, "GET"], [R.cv, "DELETE"]] as const) expect((await call(route, m, p)).code).toBe("CV_NOT_FOUND");
  });
  it("OPS-3: a failed object removal still deletes the row (the CV is gone for the person; the weekly sweep removes the unnamed object)", async () => {
    const p = await login();
    await call(R.cv, "PUT", p, { body: file(PDF) });
    const key = (await cvKey(p.id))!;
    store.failNext();
    expect((await call(R.cv, "DELETE", p)).json).toEqual({ ok: true });
    expect([await cvKey(p.id), store.objects.has(key)]).toEqual([undefined, true]);
  });
  it("OPS-3: a failed row delete leaves both row and object (never a row that points at nothing); storage off is 503 with nothing changed", async () => {
    const p = await login();
    await call(R.cv, "PUT", p, { body: file(PDF) });
    const key = (await cvKey(p.id))!;
    failNextQuery("delete from candidate_cv");
    await expect(call(R.cv, "DELETE", p)).rejects.toThrow(/fake database failure/);
    expect([await cvKey(p.id), store.objects.has(key)]).toEqual([key, true]);
    setFileStore(undefined);
    try { expect((await call(R.cv, "DELETE", p)).code).toBe("FILES_UNAVAILABLE"); } finally { setFileStore(store); }
    expect([await cvKey(p.id), store.objects.has(key)]).toEqual([key, true]);
  });
  it("a failed object write stores no row; a failed first row removes the object it just wrote", async () => {
    const p = await login();
    store.failNext();
    await expect(call(R.cv, "PUT", p, { body: file(PDF) })).rejects.toThrow(/fake failure/);
    expect(await cvKey(p.id)).toBeUndefined();
    const before = new Set(store.objects.keys());
    failNextQuery("insert into candidate_cv");
    await expect(call(R.cv, "PUT", p, { body: file(PDF) })).rejects.toThrow(/fake database failure/);
    expect(await cvKey(p.id)).toBeUndefined();
    expect(new Set(store.objects.keys())).toEqual(before);
  });
  it("PDF or DOCX only, decided by the bytes: an image, an HTML file named .pdf and an empty file are refused", async () => {
    const p = await login();
    expect((await call(R.cv, "PUT", p, { body: file(PNG, "cv.pdf") })).code).toBe("WRONG_FILE_TYPE");
    expect((await call(R.cv, "PUT", p, { body: file(new TextEncoder().encode("<html><script>x</script>"), "cv.pdf") })).status).toBe(415);
    expect((await call(R.cv, "PUT", p, { body: file(new Uint8Array(), "cv.pdf") })).code).toBe("EMPTY_FILE");
    expect(await cvKey(p.id)).toBeUndefined();
  });
  it("the export lists the CV's details and never its key", async () => {
    const p = await login();
    await call(R.cv, "PUT", p, { body: file(PDF, "export.pdf") });
    const r = await R.export.GET!(new Request(`${BASE}/api/candidate/export`, { headers: { cookie: p.cookie } }), undefined as never);
    const text = await r.text();
    expect(JSON.parse(text).cv).toEqual([expect.objectContaining({ fileName: "export.pdf", contentType: "pdf" })]);
    expect(text).not.toContain((await cvKey(p.id))!);
    expect(text).not.toMatch(/storage_?key|"cv\/[0-9a-f-]{36}"/i);
  });
});

// SEC-14 (audit 27 Nov 2026): the owner's own downloads open only once the malware scan tagged the object NO_THREATS_FOUND, as the staff views do.
const TAGS: [string | null, string][] = [[null, "SCAN_PENDING"], ["THREATS_FOUND", "FILE_BLOCKED"], ["UNSUPPORTED", "FILE_BLOCKED"], ["ACCESS_DENIED", "FILE_BLOCKED"],
  ["FAILED", "FILE_BLOCKED"], ["no_threats_found", "FILE_BLOCKED"], [" NO_THREATS_FOUND", "FILE_BLOCKED"], ["", "FILE_BLOCKED"]];
describe("SEC-14: a download waits for the malware scan", () => {
  it("the CV: no tag yet is 409 SCAN_PENDING, any other tag 409 FILE_BLOCKED, and no link is made; NO_THREATS_FOUND opens it", async () => {
    const p = await login();
    await call(R.cv, "PUT", p, { body: file(PDF) });
    const key = (await cvKey(p.id))!;
    for (const [tag, code] of TAGS) {
      store.tags.set(key, tag);
      const r = await call(R.download, "GET", p);
      expect([r.status, r.code, r.headers.get("location")], String(tag)).toEqual([409, code, null]);
    }
    store.tags.set(key, "NO_THREATS_FOUND");
    expect((await call(R.download, "GET", p)).status).toBe(302);
    store.objects.delete(key); // the object is gone from the bucket: no tag to read, so it waits like an unscanned one
    expect((await call(R.download, "GET", p)).code).toBe("SCAN_PENDING");
  });
  it("a case document: the same gate; another candidate still gets DOCUMENT_NOT_FOUND before any scan is read", async () => {
    const p = await login(), q = await login();
    const c = await caseFor(p.id);
    const doc = (await call(R.docs, "POST", p, { body: file(PDF), params: { id: c } })).json.document.id;
    const key = (await one("select storage_key from case_document where id=$1", [doc]))[0].storage_key;
    for (const [tag, code] of TAGS) {
      store.tags.set(key, tag);
      const r = await call(R.doc, "GET", p, { params: { id: c, docId: doc } });
      expect([r.status, r.code, r.headers.get("location")], String(tag)).toEqual([409, code, null]);
    }
    expect((await call(R.doc, "GET", q, { params: { id: c, docId: doc } })).code).toBe("DOCUMENT_NOT_FOUND");
    store.tags.delete(key);
    expect((await call(R.doc, "GET", p, { params: { id: c, docId: doc } })).status).toBe(302);
  });
});

describe("case documents, candidate side", () => {
  it("upload, list and open one's own; the copy goes with retention and then cannot be opened", async () => {
    const p = await login();
    const c = await caseFor(p.id);
    const up = await call(R.docs, "POST", p, { body: file(JPEG, "passport.jpg"), params: { id: c } });
    expect(up.status).toBe(200);
    expect(up.json.document).toMatchObject({ fileName: "passport.jpg", contentType: "jpeg", sizeBytes: JPEG.length, copyDeleted: false });
    const key = (await one("select storage_key from case_document where id=$1", [up.json.document.id]))[0].storage_key;
    expect(key).toMatch(/^case\/[0-9a-f-]{36}$/);
    expect(store.objects.get(key)!.contentType).toBe("image/jpeg");
    await call(R.docs, "POST", p, { body: file(PDF, "offer.pdf"), params: { id: c } });
    const list = await call(R.docs, "GET", p, { params: { id: c } });
    expect(list.json.documents.map((d: { fileName: string }) => d.fileName)).toEqual(["passport.jpg", "offer.pdf"]);
    const link = await call(R.doc, "GET", p, { params: { id: c, docId: up.json.document.id } });
    expect([link.status, link.headers.get("cache-control"), link.headers.get("referrer-policy")]).toEqual([302, "no-store", "no-referrer"]);
    expect(new URL(link.headers.get("location")!).searchParams.get("response-content-type")).toBe("image/jpeg");
    await su.query("update case_document set storage_key=null, file_name=null, copy_deleted_at=now() where id=$1", [up.json.document.id]);
    expect((await call(R.docs, "GET", p, { params: { id: c } })).json.documents[0]).toMatchObject({ id: up.json.document.id, fileName: null, copyDeleted: true });
    expect((await call(R.doc, "GET", p, { params: { id: c, docId: up.json.document.id } })).code).toBe("DOCUMENT_NOT_FOUND");
  });
  it("PDF, JPEG or PNG only (a DOCX is refused); a failed row removes the object it just wrote", async () => {
    const p = await login();
    const c = await caseFor(p.id);
    expect((await call(R.docs, "POST", p, { body: file(DOCX, "a.docx"), params: { id: c } })).code).toBe("WRONG_FILE_TYPE");
    expect((await call(R.docs, "POST", p, { body: file(PNG, "a.png"), params: { id: c } })).status).toBe(200);
    const before = new Set(store.objects.keys());
    failNextQuery("insert into candidate_case_document");
    await expect(call(R.docs, "POST", p, { body: file(PDF), params: { id: c } })).rejects.toThrow(/fake database failure/);
    expect(new Set(store.objects.keys())).toEqual(before);
  });
  it("disarm at upload (S-Q6): active PDFs are refused with nothing stored; images are stored re-encoded; a declared type never counts", async () => {
    const p = await login();
    const c = await caseFor(p.id);
    const before = new Set(store.objects.keys());
    const tail = "\ntrailer << /Root 1 0 R >>\n%%EOF\n";
    for (const bad of [`%PDF-1.7\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj${tail}`, `%PDF-1.7\n1 0 obj << /J#61vaScript 2 0 R >> endobj${tail}`,
      `%PDF-1.7\ntrailer << /Encrypt 3 0 R >>${tail}`]) {
      const r = await call(R.docs, "POST", p, { body: file(new Uint8Array(Buffer.from(bad, "latin1")), "offer.pdf"), params: { id: c } });
      expect([r.status, r.code], bad).toEqual([422, "FILE_ACTIVE_CONTENT"]);
    }
    expect((await call(R.docs, "POST", p, { body: file(new Uint8Array(Buffer.from("%PDF-1.7\n1 0 obj << >>", "latin1"))), params: { id: c } })).code).toBe("WRONG_FILE_TYPE"); // truncated
    expect((await call(R.docs, "POST", p, { body: file(new Uint8Array([...PNG.subarray(0, 8), 1, 2, 3]), "a.png"), params: { id: c } })).code).toBe("WRONG_FILE_TYPE"); // does not decode
    expect(new Set(store.objects.keys())).toEqual(before);
    // a PNG with a script after its end, sent as text/html under an .html name: stored as the re-encoded PNG only
    const f = new FormData();
    f.append("file", new Blob([new Uint8Array([...PNG, ...Buffer.from("<script>alert(1)</script>")])], { type: "text/html" }), "page.html");
    const up = await call(R.docs, "POST", p, { body: f, params: { id: c } });
    expect(up.json.document).toMatchObject({ fileName: "page.html.png", contentType: "png", sizeBytes: PNG.length });
    const key = (await one("select storage_key from case_document where id=$1", [up.json.document.id]))[0].storage_key;
    expect(store.objects.get(key)).toEqual({ bytes: PNG, contentType: "image/png" });
  });
  it("a decided or closed case refuses uploads but still lists and opens", async () => {
    const p = await login();
    for (const status of ["decision", "closed"]) {
      const c = await caseFor(p.id, status);
      expect((await call(R.docs, "POST", p, { body: file(PDF), params: { id: c } })).code).toBe("CASE_CLOSED");
      expect((await call(R.docs, "GET", p, { params: { id: c } })).json).toEqual({ documents: [] });
    }
  });
  it("the 21st stored copy is refused; a copy already deleted does not count", async () => {
    const p = await login();
    const c = await caseFor(p.id);
    await su.query(`insert into case_document(services_case_id, storage_key, file_name, content_type, byte_size, candidate_user_id)
      select $1, 'case/fake-' || g, 'f.pdf', 'pdf', 10, $2 from generate_series(1, 19) g`, [c, p.id]);
    await su.query("insert into case_document(services_case_id, file_name, content_type, byte_size, candidate_user_id, copy_deleted_at) values ($1, null, 'pdf', 10, $2, now())", [c, p.id]);
    expect((await call(R.docs, "POST", p, { body: file(PDF), params: { id: c } })).status).toBe(200); // the 20th
    expect((await call(R.docs, "POST", p, { body: file(PDF), params: { id: c } })).code).toBe("DOCUMENT_LIMIT");
    expect((await one("select count(*)::int n from case_document where services_case_id=$1 and storage_key is not null", [c]))[0].n).toBe(20);
  });
});

describe("security", () => {
  it("every route without a login is 401 and stores nothing", async () => {
    const size = store.objects.size;
    const c = await caseFor((await login()).id);
    for (const [route, m, o] of [[R.cv, "GET", {}], [R.cv, "PUT", { body: file(PDF) }], [R.cv, "DELETE", {}], [R.download, "GET", {}],
      [R.docs, "GET", { params: { id: c } }], [R.docs, "POST", { body: file(PDF), params: { id: c } }], [R.doc, "GET", { params: { id: c, docId: "1" } }]] as const)
      expect((await call(route, m, {}, o)).code).toBe("NO_SESSION");
    expect(store.objects.size).toBe(size);
  });
  it("another candidate's CV, case and document are out of reach (404), and their CV is untouched", async () => {
    const a = await login(), b = await login();
    await call(R.cv, "PUT", a, { body: file(PDF, "a.pdf") });
    const ca = await caseFor(a.id), cb = await caseFor(b.id);
    const doc = (await call(R.docs, "POST", a, { body: file(PDF), params: { id: ca } })).json.document.id;
    expect((await call(R.cv, "GET", b)).code).toBe("CV_NOT_FOUND");
    expect((await call(R.cv, "DELETE", b)).code).toBe("CV_NOT_FOUND");
    expect((await call(R.download, "GET", b)).code).toBe("CV_NOT_FOUND");
    expect(await cvKey(a.id)).toBeDefined();
    expect((await call(R.docs, "GET", b, { params: { id: ca } })).code).toBe("CASE_NOT_FOUND");
    expect((await call(R.docs, "POST", b, { body: file(PDF), params: { id: ca } })).code).toBe("CASE_NOT_FOUND");
    expect((await call(R.doc, "GET", b, { params: { id: ca, docId: doc } })).code).toBe("DOCUMENT_NOT_FOUND");
    expect((await call(R.doc, "GET", b, { params: { id: cb, docId: doc } })).code).toBe("DOCUMENT_NOT_FOUND"); // a's document id under b's own case
    expect((await one("select count(*)::int n from case_document where services_case_id=$1", [ca]))[0].n).toBe(1);
  });
  it("a deleted account is refused on every route, and so is one deleted while its session lives on", async () => {
    const p = await login();
    await call(R.cv, "PUT", p, { body: file(PDF) });
    const c = await caseFor(p.id, "closed");
    const q = await login();
    await su.query("update candidate_user set deleted_at=now() where id=$1", [q.id]); // session row kept: the user check refuses
    for (const [route, m, o] of [[R.cv, "GET", {}], [R.cv, "PUT", { body: file(PDF) }], [R.cv, "DELETE", {}], [R.download, "GET", {}], [R.docs, "POST", { body: file(PDF), params: { id: c } }]] as const)
      expect((await call(route, m, q, o)).code).toBe("REFUSED");
    expect((await call(R.account, "DELETE", p, { body: JSON.stringify({ confirm: true }), headers: { "content-type": "application/json" } })).json).toEqual({ ok: true });
    for (const [route, m, o] of [[R.cv, "GET", {}], [R.cv, "PUT", { body: file(PDF) }], [R.download, "GET", {}], [R.docs, "GET", { params: { id: c } }]] as const)
      expect((await call(route, m, p, o)).status).toBe(401);
  });
  it("a wrong or missing Origin refuses every write before the session is read", async () => {
    const p = await login();
    const c = await caseFor(p.id);
    for (const origin of ["https://evil.example.test", "http://localhost:3001", null]) {
      for (const [route, m, o] of [[R.cv, "PUT", { body: file(PDF) }], [R.cv, "DELETE", {}], [R.docs, "POST", { body: file(PDF), params: { id: c } }]] as const)
        expect((await call(route, m, p, { ...o, origin })).code).toBe("BAD_ORIGIN");
    }
    expect(await cvKey(p.id)).toBeUndefined();
  });
  it("a candidate login on the portal's document routes is 401 (each app reads only its own cookie)", async () => {
    const p = await login();
    const c = await caseFor(p.id);
    for (const [m, o] of [["GET", {}], ["POST", { body: file(PDF), origin: "http://localhost:3001" }]] as const)
      expect((await call(R.portalDocs, m, p, { ...o, params: { id: c } })).code).toBe("NO_SESSION");
  });
  it("hostile input: missing field, two files, wrong field, not multipart, a body over the cap by header or by count, a bad case id", async () => {
    const p = await login();
    const two = file(PDF); two.append("file", new Blob([PDF]), "b.pdf");
    const extra = file(PDF); extra.append("note", "x");
    for (const body of [new FormData(), two, file(PDF, "a.pdf", "cv"), extra])
      expect((await call(R.cv, "PUT", p, { body })).code).toBe("BAD_REQUEST");
    expect((await call(R.cv, "PUT", p, { body: JSON.stringify({ file: "x" }), headers: { "content-type": "application/json" } })).code).toBe("BAD_REQUEST");
    expect((await call(R.cv, "PUT", p, { body: "garbage", headers: { "content-type": "multipart/form-data; boundary=x" } })).code).toBe("BAD_REQUEST");
    expect((await call(R.cv, "PUT", p, { body: file(PDF), headers: { "content-length": String(MAX_BODY + 1) } })).code).toBe("FILE_TOO_LARGE");
    const big = new Uint8Array(MAX_BODY); big.set(PDF);
    expect((await call(R.cv, "PUT", p, { body: file(big) })).status).toBe(413);
    const q = await login(); // a fresh upload limit: every attempt above counted
    const c = await caseFor(q.id);
    for (const id of ["abc", "1; drop table candidate_cv", "-1", "1.5", "99999999999999999999999", ""])
      expect((await call(R.docs, "POST", q, { body: file(PDF), params: { id } })).code, id).toBe("BAD_REQUEST");
    expect((await call(R.doc, "GET", q, { params: { id: c, docId: "x" } })).code).toBe("BAD_REQUEST");
    expect(await cvKey(p.id)).toBeUndefined();
  });
  it("a huge name and a name with ../ and control characters are stored as a clean label", async () => {
    const p = await login();
    expect((await call(R.cv, "PUT", p, { body: file(PDF, `../../${"x".repeat(5000)}\u0000‮.pdf`) })).json.cv.fileName).toBe(`${"x".repeat(196)}.pdf`);
    expect((await call(R.cv, "PUT", p, { body: file(PDF, "..\\..\\secret\r\n.pdf") })).json.cv.fileName).toBe("secret.pdf");
    expect((await call(R.cv, "PUT", p, { body: file(PDF, "page.html") })).json.cv.fileName).toBe("page.html.pdf");
  });
  it("uploads stop at 10 an hour per login", async () => {
    const p = await login();
    for (let i = 0; i < 10; i++) expect((await call(R.cv, "PUT", p, { body: file(PDF) })).status).toBe(200);
    expect((await call(R.cv, "PUT", p, { body: file(PDF) })).code).toBe("TOO_MANY_REQUESTS");
    expect((await call(R.docs, "POST", p, { body: file(PDF), params: { id: await caseFor(p.id) } })).code).toBe("TOO_MANY_REQUESTS");
    expect((await call(R.cv, "DELETE", p)).status).toBe(200); // not an upload
  });
  it("the hour's count survives Better Auth's pruning of rows older than its own 5-minute window", async () => {
    const p = await login();
    for (let i = 0; i < 10; i++) expect((await call(R.cv, "PUT", p, { body: file(PDF) })).status).toBe(200);
    // What better-auth's deleteExpiredRows runs, 6 minutes on: the row stays because last_request holds the window's end
    await su.query("delete from candidate_rate_limit where last_request < $1", [Date.now() + 6 * 60_000 - 5 * 60_000]);
    expect((await call(R.cv, "PUT", p, { body: file(PDF) })).code).toBe("TOO_MANY_REQUESTS");
    // The window's end passed: a new count starts
    await su.query("update candidate_rate_limit set last_request = $1 where key = $2", [Date.now() - 1, `upload:${p.id}`]);
    expect((await call(R.cv, "PUT", p, { body: file(PDF) })).status).toBe(200);
  });
  it("without the FILES_S3_ settings only the file work answers 503; reads that need no file still work", async () => {
    const p = await login();
    await call(R.cv, "PUT", p, { body: file(PDF) });
    setFileStore(undefined);
    try {
      expect((await call(R.cv, "PUT", p, { body: file(PDF) })).code).toBe("FILES_UNAVAILABLE");
      expect((await call(R.download, "GET", p)).status).toBe(503);
      expect((await call(R.cv, "GET", p)).status).toBe(200);
    } finally { setFileStore(store); }
  });
  it("no key appears in any answer (bodies and headers other than the link) or any log line", async () => {
    const keys = [...store.objects.keys()];
    expect(keys.length).toBeGreaterThan(10);
    const all = answered.join("\n") + logged.join("\n");
    for (const k of keys) expect(all).not.toContain(k.slice(k.indexOf("/") + 1));
    expect(logged.join("\n")).not.toMatch(/(cv|case)\/[0-9a-f-]{36}|files\.example\.test/);
  });
});

describe("performance: statements per call and median time (database part)", () => {
  it("stays inside the budgets", async () => {
    const p = await login();
    const c = await caseFor(p.id);
    await call(R.cv, "PUT", p, { body: file(PDF) });
    const doc = (await call(R.docs, "POST", p, { body: file(PDF), params: { id: c } })).json.document.id;
    await su.query("delete from candidate_rate_limit");
    const cases: [keyof typeof BUDGET, () => Promise<unknown>][] = [
      ["cvPut", () => call(R.cv, "PUT", p, { body: file(PDF) })],
      ["cvGet", () => call(R.cv, "GET", p)],
      ["cvLink", () => call(R.download, "GET", p)],
      ["docPost", () => call(R.docs, "POST", p, { body: file(PDF), params: { id: c } })],
      ["docList", () => call(R.docs, "GET", p, { params: { id: c } })],
      ["docLink", () => call(R.doc, "GET", p, { params: { id: c, docId: doc } })],
    ];
    const lines: string[] = [];
    for (const [name, fn] of cases) {
      const times: number[] = [];
      let statements = 0;
      for (let i = 0; i < 9; i++) {
        if (name === "cvPut" || name === "docPost") await su.query("delete from candidate_rate_limit");
        const t0 = performance.now();
        [, statements] = await counted(fn);
        times.push(performance.now() - t0);
      }
      const median = [...times].sort((x, y) => x - y)[4]!;
      lines.push(`${name}: ${statements} statements, median ${median.toFixed(1)} ms`);
      expect(statements, name).toBeLessThanOrEqual(BUDGET[name].statements);
      expect(median, name).toBeLessThan(BUDGET[name].medianMs);
    }
    process.stdout.write(`files-candidate perf: ${lines.join("; ")}\n`);
  });
});
