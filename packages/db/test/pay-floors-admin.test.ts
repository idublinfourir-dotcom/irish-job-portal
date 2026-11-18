// Integration: the pay floor check queue from the admin app (step 9, part 12b) on the real test database, through the real /api/pay-floors handlers with real
// staff sessions (sign-in through the real auth route), connected as app_admin. A rules data editor proposes, an administrator who did not propose confirms.
// Companies, members and floors are written as postgres (every CHECK, foreign key and trigger still fires). No network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedStaff } from "../src/staff-seed-cli";
import { FLOOR_FIRST, withdrawPayFloor } from "../src/pay-floors";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { confirmedApproval, makeBig } from "./pay-floors-helpers";
import { assertPageBudget, measurePages } from "./perf/pages";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Statements counted on every pg.Client.query call, measured on 12 November 2026: requireStaff is 2 of each; list = role check + page (4); propose = begin, role
// check, lock, pending check, insert, audit, commit (9); confirm = begin, role check, lock, pending check, confirm, replace, activate, item, audit, commit (12);
// reject = begin, role check, lock, pending check, refuse, reject, item, audit, commit (10). Times are medians of 9 warm calls; limits are about 4 times the slowest of
// three runs, with a floor for a busy laptop. Pages are 8 kB pages touched by one full queue page of 21 rows (planning + execution + serialisation): measured 176, the module's gate is 1,000. Medians measured 2.4 to 2.8 ms
// (list), 2.5 to 2.8 (propose), 3.5 to 3.8 (confirm), 2.7 to 3.2 (reject). Raise these only on purpose.
const BUDGET = { list: 4, propose: 9, confirm: 12, reject: 10, listMs: 12, proposeMs: 14, confirmMs: 20, rejectMs: 14, pages: 300 };

