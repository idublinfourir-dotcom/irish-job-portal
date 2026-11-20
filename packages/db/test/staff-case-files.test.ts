// Integration: M4, the staff view of a services case's stored copies, through the real admin route handlers, real staff sessions and the real test
// database as app_admin, with memoryStore() as the file store (no network). Every staff role, signed out, an unassigned handler, a handler whose
// email is the requester's, the scan gate, cross-case ids, hostile ids and the response headers. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { memoryStore, setFileStore, type MemoryStore } from "../src/file-store";
import { JPEG, PDF, PNG } from "../src/file-fixture";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { BASE, counted, median, ROLE_NAMES, staffHarness } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

type R = { GET(r: Request, ctx: { params: Promise<Record<string, string>> }): Promise<Response> };
let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool, store: MemoryStore, list: R, open: R;
let F: { cand(): Promise<string>; portal(o?: { email?: string }): Promise<string>; text(p: string): Promise<string> };

beforeAll(async () => {
  db = await createTestDb();
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  h = await staffHarness(db);
  su = h.su;
  list = await import("../../../apps/admin/app/api/services/cases/[id]/documents/route") as unknown as R;
  open = await import("../../../apps/admin/app/api/services/cases/[id]/documents/[docId]/route") as unknown as R;
  for (const r of ROLE_NAMES) await h.makeStaff(r, [r]);
  for (const n of ["handler2", "ownc", "ownp"]) await h.makeStaff(n, ["services_case_handler"]);
  await h.makeStaff("handler_admin", ["services_case_handler", "administrator"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["services_case_handler"]);
  store = memoryStore();
  setFileStore(store);
});
afterAll(async () => {
  setFileStore(undefined);
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

async function get(route: R, who: string | null, params: Record<string, string>, query = "") {
  const res = await route.GET(new Request(`${BASE}/api/services/cases/x${query}`, { headers: who ? { cookie: h.signedIn(who) } : {} }), { params: Promise.resolve(params) });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const json = /json/.test(res.headers.get("content-type") ?? "") ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  return { status: res.status, json, bytes, headers: res.headers };
}
const one = async (sql: string, a: unknown[] = []) => (await su.query(sql, a)).rows[0];
const audits = async (doc: string) => (await su.query(
  "select kind, actor_staff_user_id, role_in_force, action, object_type, object_id, reason_code, related_case, after from audit_event where object_type = 'case_document' and object_id = $1 order by id", [doc])).rows;

let k = 0;
/** A case (candidate or portal side) assigned to `handler`, with a candidate PDF, a portal PNG, a staff JPEG and a removed copy. */
async function caseWith(handler: string | null, o: { side?: "candidate" | "portal"; email?: string } = {}) {
  const side = o.side ?? "candidate";
  const who = side === "candidate" ? await F.cand() : await F.portal();
  if (o.email) await su.query(`update ${side}_user set email = $2 where id = $1`, [who, o.email]);
  const consent = (await one(`insert into consent_record(${side}_user_id, consent_text_id) values ($1, $2) returning id`, [who, await F.text("services_request")])).id;
  const c = (await one(`insert into services_case(${side}_user_id, consent_record_id, assigned_staff_user_id${side === "portal" ? ", dedupe_key" : ""}) values ($1, $2, $3${side === "portal" ? ", $4" : ""}) returning id::text as id`,
    side === "portal" ? [who, consent, handler && h.staff[handler], `fake-${++k}`] : [who, consent, handler && h.staff[handler]])).id as string;
  const docs: string[] = [];
  for (const [bytes, kind, name, col, by] of [[PDF, "pdf", "offer.pdf", `${side}_user_id`, who], [PNG, "png", "passport.png", null, null], [JPEG, "jpeg", "scan.jpg", "staff_user_id", h.staff.services_case_handler]] as const) {
    const key = `case/fake-${c}-${docs.length}`;
    store.objects.set(key, { bytes, contentType: "text/html" }); // the store's type is never used
    docs.push((await one(`insert into case_document(services_case_id, storage_key, file_name, content_type, byte_size${col ? `, ${col}` : ""}) values ($1, $2, $3, $4, $5${col ? ", $6" : ""}) returning id::text as id`,
      col ? [c, key, name, kind, bytes.length, by] : [c, key, name, kind, bytes.length])).id);
  }
  docs.push((await one("insert into case_document(services_case_id, content_type, byte_size, copy_deleted_at) values ($1, 'pdf', 10, now()) returning id::text as id", [c])).id);
  return { c, docs, who };
}

describe("M4: the assigned services case handler", () => {
  it("lists every copy (metadata only, no audit row) and opens each: the file itself, fixed headers, one data_access row with the case", async () => {
    const { c, docs } = await caseWith("services_case_handler");
    const l = await get(list, "services_case_handler", { id: c });
    expect(l.status).toBe(200);
    expect(replyProblems(loadSpec("admin"), "GET", "/api/services/cases/{id}/documents", 200, l.json)).toEqual([]);
    expect(l.json.documents.map((d: Record<string, unknown>) => [d.id, d.fileName, d.contentType, d.uploadedBy, d.copyDeleted])).toEqual([
      [docs[0], "offer.pdf", "pdf", "candidate", false], [docs[1], "passport.png", "png", "gone", false], [docs[2], "scan.jpg", "jpeg", "staff", false], [docs[3], null, "pdf", "gone", true]]);
    expect(await audits(docs[0]!)).toEqual([]);
    for (const [i, type, name, bytes] of [[0, "application/pdf", "offer.pdf", PDF], [1, "image/png", "passport.png", PNG], [2, "image/jpeg", "scan.jpg", JPEG]] as const) {
      const r = await get(open, "services_case_handler", { id: c, docId: docs[i]! });
      expect([r.status, r.headers.get("content-type"), r.headers.get("content-disposition"), r.headers.get("x-content-type-options"), r.headers.get("cache-control"),
        r.headers.get("content-security-policy"), r.headers.get("content-length"), r.headers.get("location")])
        .toEqual([200, type, `inline; filename*=UTF-8''${name}`, "nosniff", "no-store", "frame-ancestors 'self'", String(bytes.length), null]);
      expect(r.bytes).toEqual(bytes);
      expect(await audits(docs[i]!)).toEqual([{ kind: "data_access", actor_staff_user_id: h.staff.services_case_handler, role_in_force: "services_case_handler", action: "case_document.open",
        object_type: "case_document", object_id: docs[i], reason_code: "services_case", related_case: `services_case:${c}`, after: null }]);
    }
    expect((await get(open, "services_case_handler", { id: c, docId: docs[3]! })).json).toEqual({ error: "document_not_found" }); // a removed copy
    // a handler who is also an administrator works as the handler when assigned
    const b = await caseWith("handler_admin", { side: "portal" });
    expect((await get(open, "handler_admin", { id: b.c, docId: b.docs[0]! })).status).toBe(200);
    expect((await get(list, "handler_admin", { id: b.c })).json.documents[0].uploadedBy).toBe("portal");
  });

  it("security: every other role (administrator included), no role, disabled, signed out, an unassigned handler and the requester's own email are refused; no audit row", async () => {
    const { c, docs } = await caseWith("services_case_handler");
    const both = async (who: string | null) => [await get(list, who, { id: c }), await get(open, who, { id: c, docId: docs[0]! })];
    for (const r of [...ROLE_NAMES.filter((x) => x !== "services_case_handler"), "norole"])
      for (const x of await both(r)) expect([x.status, x.json], r).toEqual([403, { error: "not_case_handler" }]);
    await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
    for (const x of await both("disabled")) expect([x.status, x.json]).toEqual([401, { error: "not_active" }]);
    for (const x of await both(null)) expect([x.status, x.json]).toEqual([401, { error: "no_session" }]);
    for (const x of await both("handler2")) expect([x.status, x.json]).toEqual([404, { error: "case_not_found" }]); // assigned to someone else
    const none = await caseWith(null);
    expect((await get(list, "services_case_handler", { id: none.c })).json).toEqual({ error: "case_not_found" }); // assigned to no one
    // a handler whose staff email is the requester's account email (20c:231), on each side, even when assigned
    const ownc = await caseWith("ownc", { email: "OWNC@example.test" });
    const ownp = await caseWith("ownp", { side: "portal", email: "ownp@example.test" });
    for (const [who, x] of [["ownc", ownc], ["ownp", ownp]] as const) {
      expect((await get(list, who, { id: x.c })).json).toEqual({ error: "own_case" });
      expect((await get(open, who, { id: x.c, docId: x.docs[0]! })).json).toEqual({ error: "own_case" });
    }
    for (const d of [...docs, ...ownc.docs, ...ownp.docs]) expect(await audits(d)).toEqual([]);
  });

  it("the scan gate: pending (no tag, a missing object), blocked (every other tag) is 409 with no audit row; the file opens only on NO_THREATS_FOUND", async () => {
    const { c, docs } = await caseWith("services_case_handler");
    const key = `case/fake-${c}-0`;
    for (const [tag, code] of [[null, "scan_pending"], ["THREATS_FOUND", "file_blocked"], ["UNSUPPORTED", "file_blocked"], ["ACCESS_DENIED", "file_blocked"], ["FAILED", "file_blocked"], ["weird", "file_blocked"]] as const) {
      store.tags.set(key, tag);
      expect(await get(open, "services_case_handler", { id: c, docId: docs[0]! }).then((r) => [r.status, r.json]), String(tag)).toEqual([409, { error: code }]);
    }
    store.tags.delete(key);
    store.scanDefault = null; // the scan not switched on yet: every file is pending (fails closed)
    try { expect((await get(open, "services_case_handler", { id: c, docId: docs[1]! })).json).toEqual({ error: "scan_pending" }); } finally { store.scanDefault = "NO_THREATS_FOUND"; }
    const keep = store.objects.get(key)!;
    store.objects.delete(key);
    expect((await get(open, "services_case_handler", { id: c, docId: docs[0]! })).json).toEqual({ error: "scan_pending" });
    store.objects.set(key, keep);
    expect(await audits(docs[0]!)).toEqual([]);
    expect(await audits(docs[1]!)).toEqual([]);
    expect((await get(open, "services_case_handler", { id: c, docId: docs[0]! })).status).toBe(200);
  });

  it("hostile input: a real document id under the wrong case, bad ids, any query; a PDF and HTML polyglot is only ever served as a PDF", async () => {
    const a = await caseWith("services_case_handler"), b = await caseWith("services_case_handler");
    expect((await get(open, "services_case_handler", { id: a.c, docId: b.docs[0]! })).json).toEqual({ error: "document_not_found" }); // no cross-case read
    expect((await get(list, "services_case_handler", { id: "999999999" })).json).toEqual({ error: "case_not_found" });
    for (const id of ["0", "x", "-1", "01", "9223372036854775808", "1;drop table case_document", "'%00", "1\u0000", "1".repeat(5000)]) {
      expect((await get(list, "services_case_handler", { id })).json, id).toEqual({ error: "bad_id" });
      expect((await get(open, "services_case_handler", { id, docId: a.docs[0]! })).json, id).toEqual({ error: "bad_id" });
      expect((await get(open, "services_case_handler", { id: a.c, docId: id })).json, id).toEqual({ error: "bad_id" });
    }
    for (const q of ["?x=1", "?docId=1", "?id=1&id=2"]) expect((await get(list, "services_case_handler", { id: a.c }, q)).json, q).toEqual({ error: "bad_query" });
    const poly = new Uint8Array(Buffer.from("%PDF-1.7\n% <html><script>alert(1)</script></html>\ntrailer << >>\n%%EOF\n", "latin1"));
    store.objects.set(`case/fake-${a.c}-0`, { bytes: poly, contentType: "text/html" });
    const r = await get(open, "services_case_handler", { id: a.c, docId: a.docs[0]! });
    expect([r.status, r.headers.get("content-type"), r.headers.get("x-content-type-options")]).toEqual([200, "application/pdf", "nosniff"]);
    expect(await audits(b.docs[0]!)).toEqual([]);
  });

  it("budget: the open of a 4 MiB file through the route (statements, time, bytes) and the list", async () => {
    const { c, docs } = await caseWith("services_case_handler");
    const big = new Uint8Array(4 * 1024 * 1024).fill(0x41);
    store.objects.set(`case/fake-${c}-0`, { bytes: big, contentType: "application/pdf" });
    const [r, openN] = await counted(() => get(open, "services_case_handler", { id: c, docId: docs[0]! }));
    expect(r.bytes.length).toBe(4 * 1024 * 1024);
    expect(Number(r.headers.get("content-length"))).toBeLessThan(4.5e6); // under Vercel's 4.5 MB response limit
    const [, listN] = await counted(() => get(list, "services_case_handler", { id: c }));
    // requireStaff 2, then begin, roles, case, (one, audit for the open | list), commit. Times measured 20 Nov 2026: open 10.7 ms, list 3.0 ms;
    // the limits are about 5 times those, with a 20 ms floor for a busy laptop.
    expect([openN, listN]).toEqual([8, 7]);
    const openMs = await median(() => get(open, "services_case_handler", { id: c, docId: docs[0]! })), listMs = await median(() => get(list, "services_case_handler", { id: c }));
    process.stdout.write(`staff case files: open 4 MiB ${openMs.toFixed(1)} ms, list ${listMs.toFixed(1)} ms\n`);
    expect(openMs).toBeLessThan(60);
    expect(listMs).toBeLessThan(20);
  });
});
