/* eslint-disable @typescript-eslint/no-explicit-any */
// Step 15 Q2: administrators act on a data request (queue data_request) through the real /api/data-requests handler: GET the open items and the
// pending erasures, POST send_confirm, close, erase_propose, erase_confirm and erase_refuse; the account owner confirms (decision #271) through the
// real /api/data-request handlers of the candidate site (as app_candidate) and the employer site (as app_portal), from the link the real outbox
// sender (outbox-cli.ts sendPending, with a fake mail sender) puts in the email. Real staff sessions, the real test database, 0050's functions;
// stored files go from the fake file store. No network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exportData } from "../src/candidate";
import { DR_CONFIRM_RATE, tokenHash } from "../src/data-request-confirm";
import { memoryStore, setFileStore, type MemoryStore } from "../src/file-store";
import { DR_TOKEN_SET, sendPending } from "../src/outbox-cli";
import { portalExport } from "../src/self-service";
import { DATA_REQUESTS } from "../src/staff-tools";
import { createTestDb, type TestDb } from "./db";
import { fixtures, in30 } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { costOf } from "./perf/pages";
import { counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 180000, hookTimeout: 120000 });

// Statements through the route (requireStaff is 2): list = role check and two reads (5); send_confirm = begin, role check, match, login state,
// detail, outbox, audit, commit (10); propose = begin, role check, proof, insert, audit, commit (8); confirm = begin,
// role check, lock, confirm, erase, commit (8); close = begin, role check, close, commit (6). Medians measured 19 Nov 2026 (four runs, other agents
// running): send_confirm 2.9 to 3.0 ms, propose 2.3 to 3.7 ms, confirm 3.6 to 5.7 ms; limits about 3 times the highest. The owner's site (rate limit,
// then one function; a POST is a transaction, and a candidate's export adds its two export statements): GET 2, POST erase 4, POST candidate
// export 6, POST portal export 4. Among 2,000 other candidates, 2,000 portal logins and 2,000 other messages (planning + execution + serialisation): the list 325
// pages with the 60 or so open items earlier tests left (about 5 pages an item, at most 101 items read, so the limit is for the cap), the match 25 to 28 pages (each email by its unique index), the link lookup 3 pages (by review_item_confirm_hash_unique), an erase
// 2,982 to 3,093 pages and 12 ms (one scan of contact_message for the address); limits about 3 times.
const BUDGET = { list: 5, send: 10, propose: 8, confirm: 8, close: 6, peek: 2, ownerErase: 4, ownerExportCandidate: 6, ownerExportPortal: 4,
  sendMs: 20, proposeMs: 12, confirmMs: 20, listPages: 600, matchPages: 90, peekPages: 15, erasePages: 9500 };
