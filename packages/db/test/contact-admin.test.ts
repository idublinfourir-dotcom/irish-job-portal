// Decision #55: the staff contact inbox through the real /api/contact handler of the admin app, real staff sessions, the real test database as app_admin.
// Services case handlers (SC) and content editors (CE) list, read, claim and decide; an administrator (AD) may read only; every other login is refused.
// Every read of a message and every status change writes an audit row. Fake people only; no network.
// Budget (measured 16 November 2026, see the printed line; requireStaff is 2 statements): list = role check + page (4 in all); read = begin, role check, select,
// audit, commit (+2 = 7); claim = begin, role check, update, audit, commit (+2 = 7). Medians are over 9 warm calls through the route; the limits are about 4 times
// the slowest of three runs, with a floor for a busy laptop.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BUDGET = { list: 4, read: 7, claim: 7, listMs: 12, readMs: 12, claimMs: 12 };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, su: pg.Pool;
let F: { cand: () => Promise<string> };
const call = (who: string | null, body?: unknown, o: Parameters<typeof h.call>[4] = {}) => h.call(route, "/api/contact", who, body, o);
const act = (who: string | null, action: string, messageId: string, extra: object = {}) => call(who, { action, messageId, ...extra });
const ok = (r: ReturnType<typeof call>) => h.ok(r);
const no = (r: ReturnType<typeof call>, status: number, error: string) => h.no(r, status, error);
let n = 0;