const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3002";
let db: TestDb, su: pg.Pool;
let F: { org(o?: object): Promise<number>; portal(): Promise<string>; member(org: number, user: string, o?: object): Promise<number>; staff(): Promise<string>; text(p?: string): Promise<number> };
let route: { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> };
let AUTH: (r: Request) => Promise<Response>;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable", STAFF_AUTH_URL: BASE, STAFF_AUTH_SECRET: secret });
  route = await import("../../../apps/admin/app/api/pay-floors/route");
  ({ POST: AUTH } = await import("../../../apps/admin/app/api/auth/staff/[...all]/route"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

// ===== staff, with real sessions =====
const PW = "Fake-floor-password-1";
const staff: Record<string, string> = {};
const cookies: Record<string, string> = {};
let ipn = 10;
async function makeStaff(name: string, roles: string[]) {
  const c = await su.connect();
  try {
    staff[name] = await seedStaff(c, { email: `${name}@example.test`, name: `Fake ${name}`, roles: roles.length ? roles : ["content_editor"] }, PW);
  } finally {
    c.release();
  }
  if (roles.length === 0) await su.query("delete from staff_role where staff_user_id = $1", [staff[name]]);
  const res = await AUTH(new Request(`${BASE}/api/auth/staff/sign-in/email`, {
    method: "POST", body: JSON.stringify({ email: `${name}@example.test`, password: PW }),
    headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${ipn++}` },
  }));
  expect(res.status, name).toBe(200);
  cookies[name] = res.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
}
beforeAll(async () => {
  for (const n of ["ed1", "ed2"]) await makeStaff(n, ["rules_data_editor"]);
  for (const n of ["ad1", "ad2"]) await makeStaff(n, ["administrator"]);
  await makeStaff("both", ["rules_data_editor", "administrator"]);
  await makeStaff("reviewer", ["account_reviewer"]);
  await makeStaff("ts", ["trust_and_safety"]);
  await makeStaff("fetched", ["fetched_job_reviewer"]);
  await makeStaff("norole", []);
  await makeStaff("disabled", ["rules_data_editor", "administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [staff.disabled]); // after sign-in: the open session is refused too
});

type Reply = { status: number; json: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string | null, body?: unknown, o: { origin?: string | null; raw?: string; query?: string; cookie?: string; length?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const cookie = o.cookie ?? (who ? cookies[who] : undefined);
  if (cookie) headers.cookie = cookie;
  if (o.length) headers["content-length"] = o.length;
  const post = body !== undefined || o.raw !== undefined;
  if (post && o.origin !== null) headers.origin = o.origin ?? BASE;
  const res = await (post ? route.POST : route.GET)(new Request(`${BASE}/api/pay-floors${o.query ?? ""}`, { method: post ? "POST" : "GET", body: post ? (o.raw ?? JSON.stringify(body)) : undefined, headers }));
  return { status: res.status, json: await res.json() };
}
const act = (who: string | null, action: string, floorId: string | number, extra: object = {}) => call(who, { action, floorId: String(floorId), ...extra });
const ok = async (r: Promise<Reply>) => { const x = await r; expect(x.status, JSON.stringify(x.json)).toBe(200); return x.json; };
const no = async (r: Promise<Reply>, status: number, error: string) => { const x = await r; expect([x.status, x.json.error], JSON.stringify(x.json)).toEqual([status, error]); };
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: (i: number) => Promise<unknown>) => {
  const ms = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(i); ms.push(performance.now() - t); }
  return ms.sort((a, b) => a - b)[4]!;
};
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];

// ===== test data =====
let text: number;
beforeAll(async () => { text = await F.text("pay_floor"); });
type Co = { org: number; member: number };
async function company(o: { big?: boolean; status?: string; kind?: string } = {}): Promise<Co> {
  const org = Number(await F.org({ status: o.status ?? "verified", kind: o.kind ?? "employer", name: `Fake Co ${Math.random().toString(36).slice(2, 8)}` }));
  const user = await F.portal();
  const member = Number(await F.member(org, user, { role: "account_owner", signer: true }));
  if (o.big !== false) await makeBig(su, F.staff, org);
  return { org, member };
}
/** A pending floor, inserted as postgres: the insert trigger queues its pay_floor_check item. */
async function floor(c: Co, o: { family?: string; eur?: number } = {}): Promise<number> {
  return Number((await one(
    "insert into pay_floor(organisation_id, role_family, floor_eur, consent_text_id, signer_membership_id, signer_name, signer_title, valid_until) values ($1,$2,$3,$4,$5,'Fake Signer','Account owner', now() + interval '12 months') returning id",
    [c.org, o.family ?? "3434", o.eur ?? 40000, text, c.member])).id);
}
const state = (id: number) => one(
  "select f.status, f.approval_request_id, f.checked_by_staff_id, f.checked_at is not null as checked, f.ended_at is not null as ended, f.replaces_id, (select r.status from review_item r where r.pay_floor_id = f.id and r.queue = 'pay_floor_check' order by r.id desc limit 1) as item, " +
  "(select r.outcome from review_item r where r.pay_floor_id = f.id and r.queue = 'pay_floor_check' order by r.id desc limit 1) as outcome from pay_floor f where f.id = $1", [id]);
const requests = (id: number) => su.query("select id, status, proposed_by_staff_user_id p, confirmed_by_staff_user_id c, applied_at is not null as applied from approval_request where kind = 'pay_floor' and target_id = $1 order by id", [String(id)]).then((r) => r.rows);
const audits = (id: number) => su.query("select action, actor_staff_user_id a, second_staff_user_id s, reason_code r, after from audit_event where object_type = 'pay_floor' and object_id = $1 order by id", [String(id)]).then((r) => r.rows);

describe("access", () => {
  it("refuses a call with no session, and a disabled login", async () => {
    await no(call(null), 401, "no_session");
    await no(call("disabled"), 401, "not_active");
    await no(act("disabled", "propose", 1), 401, "not_active");
    await no(act(null, "propose", 1), 401, "no_session");
    await no(call(null, { action: "propose", floorId: "1" }, { cookie: "better-auth.session_token=forged" }), 401, "no_session");
  });
  it("refuses every other role, on read and on every action, and changes nothing", async () => {
    const f = await floor(await company());
    for (const who of ["reviewer", "ts", "fetched", "norole"]) {
      await no(call(who), 403, "not_floor_staff");
      await no(call(who, undefined, { query: `?id=${f}` }), 403, "not_floor_staff");
      await no(act(who, "propose", f), 403, "not_rules_editor");
      await no(act(who, "confirm", f), 403, "not_administrator");
      await no(act(who, "reject", f, { reason: "no_evidence" }), 403, "not_floor_staff");
    }
    expect(await state(f)).toMatchObject({ status: "pending_check", item: "open" });
    expect(await requests(f)).toEqual([]);
    expect(await audits(f)).toEqual([]);
  });
  it("an editor cannot confirm and an administrator cannot propose", async () => {
    const f = await floor(await company());
    await no(act("ad1", "propose", f), 403, "not_rules_editor");
    await ok(act("ed1", "propose", f));
    await no(act("ed2", "confirm", f), 403, "not_administrator");
    expect(await state(f)).toMatchObject({ status: "pending_check" });
  });
});

describe("the list", () => {
  it("shows the waiting floors to an editor and to an administrator, with the company, signer and any proposal", async () => {
    const c = await company(), f = await floor(c, { family: "1111" });
    for (const who of ["ed1", "ad1", "both"]) {
      const r = await ok(call(who));
      const item = r.items.find((x: { floorId: string }) => x.floorId === String(f));
      expect(item, who).toMatchObject({ roleFamily: "1111", floorEur: 40000, organisationId: String(c.org), isBigCompany: true, kind: "employer", signerName: "Fake Signer", signerTitle: "Account owner", currentFloorEur: null, requestId: null, proposedBy: null });
    }
    await ok(act("ed1", "propose", f));
    const again = (await ok(call("ad1"))).items.find((x: { floorId: string }) => x.floorId === String(f));
    expect(again).toMatchObject({ proposedBy: staff.ed1 });
    expect(again.requestId).toMatch(/^\d+$/);
  });
  it("does not list a withdrawn, decided or other-queue floor, and shows the floor it would replace", async () => {
    const c = await company(), f = await floor(c, { family: "1112" }), g = await floor(c, { family: "1113" });
    await su.query("update pay_floor set status = 'withdrawn' where id = $1", [f]);
    const ids = (await ok(call("ed1"))).items.map((x: { floorId: string }) => x.floorId);
    expect(ids).not.toContain(String(f));
    expect(ids).toContain(String(g));
    await ok(act("ed1", "reject", g, { reason: "no_evidence" }));
    expect((await ok(call("ed1"))).items.map((x: { floorId: string }) => x.floorId)).not.toContain(String(g));
    const h = await floor(c, { family: "1114", eur: 40000 });
    await ok(act("ed1", "propose", h)); await ok(act("ad1", "confirm", h));
    const h2 = await floor(c, { family: "1114", eur: 50000 });
    expect((await ok(call("ed1"))).items.find((x: { floorId: string }) => x.floorId === String(h2))).toMatchObject({ currentFloorEur: 40000 });
  });
  it("pages oldest first with a cursor, and refuses a bad cursor", async () => {
    const c = await company();
    for (let i = 0; i < 22; i++) await floor(c, { family: String(2000 + i) });
    const a = await ok(call("ed1"));
    expect(a.items.length).toBe(20);
    expect(typeof a.next).toBe("string");
    const b = await ok(call("ed1", undefined, { query: `?after=${a.next}` }));
    expect(b.items.length).toBeGreaterThan(0);
    const seen = [...a.items, ...b.items].map((x: { itemId: string }) => Number(x.itemId));
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort((x, y) => x - y)).toEqual(seen);
    for (const bad of ["x", "!!", "e30", "a".repeat(300)]) await no(call("ed1", undefined, { query: `?after=${bad}` }), 400, "bad_cursor");
  });
  it("shows one floor by id and answers 404 for an unknown or malformed id", async () => {
    const f = await floor(await company());
    expect((await ok(call("ad1", undefined, { query: `?id=${f}` }))).item).toMatchObject({ floorId: String(f) });
    for (const id of ["99999999", "0", "abc", "1;2", ""]) await no(call("ad1", undefined, { query: `?id=${id}` }), 404, "not_found");
    for (const q of ["?x=1", `?id=${f}&id=${f}`, "?after=a&after=b", "?before=x", `?id=${f}&staff=me`]) await no(call("ad1", undefined, { query: q }), 400, "bad_query");
  });
});

describe("propose, confirm", () => {
  it("an editor proposes, a different administrator confirms: the floor goes active in one step and the item is done", async () => {
    const c = await company(), f = await floor(c);
    const p = await ok(act("ed1", "propose", f));
    expect(await state(f)).toMatchObject({ status: "pending_check", item: "open", approval_request_id: null });
    expect(await requests(f)).toEqual([{ id: p.requestId, status: "pending", p: staff.ed1, c: null, applied: false }]);
    const r = await ok(act("ad1", "confirm", f));
    expect(r).toEqual({ ok: true, floorId: String(f), replacedId: null });
    expect(await state(f)).toMatchObject({ status: "active", approval_request_id: p.requestId, checked_by_staff_id: staff.ad1, checked: true, ended: false, item: "done", outcome: "accepted" });
    expect(await requests(f)).toEqual([{ id: p.requestId, status: "confirmed", p: staff.ed1, c: staff.ad1, applied: true }]);
    expect((await audits(f)).map((a) => [a.action, a.a, a.s])).toEqual([["pay_floor.propose", staff.ed1, null], ["pay_floor.confirm", staff.ad1, staff.ed1]]);
    expect(JSON.stringify(await audits(f))).not.toMatch(/Fake Signer/); // codes and ids only
  });
  it("the proposer cannot confirm, even holding both roles, and nobody confirms without a proposal", async () => {
    const f = await floor(await company());
    await no(act("ad1", "confirm", f), 409, "nothing_pending");
    await ok(act("both", "propose", f));
    await no(act("both", "confirm", f), 409, "same_person");
    expect(await state(f)).toMatchObject({ status: "pending_check" });
    await ok(act("ad2", "confirm", f));
    expect((await state(f)).status).toBe("active");
  });
  it("one proposal at a time", async () => {
    const f = await floor(await company());
    await ok(act("ed1", "propose", f));
    await no(act("ed2", "propose", f), 409, "decision_pending");
    await no(act("ed1", "propose", f), 409, "decision_pending");
    expect((await requests(f)).length).toBe(1);
  });
  it("signing again replaces the active floor of the same family and leaves other families alone", async () => {
    const c = await company();
    const a = await floor(c, { family: "2134", eur: 50000 }), other = await floor(c, { family: "1115" });
    for (const id of [a, other]) { await ok(act("ed1", "propose", id)); await ok(act("ad1", "confirm", id)); }
    const b = await floor(c, { family: "2134", eur: 55000 });
    await ok(act("ed1", "propose", b));
    const r = await ok(act("ad2", "confirm", b));
    expect(r.replacedId).toBe(String(a));
    expect(await state(a)).toMatchObject({ status: "replaced", ended: true });
    expect(await state(b)).toMatchObject({ status: "active", replaces_id: String(a) });
    expect((await state(other)).status).toBe("active");
  });
  it("refuses to activate a floor that is expired, whose company left the list or is no longer verified, or that is not pending", async () => {
    const expired = await floor(await company());
    await ok(act("ed1", "propose", expired));
    await su.query("update pay_floor set signed_at = now() - interval '2 years', valid_until = now() - interval '1 day' where id = $1", [expired]);
    await no(act("ad1", "confirm", expired), 409, "floor_expired");
    await no(act("ed1", "propose", expired), 409, "floor_expired");

    const c = await company(), left = await floor(c);
    await ok(act("ed1", "propose", left));
    await su.query("update organisation set is_big_company = false where id = $1", [c.org]);
    await no(act("ad1", "confirm", left), 409, "not_big_company");

    const c2 = await company(), sus = await floor(c2);
    await ok(act("ed1", "propose", sus));
    await su.query("update organisation set status = 'suspended' where id = $1", [c2.org]);
    await no(act("ad1", "confirm", sus), 409, "organisation_not_active");

    const w = await floor(await company());
    await ok(act("ed1", "propose", w));
    await su.query("update pay_floor set status = 'withdrawn' where id = $1", [w]);
    await no(act("ad1", "confirm", w), 409, "floor_not_pending");
    await no(act("ed2", "propose", w), 409, "floor_not_pending");
    for (const id of [expired, left, sus, w]) expect((await state(id)).status, String(id)).not.toBe("active");
  });
  it("an unknown floor is 404", async () => {
    for (const a of ["propose", "confirm"]) await no(act("both", a, 987654321), 404, "not_found");
    await no(act("both", "reject", 987654321, { reason: "x" }), 404, "not_found");
  });
  it("two administrators confirming at once: one wins, one active floor", async () => {
    const f = await floor(await company());
    await ok(act("ed1", "propose", f));
    const rs = await Promise.all([act("ad1", "confirm", f), act("ad2", "confirm", f), act("both", "confirm", f)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(rs.filter((r) => r.status === 409).every((r) => ["floor_not_pending"].includes(r.json.error))).toBe(true);
    expect((await requests(f)).filter((r) => r.status === "confirmed").length).toBe(1);
    expect((await state(f)).status).toBe("active");
  });
});

describe("reject", () => {
  it("an editor rejects a floor with no proposal: rejected, ended, item done, reason code in the log", async () => {
    const f = await floor(await company());
    await ok(act("ed1", "reject", f, { reason: "advert_shows_lower_pay" }));
    expect(await state(f)).toMatchObject({ status: "rejected", checked_by_staff_id: staff.ed1, ended: true, item: "done", outcome: "rejected" });
    expect((await audits(f)).map((a) => [a.action, a.r])).toEqual([["pay_floor.reject", "advert_shows_lower_pay"]]);
    await no(act("ad1", "confirm", f), 409, "floor_not_pending");
    await no(act("ed1", "reject", f, { reason: "again" }), 409, "floor_not_pending");
  });
  it("an administrator refusing a proposal ends the floor and the request is refused; the proposer's own reject withdraws it", async () => {
    const a = await floor(await company()), b = await floor(await company());
    await ok(act("ed1", "propose", a)); await ok(act("ad1", "reject", a, { reason: "not_confirmed" }));
    await ok(act("ed1", "propose", b)); await ok(act("ed1", "reject", b, { reason: "changed_my_mind" }));
    expect((await requests(a))[0]).toMatchObject({ status: "refused", c: staff.ad1 });
    expect((await requests(b))[0]).toMatchObject({ status: "withdrawn" });
    expect([(await state(a)).status, (await state(b)).status]).toEqual(["rejected", "rejected"]);
  });
  it("needs a reason code, never free text", async () => {
    const f = await floor(await company());
    for (const r of [undefined, "", "Bad", "has space", "1abc", "a;b", "a‮b", "a\nb", "a".repeat(64), 5, null]) await no(act("ed1", "reject", f, r === undefined ? {} : { reason: r }), 400, "bad_reason");
    expect((await state(f)).status).toBe("pending_check");
  });
});

describe("what the database holds even if a route were wrong", () => {
  it("app_admin cannot activate a floor alone, with an unconfirmed request, or with its own proposal confirmed by the same person", async () => {
    const f = await floor(await company());
    const admin = db.pool("app_admin");
    await expect(admin.query("update pay_floor set status='active' where id=$1", [f])).rejects.toThrow();
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.staff_user_id', $1, true)", [staff.both]);
      const rid = (await c.query("insert into approval_request(kind, target_table, target_id) values ('pay_floor','pay_floor',$1) returning id", [String(f)])).rows[0].id;
      await expect(c.query("update approval_request set status='confirmed' where id=$1", [rid])).rejects.toThrow(); // confirmer = proposer
      await c.query("rollback");
      await c.query("begin");
      await c.query("select set_config('app.staff_user_id', $1, true)", [staff.both]);
      const rid2 = (await c.query("insert into approval_request(kind, target_table, target_id) values ('pay_floor','pay_floor',$1) returning id", [String(f)])).rows[0].id;
      await expect(c.query("update pay_floor set status='active', approval_request_id=$2 where id=$1", [f, rid2])).rejects.toThrow(); // still pending
      await c.query("rollback");
    } finally { c.release(); }
    expect((await state(f)).status).toBe("pending_check");
  });
  it("a confirmed request for one floor cannot activate another, and a request is used once", async () => {
    const c = await company(), a = await floor(c, { family: "1116" }), b = await floor(c, { family: "1117" });
    const rid = await confirmedApproval(su, F.staff, "pay_floor", "pay_floor", a);
    const admin = db.pool("app_admin");
    await expect(admin.query("update pay_floor set status='active', approval_request_id=$2 where id=$1", [b, rid])).rejects.toThrow();
    await admin.query("update pay_floor set status='active', approval_request_id=$2 where id=$1", [a, rid]);
    await admin.query("update pay_floor set status='withdrawn' where id=$1", [a]);
    await expect(admin.query("update pay_floor set status='active', approval_request_id=$2 where id=$1", [a, rid])).rejects.toThrow();
  });
});

describe("hostile requests", () => {
  it("refuses a missing or foreign Origin, a long body and bad JSON, and writes nothing", async () => {
    const f = await floor(await company());
    const good = { action: "propose", floorId: String(f) };
    await no(call("ed1", good, { origin: null }), 403, "bad_origin");
    await no(call("ed1", good, { origin: "https://evil.example.test" }), 403, "bad_origin");
    await no(call("ed1", good, { origin: BASE + ".evil.test" }), 403, "bad_origin");
    await no(call("ed1", good, { length: "100000" }), 400, "bad_body");
    await no(call("ed1", undefined, { raw: "x".repeat(600) }), 400, "bad_body");
    for (const raw of ["", "{", "null", "[]", "1", '"propose"']) await no(call("ed1", undefined, { raw }), 400, "bad_body");
    expect(await requests(f)).toEqual([]);
  });
  it("refuses unknown actions, unknown fields and bad ids", async () => {
    const f = await floor(await company());
    for (const action of ["activate", "approve", "withdraw", "toString", "__proto__", "", 5, null]) await no(call("both", { action, floorId: String(f) }), 400, "bad_action");
    for (const extra of [{ status: "active" }, { organisationId: "1" }, { approvalRequestId: "1" }, { floorEur: 1 }, { reason: "x" }]) await no(call("ed1", { action: "propose", floorId: String(f), ...extra }), 400, extra.reason ? "bad_reason" : "bad_body");
    for (const floorId of [5, null, "", "0", "01", "-1", "1.5", "1e3", "1 or 1=1", "1;drop table pay_floor", "12345678901234567890", ["1"], { a: 1 }]) await no(call("ed1", { action: "propose", floorId }), 400, "bad_floor_id");
    expect(await requests(f)).toEqual([]);
    expect((await state(f)).status).toBe("pending_check");
  });
});

describe("a withdrawn floor drops its check item (0023, #234 D8)", () => {
  const who = (c: Co) => ({ membershipId: c.member, organisationId: c.org, role: "account_owner" });
  const item = (id: number) => one("select status, outcome, decided_at is not null as decided, decided_by_staff_user_id by from review_item where pay_floor_id = $1 and queue = 'pay_floor_check'", [id]);
  it("the employer's withdrawal of a pending floor drops its open item in the same statement, and it leaves the queue", async () => {
    const c = await company(), f = await floor(c), other = await floor(c, { family: "1118" });
    expect(await item(f)).toMatchObject({ status: "open" });
    const [, statements] = await counted(() => withdrawPayFloor(db.pool("app_portal"), who(c), String(f)));
    expect(statements).toBe(1); // the trigger runs inside the one update
    expect(await item(f)).toEqual({ status: "dropped", outcome: "withdrawn", decided: true, by: null });
    expect((await state(f)).status).toBe("withdrawn");
    expect((await ok(call("ed1"))).items.map((x: { floorId: string }) => x.floorId)).not.toContain(String(f));
    expect(await item(other)).toMatchObject({ status: "open" }); // the company's other floor is untouched
    await no(act("ed1", "propose", f), 409, "floor_not_pending");
  });
  it("drops a claimed item too, also when the floor had a proposal", async () => {
    const c = await company(), f = await floor(c), g = await floor(c, { family: "1119" });
    await su.query("update review_item set status = 'claimed', claimed_by_staff_user_id = $2, claimed_at = now() where pay_floor_id = $1 and queue = 'pay_floor_check'", [f, staff.ed1]);
    await ok(act("ed1", "propose", g));
    await withdrawPayFloor(db.pool("app_portal"), who(c), String(f));
    await withdrawPayFloor(db.pool("app_portal"), who(c), String(g));
    expect(await item(f)).toMatchObject({ status: "dropped", outcome: "withdrawn" });
    expect(await item(g)).toMatchObject({ status: "dropped", outcome: "withdrawn" });
    await no(act("ad1", "confirm", g), 409, "floor_not_pending");
  });
  it("leaves another company's items alone, and an active floor's finished item as it was", async () => {
    const [c, d] = [await company(), await company()];
    const [fc, fd, act1] = [await floor(c), await floor(d), await floor(c, { family: "1120" })];
    await ok(act("ed1", "propose", act1)); await ok(act("ad1", "confirm", act1));
    await withdrawPayFloor(db.pool("app_portal"), who(c), String(fc));
    await withdrawPayFloor(db.pool("app_portal"), who(c), String(act1)); // an active floor: withdrawn, but its item was finished by the check
    expect(await item(fd)).toMatchObject({ status: "open" });
    expect(await item(act1)).toMatchObject({ status: "done", outcome: "accepted" });
    await expect(withdrawPayFloor(db.pool("app_portal"), who(c), String(fd))).rejects.toThrow(); // not their floor: nothing happens
    expect(await item(fd)).toMatchObject({ status: "open" });
  });
  it("only the move from pending_check to withdrawn does it: a rejection or an expiry written by the owner role leaves its item as the check set it", async () => {
    const [a, b] = [await floor(await company()), await floor(await company())];
    await su.query("update pay_floor set status = 'found_false' where id = $1", [a]);
    expect(await item(a)).toMatchObject({ status: "open" });
    await su.query("update pay_floor set status = 'withdrawn' where id = $1", [b]); // the trigger does not care who writes
    expect(await item(b)).toMatchObject({ status: "dropped" });
  });
});

describe("performance", () => {
  it("list, propose, confirm and reject stay inside their statement and time budgets; the queue page stays under its page budget", async () => {
    const c = await company();
    const ids: number[] = [];
    for (let i = 0; i < 25; i++) ids.push(await floor(c, { family: String(3000 + i) }));
    const [, listN] = await counted(() => call("ed1"));
    const [, proposeN] = await counted(() => act("ed1", "propose", ids[0]!));
    const [, confirmN] = await counted(() => act("ad1", "confirm", ids[0]!));
    const [, rejectN] = await counted(() => act("ed1", "reject", ids[1]!, { reason: "perf" }));
    expect([listN, proposeN, confirmN, rejectN]).toEqual([BUDGET.list, BUDGET.propose, BUDGET.confirm, BUDGET.reject]);
    const timed = { list: await median(() => call("ed1")) };
    const t = [ids.slice(2, 11), ids.slice(11, 20)] as const;
    const tp = await median((i) => act("ed1", "propose", t[0][i]!));
    const tc = await median((i) => act("ad1", "confirm", t[0][i]!));
    const tr = await median((i) => act("ed1", "reject", t[1][i]!, { reason: "perf" }));
    expect(timed.list).toBeLessThan(BUDGET.listMs);
    expect(tp).toBeLessThan(BUDGET.proposeMs);
    expect(tc).toBeLessThan(BUDGET.confirmMs);
    expect(tr).toBeLessThan(BUDGET.rejectMs);
    const client = await su.connect();
    try {
      const costs = await measurePages(client, [FLOOR_FIRST]);
      assertPageBudget("pay floor queue", costs, BUDGET.pages);
    } finally { client.release(); }
  });
});