const SITE = { candidate: "https://www.example.test", portal: "https://employers.example.test" } as const; // the outbox's https site addresses
const ORIGIN = { candidate: SITE.candidate, portal: "http://localhost:3001" } as const; // each site's own origin (the portal's fake mail runs on localhost only)
type Side = keyof typeof SITE;

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, su: pg.Pool, store: MemoryStore;
let F: any, ins: any, src: string, org: string, pub: Record<Side, Route>, ip = 1;
const spec = loadSpec("admin");
const PATH = "/api/data-requests";
const call = (who: string | null, body?: unknown, o: Parameters<typeof h.call>[4] = {}) => h.call(route, PATH, who, body, o);
const rows = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows;
const one = async (sql: string, args: unknown[] = []) => (await rows(sql, args))[0];
const emailOf = async (table: "candidate_user" | "portal_user", id: string) => (await one(`select email from ${table} where id = $1`, [id])).email as string;
/** A data request message and its review item (the 0002 trigger makes it). `by` is a signed-in sender, or null for a visitor. */
async function request(email: string, by: { candidate?: string; portal?: string } = {}): Promise<{ item: string; msg: string }> {
  const msg = await ins("postgres", "contact_message", { surface: by.portal ? "portal" : "candidate_site", candidate_user_id: by.candidate ?? null,
    portal_user_id: by.portal ?? null, from_name: "Fake Sender", from_email: email, topic: "data_request", body: "Please act on my data" });
  return { item: (await one("select id::text from review_item where contact_message_id = $1", [msg])).id, msg };
}
const sendConfirm = async (itemId: string, purpose: "export" | "erase", who = "ad1") => {
  const r = await call(who, { action: "send_confirm", itemId, purpose });
  expect(replyProblems(spec, "POST", PATH, r.status, r.json)).toEqual([]);
  return r;
};
/** Runs the real outbox sender once with a fake mail sender: every email it sent, with the token from its link. */
async function mailed(): Promise<{ to: string; subject: string; site: string; token: string }[]> {
  const sent: { to: string; subject: string; site: string; token: string }[] = [];
  await sendPending(db.pool("app_admin"), async (to, subject, text) => {
    const m = /(https:\/\/[^/\s]+)\/api\/data-request\?token=([A-Za-z0-9_-]{43})/.exec(text);
    sent.push({ to, subject, site: m?.[1] ?? "", token: m?.[2] ?? "" });
  }, 200, () => {}, SITE.candidate, SITE.portal);
  return sent;
}
/** One call to the owner's site's /api/data-request, as that site's database login. */
async function site(side: Side, method: "GET" | "POST", token: string, o: { origin?: string | null; query?: string; ip?: string; body?: string } = {}) {
  const g = globalThis as { __portalPool?: pg.Pool }, before = g.__portalPool;
  g.__portalPool = db.pool(side === "candidate" ? "app_candidate" : "app_portal");
  try {
    const headers: Record<string, string> = { "x-vercel-forwarded-for": o.ip ?? `203.0.113.${ip++ % 250}` };
    if (method === "POST" && o.origin !== null) headers.origin = o.origin ?? ORIGIN[side];
    const res = await (method === "GET" ? pub[side].GET : pub[side].POST!)(new Request(`${SITE[side]}/api/data-request${o.query ?? `?token=${token}`}`, { method, headers, body: o.body }));
    return { status: res.status, json: await res.json(), headers: res.headers };
  } finally { g.__portalPool = before; }
}
/** The owner confirms an erase from the emailed link (the whole real path). */
async function proveErase(itemId: string, side: Side, email: string) {
  await sendConfirm(itemId, "erase");
  const m = (await mailed()).find((x) => x.to === email)!;
  expect((await site(side, "POST", m.token)).json).toEqual({ ok: true, purpose: "erase" });
}
const propose = async (itemId: string, who = "ad1") => (await h.ok(call(who, { action: "erase_propose", itemId }))).requestId as string;
const confirm = (requestId: string, who = "ad2") => call(who, { action: "erase_confirm", requestId });
const status = async (id: string) => one("select status, applied_at is not null as used from approval_request where id = $1", [id]);
const item = async (id: string) => one("select status, outcome, candidate_user_id c, portal_user_id p, decided_by_staff_user_id by from review_item where id = $1", [id]);
const exists = async (table: string, id: string) => (await su.query(`select 1 from ${table} where id = $1`, [id])).rowCount === 1;
const job = () => ins("postgres", "job", { organisation_id: org, source: "employer", job_source_id: src, title: "Fake job", employer_name: "Fake Org", sector: "it",
  permit_type: "critical_skills", status: "live", closes_at: in30(), salary_low: 40000, search_vector: "'fake':1", application_route: "own_page", own_page_url: "https://example.test/job" });

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  ({ F, ins } = fixtures(db) as any);
  route = (await import("../../../apps/admin/app/api/data-requests/route")) as unknown as Route;
  Object.assign(process.env, { CANDIDATE_AUTH_URL: SITE.candidate, CANDIDATE_AUTH_SECRET: "trial-only-secret-trial-only-secret-32", PORTAL_AUTH_URL: ORIGIN.portal,
    PORTAL_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  pub = { candidate: (await import("../../../apps/candidate/app/api/data-request/route")) as unknown as Route,
    portal: (await import("../../../apps/portal/app/api/data-request/route")) as unknown as Route };
  store = memoryStore();
  setFileStore(store);
  src = await ins("postgres", "job_source", { kind: "portal", board: "portal" });
  org = await F.org();
  await h.makeStaff("ad1", ["administrator"]);
  await h.makeStaff("ad2", ["administrator"]);
  for (const r of ROLE_NAMES) if (r !== "administrator") await h.makeStaff(`only_${r}`, [r]);
});
afterAll(async () => {
  setFileStore(undefined);
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("the list", () => {
  it("shows the open items, oldest first, with the requester's email, and no closed one", async () => {
    const c = await F.cand();
    const a = await request("Visitor.Fake@Example.Test"), b = await request(await emailOf("candidate_user", c), { candidate: c });
    const r = await call("ad1");
    expect(replyProblems(spec, "GET", PATH, r.status, r.json)).toEqual([]);
    const mine = r.json.items.filter((x: any) => [a.item, b.item].includes(x.itemId));
    expect(mine).toEqual([
      { itemId: a.item, status: "open", createdAt: expect.any(String), surface: "candidate_site", email: "Visitor.Fake@Example.Test", signedIn: false, confirmPurpose: null, confirmSentAt: null, confirmedAt: null },
      { itemId: b.item, status: "open", createdAt: expect.any(String), surface: "candidate_site", email: await emailOf("candidate_user", c), signedIn: true, confirmPurpose: null, confirmSentAt: null, confirmedAt: null },
    ]);
    await h.ok(call("ad1", { action: "close", itemId: a.item }));
    expect((await h.ok(call("ad1"))).items.map((x: any) => x.itemId)).not.toContain(a.item);
  });
});

describe("the owner confirms by email (decision #271): staff never get the data", () => {
  it("a candidate export: the email goes to the login's own address on its own site, GET changes nothing, POST downloads the self-export once", async () => {
    const c = await F.cand(), mail = await emailOf("candidate_user", c);
    await su.query("insert into saved_job(candidate_user_id, job_id) values ($1,$2)", [c, await job()]);
    await su.query("insert into candidate_profile(candidate_user_id, full_name) values ($1,'Fake Person')", [c]);
    const { item: i1 } = await request(mail.toUpperCase()); // a visitor typed the address in capitals
    const r = await sendConfirm(i1, "export");
    expect(r.json).toEqual({ ok: true, kind: "candidate", userId: c, purpose: "export" });
    expect(JSON.stringify(r.json)).not.toContain("Fake Person");
    const listed = (await h.ok(call("ad1"))).items.find((x: any) => x.itemId === i1);
    expect([listed.confirmPurpose, typeof listed.confirmSentAt, listed.confirmedAt]).toEqual(["export", "string", null]);
    const sent = await mailed();
    const m = sent.find((x) => x.to === mail)!;
    expect([m.to, m.site, m.subject]).toEqual([mail, SITE.candidate, "Please confirm your data request"]); // the login's own address, never the typed one
    expect(sent.filter((x) => x.to === mail.toUpperCase())).toEqual([]);
    const d = (await one("select detail from review_item where id = $1", [i1])).detail;
    expect([d.confirmHash, d.sentBy, JSON.stringify(d).includes(m.token)]).toEqual([tokenHash(m.token), h.staff.ad1, false]); // only the hash is kept
    const g = await site("candidate", "GET", m.token);
    expect([g.status, g.json.purpose, typeof g.json.expiresAt]).toEqual([200, "export", "string"]);
    expect((await one("select detail->>'confirmedAt' c from review_item where id = $1", [i1])).c).toBeNull(); // a GET (a mail scanner) confirms nothing
    const p = await site("candidate", "POST", m.token);
    expect([p.status, p.headers.get("content-disposition")]).toEqual([200, expect.stringMatching(/^attachment; filename="my-data-\d{4}-\d{2}-\d{2}\.json"$/)]);
    const own = await exportData(db.pool("app_candidate"), c);
    expect(Object.keys(p.json).sort()).toEqual(Object.keys(own).sort());
    expect([p.json.account.email, p.json.profile.fullName, p.json.savedJobs.length]).toEqual([mail, "Fake Person", 1]);
    expect((await site("candidate", "POST", m.token)).json).toEqual({ code: "INVALID_LINK" }); // once only
    expect((await site("candidate", "GET", m.token)).status).toBe(404);
    expect(await rows("select kind, actor_candidate_user_id a, after from audit_event where action = 'data_request.confirm' and object_id = $1", [i1]))
      .toEqual([{ kind: "security", a: c, after: { purpose: "export" } }]);
    expect(await rows("select actor_staff_user_id a, after from audit_event where action = 'data_request.send_confirm' and object_id = $1", [i1]))
      .toEqual([{ a: h.staff.ad1, after: { purpose: "export", kind: "candidate" } }]);
    expect(await item(i1)).toMatchObject({ status: "open" }); // staff close it when done
  });
  it("a portal login's own signed-in request: the export goes by the same link to the employer site, the same data as its self-export", async () => {
    const p = await F.portal();
    await F.member(org, p, { role: "recruiter" });
    await su.query("insert into portal_session(id, token, user_id, expires_at, updated_at) values ($1, $2, $3, now() + interval '1 day', now())", [`s-${p}`, `tok-${p}`, p]);
    const { item: i1 } = await request(await emailOf("portal_user", p), { portal: p });
    await sendConfirm(i1, "export");
    const pm = await emailOf("portal_user", p), m = (await mailed()).find((x) => x.to === pm)!;
    expect(m.site).toBe(SITE.portal);
    expect((await site("candidate", "POST", m.token)).status).toBe(404); // the candidate site does not take an employer's link
    const r = await site("portal", "POST", m.token);
    const own = await portalExport(db.pool("app_portal"), `tok-${p}`);
    const strip = (x: any) => ({ ...x, exportedAt: null, yourActions: null });
    expect(strip(r.json)).toEqual(strip(JSON.parse(JSON.stringify(own))));
    expect(r.json.memberships).toHaveLength(1);
  });
  it("refused before any email: no account, two logins on the address, a sender naming another login, an unconfirmed address, a deleted login, a closed item", async () => {
    await h.no(call("ad1", { action: "send_confirm", itemId: (await request("nobody.fake@example.test")).item, purpose: "export" }), 409, "no_account");
    const c = await F.cand(), mail = await emailOf("candidate_user", c);
    await F.portal({ email: mail });
    await h.no(call("ad1", { action: "send_confirm", itemId: (await request(mail)).item, purpose: "export" }), 409, "several_accounts");
    const c2 = await F.cand(), c3 = await F.cand();
    await h.no(call("ad1", { action: "send_confirm", itemId: (await request(await emailOf("candidate_user", c3), { candidate: c2 })).item, purpose: "erase" }), 409, "sender_not_account");
    const unv = await F.cand({ verified: false });
    await h.no(call("ad1", { action: "send_confirm", itemId: (await request(await emailOf("candidate_user", unv))).item, purpose: "export" }), 409, "email_not_confirmed");
    const gone = await F.cand({ deleted: new Date() });
    await h.no(call("ad1", { action: "send_confirm", itemId: (await request(await emailOf("candidate_user", gone))).item, purpose: "export" }), 409, "account_deleted");
    const closed = (await request(await emailOf("candidate_user", c2))).item;
    await h.ok(call("ad1", { action: "close", itemId: closed }));
    await h.no(call("ad1", { action: "send_confirm", itemId: closed, purpose: "export" }), 404, "not_found");
    const other = (await one("insert into review_item(queue, job_id) values ('fetched_job', $1) returning id::text", [await job()])).id;
    await h.no(call("ad1", { action: "send_confirm", itemId: other, purpose: "export" }), 404, "not_found");
    expect((await one("select count(*)::int n from email_outbox where template = 'data_request_confirm' and candidate_user_id = any($1)", [[c, c2, c3, unv, gone]])).n).toBe(0);
  });
  it("an impostor's request reaches no erase without the owner's click; the owner's click for an export does not prove an erase", async () => {
    const c = await F.cand(), mail = await emailOf("candidate_user", c);
    const { item: i1 } = await request(mail); // anyone can type this address
    await h.no(call("ad1", { action: "erase_propose", itemId: i1 }), 409, "not_confirmed");
    await sendConfirm(i1, "erase");
    await h.no(call("ad1", { action: "erase_propose", itemId: i1 }), 409, "not_confirmed"); // sent, not yet clicked
    await sendConfirm(i1, "export");
    await site("candidate", "POST", (await mailed()).find((x) => x.to === mail)!.token);
    await h.no(call("ad1", { action: "erase_propose", itemId: i1 }), 409, "not_confirmed");
    expect(await exists("candidate_user", c)).toBe(true);
  });
  it("links: an older one dies when staff send again, an expired one and a closed item's are refused, a token acts only on its own item", async () => {
    const a = await F.cand(), b = await F.cand(), ma = await emailOf("candidate_user", a), mb = await emailOf("candidate_user", b);
    const { item: ia } = await request(ma), { item: ib } = await request(mb);
    await sendConfirm(ia, "erase");
    const first = (await mailed()).find((x) => x.to === ma)!.token;
    await sendConfirm(ia, "erase");
    await sendConfirm(ib, "erase");
    const sent = await mailed();
    const second = sent.find((x) => x.to === ma)!.token, tb = sent.find((x) => x.to === mb)!.token;
    expect((await site("candidate", "POST", first)).status).toBe(404);
    await su.query("update review_item set detail = jsonb_set(detail, '{expiresAt}', to_jsonb(now() - interval '1 second')) where id = $1", [ib]);
    expect((await site("candidate", "POST", tb)).json).toEqual({ code: "INVALID_LINK" });
    expect((await site("candidate", "POST", second)).json).toEqual({ ok: true, purpose: "erase" });
    expect((await one("select detail->>'confirmedAt' c from review_item where id = $1", [ib])).c).toBeNull(); // b's item untouched by a's token
    await h.ok(call("ad1", { action: "close", itemId: ia }));
    expect((await one("select detail from review_item where id = $1", [ia])).detail).toBeNull();
    // a new account on the address after the send: the link no longer names one login
    const { item: ic } = await request(await emailOf("candidate_user", await F.cand()));
    await sendConfirm(ic, "erase");
    const tc = (await mailed()).at(-1)!.token;
    await F.portal({ email: (await one("select m.from_email e from review_item i join contact_message m on m.id = i.contact_message_id where i.id = $1", [ic])).e });
    expect((await site("candidate", "POST", tc)).status).toBe(404);
  });
  it("the outbox drops the email when the item closed or staff sent again before it went", async () => {
    const c = await F.cand(), mail = await emailOf("candidate_user", c);
    const { item: i1 } = await request(mail);
    await sendConfirm(i1, "export");
    await h.ok(call("ad1", { action: "close", itemId: i1 }));
    expect((await mailed()).filter((x) => x.to === mail)).toEqual([]);
    expect((await one("select status from email_outbox where template = 'data_request_confirm' and candidate_user_id = $1", [c])).status).toBe("dropped");
    const c2 = await F.cand(), m2 = await emailOf("candidate_user", c2), { item: i2 } = await request(m2);
    await sendConfirm(i2, "export"); await sendConfirm(i2, "erase");
    expect((await mailed()).filter((x) => x.to === m2)).toHaveLength(1); // only the newer one
    expect(DR_TOKEN_SET).toContain("detail->>'sentAt' = $3");
  });
});

describe("the owner's site: hostile input and limits", () => {
  it("bad links, wrong origin, a body, unknown tokens and the rate limit; the other app roles cannot reach the staff functions", async () => {
    const good = "a".repeat(43);
    for (const q of ["", "?token=short", `?token=${good}&x=1`, `?token=${"a".repeat(42)}%27`, `?token=${good}&token=${good}`]) {
      expect((await site("candidate", "GET", "", { query: q })).json, q).toEqual({ code: "BAD_REQUEST" });
    }
    expect((await site("candidate", "GET", good)).json).toEqual({ code: "INVALID_LINK" });
    expect((await site("portal", "POST", good)).json).toEqual({ code: "INVALID_LINK" });
    expect((await site("candidate", "POST", good, { origin: "https://evil.example" })).json).toEqual({ code: "BAD_ORIGIN" });
    expect((await site("candidate", "POST", good, { origin: null })).json).toEqual({ code: "BAD_ORIGIN" });
    expect((await site("portal", "POST", good, { body: "x".repeat(300) })).json).toEqual({ code: "BODY_TOO_LARGE" });
    let last = 0;
    for (let i = 0; i <= DR_CONFIRM_RATE.max; i++) last = (await site("candidate", "GET", good, { ip: "198.51.100.77" })).status;
    expect(last).toBe(429);
    for (const r of ["app_candidate", "app_portal"] as const) {
      await expect(db.pool(r).query("select private.data_request_proved(1)")).rejects.toThrow(/permission denied/);
      await expect(db.pool(r).query("select private.data_request_live('x', 'candidate')")).rejects.toThrow(/permission denied/);
    }
    for (const r of ["app_admin", "app_fetcher"] as const) await expect(db.pool(r).query("select private.data_request_confirm('x', 'candidate')")).rejects.toThrow(/permission denied/);
  });
});

describe("close", () => {
  it("closes an open item once, with an audit row", async () => {
    const { item: i1 } = await request("close.fake@example.test");
    expect(await h.ok(call("ad1", { action: "close", itemId: i1 }))).toEqual({ ok: true });
    expect(await item(i1)).toEqual({ status: "done", outcome: "answered", c: null, p: null, by: h.staff.ad1 });
    await h.no(call("ad1", { action: "close", itemId: i1 }), 404, "not_found");
    expect(await rows("select actor_staff_user_id a from audit_event where action = 'data_request.close' and object_id = $1", [i1])).toEqual([{ a: h.staff.ad1 }]);
  });
});

describe("erase: two administrators", () => {
  it("a visitor's request for a candidate: the account and its files go, the request message is emptied, the item closes, one audit row", async () => {
    const c = await F.cand();
    await su.query("insert into candidate_cv(candidate_user_id, storage_key, file_name, content_type, size_bytes) values ($1,'cv/erase-me','cv.pdf','pdf',1000)", [c]);
    await store.put("cv/erase-me", new Uint8Array([1]), "application/pdf");
    const { item: i1, msg } = await request(await emailOf("candidate_user", c));
    await proveErase(i1, "candidate", await emailOf("candidate_user", c));
    const p = await call("ad1", { action: "erase_propose", itemId: i1 });
    expect(replyProblems(spec, "POST", PATH, p.status, p.json)).toEqual([]);
    expect(p.json).toEqual({ ok: true, kind: "candidate", userId: c, requestId: expect.any(String) });
    expect((await h.ok(call("ad2"))).pending).toContainEqual({ requestId: p.json.requestId, itemId: i1, kind: "candidate", userId: c, proposedBy: h.staff.ad1, createdAt: expect.any(String) });
    const r = await confirm(p.json.requestId);
    expect(replyProblems(spec, "POST", PATH, r.status, r.json)).toEqual([]);
    expect(r.json).toEqual({ ok: true, kind: "candidate", userId: c, filesRemoved: 1 });
    expect([await exists("candidate_user", c), store.objects.has("cv/erase-me")]).toEqual([false, false]);
    expect(await status(p.json.requestId)).toEqual({ status: "confirmed", used: true });
    expect(await item(i1)).toEqual({ status: "done", outcome: "erased", c: null, p: null, by: h.staff.ad2 });
    expect(await one("select from_name, from_email, body from contact_message where id = $1", [msg])).toEqual({ from_name: null, from_email: null, body: null });
    expect(await rows("select actor_staff_user_id a, second_staff_user_id s, after from audit_event where action = 'data_request.erase' and object_id = $1", [i1]))
      .toEqual([{ a: h.staff.ad2, s: h.staff.ad1, after: { kind: "candidate", request_id: p.json.requestId } }]);
    expect((await one("select count(*)::int n from audit_event where action = 'candidate.erase' and object_id like 'erased-%'")).n).toBeGreaterThan(0);
  });
  it("a signed-in portal login's own request: erased, its item closed", async () => {
    const pu = await F.portal();
    const { item: i1 } = await request(await emailOf("portal_user", pu), { portal: pu });
    expect(await h.ok(confirm(await propose(i1)))).toEqual({ ok: true, kind: "portal", userId: pu, filesRemoved: 0 });
    expect([await exists("portal_user", pu), (await item(i1)).status]).toEqual([false, "done"]);
  });
  it("every visitor message from the address goes and the other data requests for it close; another login's message stays", async () => {
    const c = await F.cand(), mail = await emailOf("candidate_user", c), other = await F.cand();
    const { item: i1 } = await request(mail);
    const { item: i2, msg: m2 } = await request(mail.toUpperCase());
    await proveErase(i1, "candidate", mail);
    const m3 = await ins("postgres", "contact_message", { surface: "candidate_site", from_name: "Fake Sender", from_email: mail, topic: "general", body: "Fake question" });
    const m4 = await ins("postgres", "contact_message", { surface: "candidate_site", candidate_user_id: other, from_name: "Fake Other", from_email: mail, topic: "general", body: "Fake other" });
    const m5 = await ins("postgres", "contact_message", { surface: "candidate_site", from_name: "Fake Else", from_email: "someone.else@example.test", topic: "general", body: "Fake else" });
    await h.ok(confirm(await propose(i1)));
    expect(await rows("select id::text, from_email, body from contact_message where id = any($1) order by id", [[m2, m3, m4, m5]])).toEqual([
      { id: m2, from_email: null, body: null }, { id: m3, from_email: null, body: null }, { id: m4, from_email: mail, body: "Fake other" }, { id: m5, from_email: "someone.else@example.test", body: "Fake else" },
    ]);
    expect(await item(i2)).toEqual({ status: "done", outcome: "subject_erased", c: null, p: null, by: null });
    expect((await h.ok(call("ad1"))).items.map((x: any) => x.itemId)).not.toContain(i2);
  });
  it("the only active owner of an open company: refused close_company_first, the request pending; once the company is closed it goes through", async () => {
    const owner = await F.portal(), org3 = await F.org();
    await F.member(org3, owner, { role: "account_owner", signer: true });
    const { item: i1 } = await request(await emailOf("portal_user", owner), { portal: owner });
    const req = await propose(i1);
    await h.no(confirm(req), 409, "close_company_first");
    expect([await status(req), await exists("portal_user", owner), (await one("select status from membership where portal_user_id = $1", [owner])).status]).toEqual([{ status: "pending", used: false }, true, "active"]);
    await su.query("update organisation set status = 'closed' where id = $1", [org3]);
    await h.ok(confirm(req));
    expect(await exists("portal_user", owner)).toBe(false);
  });
  it("refused at confirm, everything left as it was and the request pending: open case, open report, owner with members, item closed, match changed", async () => {
    const consent = async (c: string) => ins("postgres", "consent_record", { candidate_user_id: c, consent_text_id: await F.text("services_request") });
    const c1 = await F.cand();
    const { item: i1 } = await request(await emailOf("candidate_user", c1), { candidate: c1 });
    const sc = await ins("postgres", "services_case", { candidate_user_id: c1, consent_record_id: await consent(c1) });
    const r1 = await propose(i1);
    await h.no(confirm(r1), 409, "open_services_case");
    expect([await status(r1), await exists("candidate_user", c1), (await item(i1)).status]).toEqual([{ status: "pending", used: false }, true, "open"]);
    await su.query("update services_case set status = 'closed', closed_at = now(), close_reason = 'decided' where id = $1", [sc]);
    await h.ok(confirm(r1)); // closed: it goes through

    const c2 = await F.cand();
    const { item: i2 } = await request(await emailOf("candidate_user", c2), { candidate: c2 });
    await su.query("insert into report(target_kind, target_candidate_user_id, reason) values ('profile',$1,'other')", [c2]);
    const r2 = await propose(i2);
    await h.no(confirm(r2), 409, "open_report");
    expect([await status(r2), await exists("candidate_user", c2)]).toEqual([{ status: "pending", used: false }, true]);

    const owner = await F.portal(), org2 = await F.org();
    await F.member(org2, owner, { role: "account_owner", signer: true }); await F.member(org2, await F.portal());
    const r3 = await propose((await request(await emailOf("portal_user", owner), { portal: owner })).item);
    await h.no(confirm(r3), 409, "owner_with_members");
    expect(await exists("portal_user", owner)).toBe(true);

    const c4 = await F.cand();
    const { item: i4 } = await request(await emailOf("candidate_user", c4), { candidate: c4 });
    const r4 = await propose(i4);
    await h.ok(call("ad1", { action: "close", itemId: i4 }));
    await h.no(confirm(r4), 409, "not_open");

    const c5 = await F.cand();
    const { item: i5 } = await request(await emailOf("candidate_user", c5), { candidate: c5 });
    const r5 = await propose(i5);
    await F.portal({ email: await emailOf("candidate_user", c5) });
    await h.no(confirm(r5), 409, "several_accounts");
    expect([await status(r5), await exists("candidate_user", c5)]).toEqual([{ status: "pending", used: false }, true]);
  });
  it("the proposer cannot confirm; one pending erase per item; withdraw by the proposer, refuse by another; an ended request cannot be confirmed", async () => {
    const c = await F.cand();
    const { item: i1 } = await request(await emailOf("candidate_user", c), { candidate: c });
    const req = await propose(i1);
    await h.no(confirm(req, "ad1"), 409, "same_person");
    await h.no(call("ad2", { action: "erase_propose", itemId: i1 }), 409, "decision_pending");
    await h.ok(call("ad1", { action: "erase_refuse", requestId: req }));
    expect(await status(req)).toEqual({ status: "withdrawn", used: false });
    await h.no(confirm(req), 409, "request_not_pending");
    const req2 = await propose(i1);
    await h.ok(call("ad2", { action: "erase_refuse", requestId: req2 }));
    expect(await status(req2)).toEqual({ status: "refused", used: false });
    expect(await exists("candidate_user", c)).toBe(true);
    expect(await rows("select action, actor_staff_user_id a, second_staff_user_id s from audit_event where action like 'data_request_erase.%' and object_id = $1 order by id", [i1])).toEqual([
      { action: "data_request_erase.propose", a: h.staff.ad1, s: null }, { action: "data_request_erase.withdraw", a: h.staff.ad1, s: null },
      { action: "data_request_erase.propose", a: h.staff.ad1, s: null }, { action: "data_request_erase.refuse", a: h.staff.ad2, s: h.staff.ad1 },
    ]);
  });
  it("the database itself: no erase without a confirmed request, the other app roles cannot call it, a request works once", async () => {
    const c = await F.cand();
    const req = await propose((await request(await emailOf("candidate_user", c), { candidate: c })).item);
    const admin = db.pool("app_admin");
    await expect(admin.query("select private.data_request_erase($1::bigint)", [req])).rejects.toThrow(/two-person rule: request \d+ is pending/);
    for (const r of ["app_candidate", "app_portal", "app_fetcher"] as const) {
      await expect(db.pool(r).query("select private.data_request_erase($1::bigint)", [req])).rejects.toThrow(/permission denied/);
      await expect(db.pool(r).query("select private.data_request_account(1)")).rejects.toThrow(/permission denied/);
      await expect(db.pool(r).query("select private.portal_user_data('x')")).rejects.toThrow(/permission denied/);
    }
    await h.ok(confirm(req));
    const c2 = await admin.connect();
    try {
      await c2.query("begin");
      await c2.query("select set_config('app.staff_user_id', $1, true)", [h.staff.ad2]);
      await expect(c2.query("select private.data_request_erase($1::bigint)", [req])).rejects.toThrow(/was already used/);
    } finally { await c2.query("rollback"); c2.release(); }
  });
});

describe("security: roles, sessions, origin", () => {
  it("every other staff role is refused on the list and each action; signed out and a forged cookie are refused; a foreign origin is refused", async () => {
    const c = await F.cand();
    const { item: i1 } = await request(await emailOf("candidate_user", c), { candidate: c });
    const req = await propose(i1);
    for (const r of ROLE_NAMES) if (r !== "administrator") {
      const who = `only_${r}`;
      await h.no(call(who), 403, "not_administrator");
      for (const body of [{ action: "send_confirm", itemId: i1, purpose: "export" }, { action: "close", itemId: i1 }, { action: "erase_propose", itemId: i1 },
        { action: "erase_confirm", requestId: req }, { action: "erase_refuse", requestId: req }]) await h.no(call(who, body), 403, "not_administrator");
    }
    await h.no(call(null), 401, "no_session");
    await h.no(call(null, { action: "send_confirm", itemId: i1, purpose: "export" }), 401, "no_session");
    await h.no(call(null, { action: "export", itemId: i1 }, { cookie: "better-auth.session_token=forged" }), 401, "no_session");
    await h.no(call("ad2", { action: "erase_confirm", requestId: req }, { origin: "https://evil.example" }), 403, "bad_origin");
    await h.no(call("ad2", { action: "send_confirm", itemId: i1, purpose: "export" }, { origin: null }), 403, "bad_origin");
    expect([await status(req), await exists("candidate_user", c), (await item(i1)).status]).toEqual([{ status: "pending", used: false }, true, "open"]);
    expect((await one("select count(*)::int n from email_outbox where template = 'data_request_confirm' and candidate_user_id = $1", [c])).n).toBe(0);
  });
  it("hostile input: bad ids, wrong types, extra fields, unknown actions, long bodies, query keys", async () => {
    const bad: [unknown, number, string][] = [
      [{ action: "send_confirm", itemId: "1; drop table job", purpose: "export" }, 400, "bad_item_id"],
      [{ action: "send_confirm", itemId: 7, purpose: "export" }, 400, "bad_item_id"],
      [{ action: "send_confirm", itemId: "9".repeat(30), purpose: "export" }, 400, "bad_item_id"],
      [{ action: "send_confirm", purpose: "export" }, 400, "bad_item_id"],
      [{ action: "send_confirm", itemId: "1" }, 400, "bad_purpose"],
      [{ action: "send_confirm", itemId: "1", purpose: "everything" }, 400, "bad_purpose"],
      [{ action: "send_confirm", itemId: "1", purpose: ["erase"] }, 400, "bad_purpose"],
      [{ action: "export", itemId: "1" }, 400, "bad_action"], // staff have no export
      [{ action: "send_confirm", itemId: "99999999", purpose: "erase" }, 404, "not_found"],
      [{ action: "close", itemId: "99999999" }, 404, "not_found"],
      [{ action: "erase_propose", itemId: "99999999" }, 404, "not_found"],
      [{ action: "erase_confirm", requestId: "x' or '1'='1" }, 400, "bad_request_id"],
      [{ action: "erase_confirm", requestId: "99999999" }, 404, "not_found"],
      [{ action: "erase_refuse", requestId: ["1"] }, 400, "bad_request_id"],
      [{ action: "send_confirm", itemId: "1", purpose: "export", email: "x@example.test" }, 400, "bad_body"],
      [{ action: "erase_everything", itemId: "1" }, 400, "bad_action"],
      [["send_confirm"], 400, "bad_body"],
    ];
    for (const [body, st, error] of bad) await h.no(call("ad1", body), st, error);
    await h.no(call("ad1", undefined, { raw: "{not json" }), 400, "bad_body");
    await h.no(call("ad1", undefined, { raw: JSON.stringify({ action: "close", itemId: "1", pad: "x".repeat(300) }) }), 400, "bad_body");
    await h.no(call("ad1", { action: "close", itemId: "1" }, { length: "100000" }), 400, "bad_body");
    await h.no(call("ad1", undefined, { query: "?id=1" }), 400, "bad_query");
    // a request of another kind is not an erase request
    const c = await su.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.staff_user_id', $1, true)", [h.staff.ad1]);
      const other = (await c.query("insert into approval_request(kind, target_table, target_id) values ('setting','setting','dr-x') returning id::text")).rows[0].id;
      await c.query("commit");
      await h.no(confirm(other), 404, "not_found");
    } finally { c.release(); }
  });
});

describe("performance", () => {
  it("statements and median times inside budget", async () => {
    const cands: string[] = [], items: string[] = [];
    for (let i = 0; i < 14; i++) { const c = await F.cand(); cands.push(c); items.push((await request(await emailOf("candidate_user", c), { candidate: c })).item); }
    const pu = await F.portal(), pm = await emailOf("portal_user", pu), pItem = (await request(pm)).item;
    const [, l] = await counted(() => h.ok(call("ad1")));
    const [, sd] = await counted(() => sendConfirm(items[0]!, "erase"));
    const [req0, p] = await counted(() => propose(items[0]!));
    const [, cf] = await counted(() => h.ok(confirm(req0)));
    // the owner's site: a GET, an erase confirm, a candidate export and a portal export
    await sendConfirm(items[1]!, "erase"); await sendConfirm(items[2]!, "export"); await sendConfirm(pItem, "export");
    const sent = await mailed(), tok = async (c: string) => { const e = await emailOf("candidate_user", c); return sent.find((x) => x.to === e)!.token; };
    const tErase = await tok(cands[1]!), tExport = await tok(cands[2]!), tPortal = sent.find((x) => x.to === pm)!.token;
    const [, gk] = await counted(() => site("candidate", "GET", tErase));
    const [, oe] = await counted(() => site("candidate", "POST", tErase));
    const [, oc] = await counted(() => site("candidate", "POST", tExport));
    const [, op] = await counted(() => site("portal", "POST", tPortal));
    const [, cl] = await counted(() => h.ok(call("ad1", { action: "close", itemId: pItem })));
    expect([l, sd, p, cf, cl, gk, oe, oc, op]).toEqual([BUDGET.list, BUDGET.send, BUDGET.propose, BUDGET.confirm, BUDGET.close, BUDGET.peek, BUDGET.ownerErase, BUDGET.ownerExportCandidate, BUDGET.ownerExportPortal]);
    const sm = await median((i) => sendConfirm(items[i + 3]!, "export"));
    const reqs: string[] = [];
    const prm = await median(async (i) => reqs.push(await propose(items[i + 3]!))); // signed-in senders: proved
    const cm = await median((i) => h.ok(confirm(reqs[i]!)));
    console.log(`data requests: ${l} statements (list), ${sd} (send), ${p} (propose), ${cf} (confirm), ${cl} (close); owner's site ${gk} (GET), ${oe} (erase), ` +
      `${oc} (candidate export), ${op} (portal export); median ${sm.toFixed(1)} ms send, ${prm.toFixed(1)} ms propose, ${cm.toFixed(1)} ms confirm`);
    expect(sm).toBeLessThanOrEqual(BUDGET.sendMs);
    expect(prm).toBeLessThanOrEqual(BUDGET.proposeMs);
    expect(cm).toBeLessThanOrEqual(BUDGET.confirmMs);
  });
  it("pages of the list, the match, the link lookup and an erase among 2,000 other people, items and messages", async () => {
    await su.query("insert into candidate_user(id, name, email, email_verified, created_at, updated_at) select 'dr-bulk-' || g, 'Fake', 'dr-bulk-' || g || '@example.test', true, now(), now() from generate_series(1, 2000) g");
    await su.query("insert into portal_user(id, name, email, email_verified, created_at, updated_at) select 'dr-pbulk-' || g, 'Fake', 'dr-pbulk-' || g || '@example.test', true, now(), now() from generate_series(1, 2000) g");
    await su.query("insert into contact_message(surface, from_name, from_email, topic, body) select 'candidate_site', 'Fake', 'dr-other-' || g || '@example.test', 'general', 'Fake' from generate_series(1, 2000) g");
    // 2,000 other data requests with live links (closed, so the list stays short; the link index covers every status)
    await su.query(`with m as (insert into contact_message(surface, from_name, from_email, topic, body) select 'candidate_site', 'Fake', 'dr-req-' || g || '@example.test', 'data_request', 'Fake' from generate_series(1, 2000) g returning id)
      update review_item set detail = jsonb_build_object('purpose', 'export', 'kind', 'candidate', 'userId', 'x', 'confirmHash', md5(contact_message_id::text), 'expiresAt', now() + interval '7 days')
      where contact_message_id in (select id from m)`);
    await su.query("update review_item set status = 'dropped' where queue = 'data_request' and detail->>'userId' = 'x'");
    await su.query("vacuum analyze"); // as autovacuum would after a bulk change
    const target = (await request("dr-bulk-1000@example.test")).item;
    await sendConfirm(target, "erase");
    const token = (await mailed()).find((x) => x.to === "dr-bulk-1000@example.test")!.token;
    const measure = async (role: "app_admin" | "app_candidate", sql: string, args: unknown[] = [], rollback = false) => {
      const c = await db.pool(role).connect();
      try {
        const run = async () => {
          if (rollback) await c.query("begin");
          try { return (await c.query(`explain (analyze, buffers, serialize, format json) ${sql}`, args)).rows[0]["QUERY PLAN"]; } finally { if (rollback) await c.query("rollback"); }
        };
        await run(); // warm
        return costOf(sql, await run());
      } finally { c.release(); }
    };
    const list = await measure("app_admin", DATA_REQUESTS), match = await measure("app_admin", "select private.data_request_account($1::bigint)", [target]);
    for (const t of ["candidate_user", "portal_user"]) expect((await measure("app_admin", `select id from ${t} where email = lower($1)`, ["x@example.test"])).scans).toBe(`${t}_email_key`);
    expect((await measure("app_admin", "select id from review_item where queue = 'data_request' and detail->>'confirmHash' = $1", [tokenHash(token)])).scans).toBe("review_item_confirm_hash_unique");
    const peek = await measure("app_candidate", "select private.data_request_peek($1, 'candidate')", [tokenHash(token)]);
    expect((await site("candidate", "POST", token)).json).toEqual({ ok: true, purpose: "erase" });
    const req = await propose(target);
    const c = await db.pool("app_admin").connect();
    let erase;
    try {
      await c.query("begin");
      await c.query("select set_config('app.staff_user_id', $1, true)", [h.staff.ad2]);
      await c.query("update approval_request set status = 'confirmed' where id = $1", [req]);
      erase = costOf("data_request_erase", (await c.query("explain (analyze, buffers, format json) select private.data_request_erase($1::bigint)", [req])).rows[0]["QUERY PLAN"]);
    } finally { await c.query("rollback"); c.release(); }
    console.log(`data requests: list ${list.pages} pages (${list.scans}), match ${match.pages}, link ${peek.pages}, erase ${erase.pages} pages ${erase.ms} ms`);
    expect(list.pages).toBeLessThanOrEqual(BUDGET.listPages);
    expect(match.pages).toBeLessThanOrEqual(BUDGET.matchPages);
    expect(peek.pages).toBeLessThanOrEqual(BUDGET.peekPages);
    expect(erase.pages).toBeLessThanOrEqual(BUDGET.erasePages);
  });
});