beforeAll(async () => {
  db = await createTestDb();
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  h = await staffHarness(db);
  su = h.su;
  route = await import("../../../apps/admin/app/api/contact/route");
  for (const [name, roles] of [["sc1", ["services_case_handler"]], ["sc2", ["services_case_handler"]], ["ce1", ["content_editor"]], ["ad1", ["administrator"]], ["adsc", ["administrator", "services_case_handler"]]] as const) await h.makeStaff(name, [...roles]);
  for (const r of ROLE_NAMES) if (!["services_case_handler", "content_editor", "administrator"].includes(r)) await h.makeStaff(`only_${r}`, [r]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["services_case_handler"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

/** A message as the contact form wrote it (as postgres), with a created time in minutes ago so the order is known. */
async function msg(o: { topic?: string; status?: string; minutesAgo?: number; candidate?: string | null; body?: string | null; by?: string } = {}) {
  const id = ++n, status = o.status ?? "new";
  const claimed = status === "claimed" ? ", claimed_by_staff_user_id, claimed_at" : "";
  const claimedV = status === "claimed" ? `, '${h.staff[o.by ?? "sc1"]}', now()` : "";
  return (await su.query(
    `insert into contact_message(surface, candidate_user_id, from_name, from_email, topic, body, status, created_at${claimed}) values ('candidate_site', $1, $2, $3, $4, $5, $6, now() - ($7 || ' minutes')::interval${claimedV}) returning id::text`,
    [o.candidate ?? null, `Fake Sender ${id}`, `sender${id}@example.test`, o.topic ?? "general", o.body === undefined ? `Fake message ${id}` : o.body, status, String(o.minutesAgo ?? 1)])).rows[0].id as string;
}
const clear = async () => { await su.query("delete from review_item where contact_message_id is not null"); await su.query("delete from contact_message"); };
const audit = async (action: string, id: string) => (await su.query("select * from audit_event where action=$1 and object_id=$2 order by id", [action, id])).rows;
const state = async (id: string) => (await su.query("select status, claimed_by_staff_user_id by, claimed_at, closed_at from contact_message where id=$1", [id])).rows[0];

describe("the list", () => {
  it("shows new and claimed messages, oldest first, with no name, email or text; decided ones are left out", async () => {
    const [a, b, c, done] = [await msg({ minutesAgo: 900 }), await msg({ minutesAgo: 800, status: "claimed" }), await msg({ minutesAgo: 700 }), await msg({ minutesAgo: 600, status: "answered" })];
    const j = await ok(call("sc1"));
    const ids = (j.items as { id: string }[]).map((x) => x.id);
    expect(ids.slice(0, 3)).toEqual([a, b, c]);
    expect(ids).not.toContain(done);
    expect(Object.keys(j.items[0]).sort()).toEqual(["claimedByStaffUserId", "claimedText", "createdText", "id", "status", "surface", "topic"]);
    expect(JSON.stringify(j)).not.toMatch(/Fake Sender|sender\d+@example|Fake message/);
  });
  it("pages by keyset across both statuses without a gap or a repeat", async () => {
    await clear();
    const made: string[] = [];
    for (let i = 0; i < 47; i++) made.push(await msg({ minutesAgo: 5000 - i, status: i % 3 === 0 ? "claimed" : "new" }));
    const seen: string[] = []; let after: string | undefined; let pages = 0;
    do {
      const j = await ok(call("ce1", undefined, { query: after ? `?after=${after}` : "" }));
      seen.push(...(j.items as { id: string }[]).map((x) => x.id)); after = j.next ?? undefined; pages++;
    } while (after);
    expect(seen).toEqual(made);
    expect(pages).toBe(3);
  });
  it("a page token that is not ours, and any other query parameter, is refused", async () => {
    for (const q of ["?after=x", "?after=" + Buffer.from('{"t":"nope","i":"1"}').toString("base64url"), "?after=" + "A".repeat(300)]) await no(call("sc1", undefined, { query: q }), 400, "bad_cursor");
    await no(call("sc1", undefined, { query: "?status=all" }), 400, "bad_query");
    await no(call("sc1", undefined, { query: "?id=1&id=2" }), 400, "bad_query");
  });
});

describe("reading one message", () => {
  it("shows it in full and logs the read, with the candidate as subject", async () => {
    const cand = await F.cand();
    const id = await msg({ candidate: cand, topic: "data_request", body: "Please send my data" });
    const j = await ok(call("sc1", undefined, { query: `?id=${id}` }));
    expect(j.item).toMatchObject({ id, status: "new", topic: "data_request", body: "Please send my data", candidateUserId: cand, portalUserId: null });
    expect(j.item.fromEmail).toMatch(/@example\.test$/);
    const [row] = await audit("contact.read", id);
    expect(row).toMatchObject({ kind: "data_access", actor_staff_user_id: h.staff.sc1, role_in_force: "services_case_handler", object_type: "contact_message", subject_candidate_user_id: cand, source: "panel" });
    expect(JSON.stringify(row)).not.toContain("Please send my data"); // the text is never copied into the log
  });
  it("a content editor and an administrator may read; each read is logged under their own role", async () => {
    const id = await msg();
    await ok(call("ce1", undefined, { query: `?id=${id}` }));
    await ok(call("ad1", undefined, { query: `?id=${id}` }));
    await ok(call("adsc", undefined, { query: `?id=${id}` }));
    expect((await audit("contact.read", id)).map((r) => [r.actor_staff_user_id, r.role_in_force])).toEqual([[h.staff.ce1, "content_editor"], [h.staff.ad1, "administrator"], [h.staff.adsc, "services_case_handler"]]);
  });
  it("an unknown or malformed id is not found, and a refused read writes no log row", async () => {
    await no(call("sc1", undefined, { query: "?id=999999999" }), 404, "not_found");
    await no(call("sc1", undefined, { query: "?id=abc" }), 404, "not_found");
    const id = await msg();
    await no(call("only_trust_and_safety", undefined, { query: `?id=${id}` }), 403, "not_contact_reader");
    expect(await audit("contact.read", id)).toEqual([]);
  });
  it("a message of an erased sender reads as empty", async () => {
    const cand = await F.cand();
    const id = await msg({ candidate: cand });
    expect((await su.query("select private.erase_candidate($1, true) r", [cand])).rows[0].r.erased).toBe(true);
    const j = await ok(call("sc1", undefined, { query: `?id=${id}` }));
    expect(j.item).toMatchObject({ fromName: null, fromEmail: null, body: null, candidateUserId: null });
  });
});

describe("claim and decide", () => {
  it("claim, answer: the claimer's id and times are set and each step is logged", async () => {
    const cand = await F.cand();
    const id = await msg({ candidate: cand });
    await ok(act("sc1", "claim", id));
    expect(await state(id)).toMatchObject({ status: "claimed", by: h.staff.sc1 });
    expect((await state(id)).claimed_at).not.toBeNull();
    await ok(act("sc1", "answer", id));
    expect(await state(id)).toMatchObject({ status: "answered", by: h.staff.sc1, closed_at: null });
    expect((await audit("contact.claim", id))[0]).toMatchObject({ kind: "admin_action", actor_staff_user_id: h.staff.sc1, role_in_force: "services_case_handler", subject_candidate_user_id: cand, after: { status: "claimed" } });
    expect((await audit("contact.answered", id))[0]).toMatchObject({ kind: "admin_action", after: { status: "answered" } });
  });
  it("close sets closed_at; spam leaves it empty; a content editor may act", async () => {
    const [a, b] = [await msg(), await msg()];
    await ok(act("ce1", "claim", a)); await ok(act("ce1", "close", a));
    await ok(act("ce1", "claim", b)); await ok(act("ce1", "spam", b));
    expect(await state(a)).toMatchObject({ status: "closed" });
    expect((await state(a)).closed_at).not.toBeNull();
    expect(await state(b)).toMatchObject({ status: "spam", closed_at: null });
    expect(await audit("contact.closed", a)).toHaveLength(1);
    expect((await audit("contact.spam", b))[0]).toMatchObject({ role_in_force: "content_editor" });
  });
  it("a decided message leaves the list and cannot be changed again", async () => {
    const id = await msg();
    await ok(act("sc1", "claim", id)); await ok(act("sc1", "answer", id));
    expect(((await ok(call("sc1"))).items as { id: string }[]).map((x) => x.id)).not.toContain(id);
    for (const a of ["answer", "close", "spam", "claim"]) await no(act("sc1", a, id), 409, "already_decided");
  });
  it("only the claimer decides; a message nobody holds cannot be decided; claiming again is fine", async () => {
    const id = await msg();
    await no(act("sc1", "answer", id), 409, "not_claimed");
    await ok(act("sc1", "claim", id));
    await ok(act("sc1", "claim", id));
    expect(await audit("contact.claim", id)).toHaveLength(1); // the second claim changed nothing and wrote nothing
    await no(act("sc2", "claim", id), 409, "claimed_by_other");
    for (const a of ["answer", "close", "spam"]) await no(act("sc2", a, id), 409, "not_claimer");
    expect(await state(id)).toMatchObject({ status: "claimed", by: h.staff.sc1 });
  });
  it("a claim goes stale after a day, or when its holder is disabled, and can then be taken over", async () => {
    const stale = await msg({ status: "claimed", by: "sc1" });
    await su.query("update contact_message set claimed_at = now() - interval '25 hours' where id=$1", [stale]);
    await ok(act("sc2", "claim", stale));
    expect(await state(stale)).toMatchObject({ by: h.staff.sc2 });
    const gone = await msg({ status: "claimed", by: "disabled" });
    await no(act("sc1", "answer", gone), 409, "not_claimer");
    await ok(act("sc1", "claim", gone));
    expect(await state(gone)).toMatchObject({ by: h.staff.sc1 });
  });
  it("an unknown id is not found", async () => {
    for (const a of ["claim", "answer", "close", "spam"]) await no(act("sc1", a, "999999999"), 404, "not_found");
  });
});

describe("security", () => {
  it("an administrator alone cannot claim or change a status, and nothing changes or is logged", async () => {
    const id = await msg({ status: "claimed", by: "sc1" });
    for (const a of ["claim", "answer", "close", "spam"]) await no(act("ad1", a, id), 403, "not_contact_staff");
    expect(await state(id)).toMatchObject({ status: "claimed", by: h.staff.sc1 });
    expect(await audit("contact.claim", id)).toEqual([]);
    const fresh = await msg();
    await no(act("ad1", "claim", fresh), 403, "not_contact_staff");
    expect(await state(fresh)).toMatchObject({ status: "new", by: null });
  });
  it("an administrator who also holds the services role may act, under that role", async () => {
    const id = await msg();
    await ok(act("adsc", "claim", id));
    expect((await audit("contact.claim", id))[0]).toMatchObject({ role_in_force: "services_case_handler" });
  });
  it("every other role, a login with no role, a disabled login and no session are refused, for the list, a read and every action", async () => {
    const id = await msg();
    const others = ROLE_NAMES.filter((r) => !["services_case_handler", "content_editor", "administrator"].includes(r)).map((r) => `only_${r}`);
    for (const who of [...others, "norole"]) {
      await no(call(who), 403, "not_contact_reader");
      await no(call(who, undefined, { query: `?id=${id}` }), 403, "not_contact_reader");
      for (const a of ["claim", "answer", "close", "spam"]) await no(act(who, a, id), 403, "not_contact_staff");
    }
    for (const r of [await call("disabled"), await call("disabled", { action: "claim", messageId: id }), await call(null), await call(null, { action: "claim", messageId: id })]) expect([401, 403]).toContain(r.status);
    await no(call(null), 401, "no_session");
    expect(await state(id)).toMatchObject({ status: "new", by: null });
    expect(await audit("contact.read", id)).toEqual([]);
  });
  it("a foreign or missing Origin, an oversized body, hostile bodies", async () => {
    const id = await msg();
    await no(call("sc1", { action: "claim", messageId: id }, { origin: "https://evil.example" }), 403, "bad_origin");
    await no(call("sc1", { action: "claim", messageId: id }, { origin: null }), 403, "bad_origin");
    await no(call("sc1", { action: "claim", messageId: id, pad: "x".repeat(300) }), 400, "bad_body");
    await no(call("sc1", { action: "claim", messageId: id }, { length: "99999" }), 400, "bad_body");
    for (const raw of ["not json", "[]", "null", "5", JSON.stringify({ action: "reply", messageId: id }), JSON.stringify({ action: "claim" }), JSON.stringify({ action: "toString", messageId: id })])
      expect((await call("sc1", undefined, { raw })).status, raw).toBe(400);
    for (const extra of [{ status: "answered" }, { claimedBy: "x" }, { body: "x" }, { staffId: "x" }]) await no(act("sc1", "claim", id, extra), 400, "bad_body");
    for (const bad of [1, null, "", "0", "01", "-1", "1.5", "1e3", "1 or 1=1", "12345678901234567890", ["1"], { a: 1 }]) await no(act("sc1", "claim", bad as string), 400, "bad_message_id");
    expect(await state(id)).toMatchObject({ status: "new" });
  });
  it("the admin app role cannot make a message or delete one", async () => {
    const admin = db.pool("app_admin");
    await expect(admin.query("insert into contact_message(surface, topic, body) values ('portal','general','x')")).rejects.toMatchObject({ code: "42501" });
    await expect(admin.query("delete from contact_message")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("performance: the inbox calls", () => {
  it("stay inside their statement count and time budget", async () => {
    await clear();
    for (let i = 0; i < 60; i++) await msg({ minutesAgo: 1000 - i, status: i % 4 === 0 ? "claimed" : "new" });
    const one = await msg({ minutesAgo: 5 });
    const [, list] = await counted(() => call("ce1"));
    const [, read] = await counted(() => call("sc1", undefined, { query: `?id=${one}` }));
    const [, claim] = await counted(() => act("sc1", "claim", one));
    const fresh = await Promise.all(Array.from({ length: 9 }, (_, i) => msg({ minutesAgo: 2 + i })));
    const ms = {
      list: await median(() => call("ce1")),
      read: await median(() => call("sc1", undefined, { query: `?id=${one}` })),
      claim: await median((i) => act("sc1", "claim", fresh[i]!)),
    };
    console.log(`contact-admin: list ${list} statements ${ms.list.toFixed(1)} ms; read ${read} statements ${ms.read.toFixed(1)} ms; claim ${claim} statements ${ms.claim.toFixed(1)} ms`);
    expect(list).toBeLessThanOrEqual(BUDGET.list);
    expect(read).toBeLessThanOrEqual(BUDGET.read);
    expect(claim).toBeLessThanOrEqual(BUDGET.claim);
    expect(ms.list).toBeLessThan(BUDGET.listMs);
    expect(ms.read).toBeLessThan(BUDGET.readMs);
    expect(ms.claim).toBeLessThan(BUDGET.claimMs);
  });
});
