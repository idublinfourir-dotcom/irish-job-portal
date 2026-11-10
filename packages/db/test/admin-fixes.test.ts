// The four safeguards of migration 0004 (database review of 10 November 2026, findings M1 to M4). Every action runs as the
// real role; fixtures are inserted as postgres. One database for the file, fake data only.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, rule, tx, type Role, type TestDb } from "./db";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());

const uid = (p: string) => `${p}_${randomBytes(5).toString("hex")}`;
const su = (sql: string, args?: unknown[]) => db.query("postgres", sql, args);
// One transaction as `role` with the acting staff id set local (null leaves it unset).
const run = (role: Role, staff: string | null, sql: string, args?: unknown[]) =>
  tx(db.pool(role), async (c) => {
    if (staff !== null) await c.query("select set_config('app.staff_user_id', $1, true)", [staff]);
    return c.query(sql, args);
  });
const near = (t: unknown) => Math.abs(new Date(t as string).getTime() - Date.now()) < 5000;

async function staff(role?: string, status = "active") {
  const i = uid("s");
  await su("insert into staff_user(id,name,email,email_verified) values($1,'Fake Staff',$2,true)", [i, `${i}@example.test`]);
  if (role) await su("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,$2,true)", [i, role]);
  if (status !== "active") await su("update staff_user set status=$2 where id=$1", [i, status]);
  return i;
}
const cand = async (o = "now()") => { const i = uid("c"); await su(`insert into candidate_user(id,name,email,email_verified,created_at,updated_at,last_active_at) values($1,'Fake Candidate',$2,true,now() - interval '40 days',now(),${o})`, [i, `${i}@example.test`]); return i; };
const portalUser = async () => { const i = uid("p"); await su("insert into portal_user(id,name,email,email_verified) values($1,'Fake Member',$2,true)", [i, `${i}@example.test`]); return i; };

let A: string, B: string, T: string;
beforeAll(async () => { A = await staff("administrator"); B = await staff("administrator"); T = await staff("trust_and_safety"); });

// =====================================================================================================================
// M2: a change to a setting's value needs a second person (kind 'setting'), is stamped and audited, and is never negative
const mkSetting = async (value: number | null = 12) => { const k = uid("k"); await su("insert into setting(key,value,unit,updated_at) values($1,$2,'months',now() - interval '1 day')", [k, value]); return k; };
const propose = async (key: string, change: object, by = A) =>
  (await run("app_admin", by, "insert into approval_request(kind,target_table,target_id,change) values('setting','setting',$1,$2) returning id", [key, JSON.stringify(change)])).rows[0].id as string;
const confirm = (rid: string, by = B) => run("app_admin", by, "update approval_request set status='confirmed' where id=$1", [rid]);
const approved = async (key: string, value: number | null) => { const r = await propose(key, { value }); await confirm(r); return r; };
const setValue = (key: string, value: number | null, by: string | null = A) => run("app_admin", by, "update setting set value=$2 where key=$1", [key, value]);
const auditFor = async (key: string) => (await su("select * from audit_event where object_type='setting' and object_id=$1 order by id", [key])).rows;

test("M2 must not: a value change with no request, or with a request still pending", async () => {
  const k = await mkSetting();
  await rule({ refuse: () => setValue(k, 6), expect: "two-person rule" });
  await propose(k, { value: 6 });
  await rule({ refuse: () => setValue(k, 6), expect: "two-person rule" });
});
test("M2 must not: a request confirmed for another number (or with no value at all) does not cover this one", async () => {
  const k = await mkSetting();
  await approved(k, 7);
  await rule({ refuse: () => setValue(k, 6), expect: "two-person rule" });
  const k2 = await mkSetting();
  const r = await propose(k2, {}); await confirm(r);
  await rule({ refuse: () => setValue(k2, null), expect: "two-person rule" });
});
test("M2 must do: with the right confirmed request the change is accepted, stamped and audited once with old and new value", async () => {
  const k = await mkSetting(12);
  const r = await approved(k, 6);
  await rule({ ok: () => setValue(k, 6) });
  const s = (await su("select value, updated_by_staff_user_id, updated_at from setting where key=$1", [k])).rows[0];
  expect(s.value).toBe(6); expect(s.updated_by_staff_user_id).toBe(A); expect(near(s.updated_at)).toBe(true);
  expect((await su("select applied_at from approval_request where id=$1", [r])).rows[0].applied_at).not.toBeNull();
  const a = await auditFor(k);
  expect(a.length).toBe(1);
  expect(a[0]).toMatchObject({ kind: "admin_action", actor_staff_user_id: A, second_staff_user_id: B, action: "setting.change", source: "panel" });
  expect(a[0].before.value).toBe(12); expect(a[0].after.value).toBe(6);
});
test("M2 must do: an empty value is approved as JSON null; must not: the same request used twice", async () => {
  const k = await mkSetting(12);
  await approved(k, null);
  await rule({ ok: () => setValue(k, null) });
  expect((await su("select value from setting where key=$1", [k])).rows[0].value).toBeNull();
  await su("update setting set value=12 where key=$1", [k]); // put back as postgres, so only the used request could cover the next change
  await rule({ refuse: () => setValue(k, null), expect: "two-person rule" });
});
test("M2 must not: a negative value, even with a confirmed request for it", async () => {
  const k = await mkSetting();
  await approved(k, -5);
  await rule({ refuse: () => setValue(k, -5), expect: "setting_value_check" });
});
test("M2 must not: app_admin changes key, unit or the two stamped columns", async () => {
  const k = await mkSetting();
  for (const set of ["key = key || 'x'", "unit = 'days'", `updated_by_staff_user_id = '${B}'`, "updated_at = now() - interval '1 year'"])
    await rule({ refuse: () => run("app_admin", A, `update setting set ${set} where key=$1`, [k]), expect: "permission denied" });
});
test("M2 must not: any setting write with no acting id, an empty one, or a disabled login's", async () => {
  const k = await mkSetting();
  await approved(k, 6);
  const gone = await staff("administrator", "disabled");
  for (const who of [null, "", gone])
    await rule({ refuse: () => run("app_admin", who, "update setting set is_guess=false where key=$1", [k]), expect: "acting staff" });
});
test("M2 must do: a change that leaves the value alone needs no request, and is still stamped and audited", async () => {
  const k = await mkSetting(12);
  await rule({ ok: () => run("app_admin", A, "update setting set is_guess=false, solicitor_note='fake note' where key=$1", [k]) });
  expect((await su("select updated_by_staff_user_id from setting where key=$1", [k])).rows[0].updated_by_staff_user_id).toBe(A);
  const a = await auditFor(k);
  expect(a.length).toBe(1);
  expect(a[0].after).toMatchObject({ value: 12, is_guess: false });
  expect(JSON.stringify(a[0].after)).not.toContain("fake note"); // free text stays out of the log
});
test("M2 must not: a new setting row with no request; must do: with one", async () => {
  const k = uid("k");
  const ins = () => run("app_admin", A, "insert into setting(key,value,unit) values($1,3,'days')", [k]);
  await rule({ refuse: ins, expect: "two-person rule" });
  await approved(k, 3);
  await rule({ ok: ins });
});
test("M2 must not: the proposer confirms their own setting request, or trust_and_safety confirms one", async () => {
  const r = await propose(await mkSetting(), { value: 1 });
  await rule({ refuse: () => confirm(r, A), expect: "check constraint" });
  await rule({ refuse: () => confirm(r, T), expect: "role that covers" });
});
test("M2 must do: portal_owner (a migration) changes a setting with no request and no acting id", async () => {
  const k = await mkSetting();
  await rule({ ok: () => run("portal_owner", null, "update setting set value=1, unit='days' where key=$1", [k]) });
});
test("M2 the probe end to end: after the refused changes, run_retention leaves every candidate in place", async () => {
  const people = [await cand("now() - interval '1 hour'"), await cand("now() - interval '1 hour'"), await cand("now() - interval '1 hour'")];
  await rule({ refuse: () => setValue("inactive_account", 0, null), expect: "acting staff" });
  await rule({ refuse: () => setValue("inactive_account", 0), expect: "two-person rule" });
  await rule({ refuse: () => setValue("deleted_account_grace", -5), expect: "two-person rule" });
  await rule({ refuse: () => run("app_admin", A, "update setting set unit='days' where key='services_case_record'"), expect: "permission denied" });
  for (let i = 0; i < 60; i++) {
    const r = (await run("app_admin", null, "select private.run_retention() r")).rows[0].r;
    if (r?.rule === null || r?.rule === undefined) break;
  }
  expect((await su("select count(*)::int n from candidate_user where id = any($1)", [people])).rows[0].n).toBe(3);
});

// =====================================================================================================================
// M1: app_admin cannot change the email of a staff login that holds a role
const setEmail = (role: Role, who: string) => run(role, role === "app_admin" ? A : null, "update staff_user set email=$2 where id=$1", [who, `${uid("m")}@example.test`]);

test("M1 must not: app_admin changes the email of a login that holds a role", async () => {
  await rule({ refuse: () => setEmail("app_admin", B), expect: "email of a login that holds a role" });
  await rule({ refuse: () => setEmail("app_admin", T), expect: "email of a login that holds a role" });
});
test("M1 must do: the email of a login with no role, or after its roles are removed", async () => {
  const none = await staff();
  await rule({ ok: () => setEmail("app_admin", none) });
  const x = await staff("content_editor");
  await rule({ refuse: () => setEmail("app_admin", x), expect: "email of a login that holds a role" });
  await run("app_admin", A, "delete from staff_role where staff_user_id=$1", [x]);
  await rule({ ok: () => setEmail("app_admin", x) });
});
test("M1 must do: app_admin still changes a role holder's name; portal_owner may change the email", async () => {
  await rule({ ok: () => run("app_admin", A, "update staff_user set name='Renamed', email=email where id=$1", [B]) });
  await rule({ ok: () => setEmail("portal_owner", B) });
});
test("M1 still: a disabled login that holds a role is not turned back on (the rule M1 extends)", async () => {
  const x = await staff("administrator", "disabled");
  await rule({ refuse: () => run("app_admin", A, "update staff_user set status='active' where id=$1", [x]), expect: "disabled login" });
});

// =====================================================================================================================
// M3: each app role writes audit rows only about its own side, with at = now()
const audit = (role: Role, staffId: string | null, cols: Record<string, unknown>) => {
  const k = Object.keys(cols);
  return run(role, staffId, `insert into audit_event(${k.join(",")}) values(${k.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(cols));
};
const base = (extra: Record<string, unknown> = {}) => ({ kind: "security", action: uid("a"), ...extra });

test("M3 must not: app_candidate names a staff, portal or system actor, or writes admin_action (the probe's row included)", async () => {
  for (const extra of [{ actor_staff_user_id: A }, { actor_portal_user_id: "p" }, { actor_system: "x" }, { kind: "admin_action" }])
    await rule({ refuse: () => audit("app_candidate", null, base(extra)), expect: "audit_event: " });
  await rule({ refuse: () => audit("app_candidate", null, { at: "2025-01-01", kind: "admin_action", actor_staff_user_id: A, role_in_force: "administrator", action: "candidate.erase", object_type: "candidate_user", object_id: "someone", source: "panel" }), expect: "audit_event: " });
});
test("M3 must not: app_portal names a staff, candidate or system actor, or writes admin_action", async () => {
  for (const extra of [{ actor_staff_user_id: A }, { actor_candidate_user_id: "c" }, { actor_system: "x" }, { kind: "admin_action" }])
    await rule({ refuse: () => audit("app_portal", null, base(extra)), expect: "audit_event: " });
});
test("M3 must not: app_fetcher names a staff, candidate or portal actor", async () => {
  for (const extra of [{ actor_staff_user_id: A }, { actor_candidate_user_id: "c" }, { actor_portal_user_id: "p" }])
    await rule({ refuse: () => audit("app_fetcher", null, base(extra)), expect: "audit_event: " });
});
test("M3 must not: app_admin names a candidate or portal actor, or a staff actor other than the acting id", async () => {
  for (const extra of [{ actor_candidate_user_id: "c" }, { actor_portal_user_id: "p" }])
    await rule({ refuse: () => audit("app_admin", A, base(extra)), expect: "audit_event: " });
  await rule({ refuse: () => audit("app_admin", A, base({ actor_staff_user_id: B })), expect: "acting staff id" });
  await rule({ refuse: () => audit("app_admin", null, base({ actor_staff_user_id: B })), expect: "acting staff id" });
});
test("M3 must do: one row per role about its own side, and `at` is now() whatever was sent", async () => {
  const rows: [Role, string | null, Record<string, unknown>][] = [
    ["app_candidate", null, { actor_candidate_user_id: "c" }],
    ["app_portal", null, { actor_portal_user_id: "p" }],
    ["app_fetcher", null, { kind: "admin_action", actor_system: "fetch run 1" }],
    ["app_admin", A, { kind: "admin_action", actor_staff_user_id: A }],
    ["app_admin", null, { actor_system: "admin job" }],
  ];
  for (const [role, who, extra] of rows) {
    const b = base({ at: "2025-01-01", ...extra });
    await rule({ ok: () => audit(role, who, b) });
    expect(near((await su("select at from audit_event where action=$1", [b.action])).rows[0].at), `${role} chose at`).toBe(true);
  }
});
test("M3 must do: the erase functions and run_retention still write their rows (owner's rights)", async () => {
  const n = async (action: string) => (await su("select count(*)::int n from audit_event where action=$1", [action])).rows[0].n as number;
  const before = [await n("candidate.erase"), await n("portal_user.erase"), await n("retention.run")];
  expect((await run("app_admin", A, "select private.erase_candidate($1, true) r", [await cand()])).rows[0].r.erased).toBe(true);
  expect((await run("app_admin", A, "select private.erase_portal_user($1, true) r", [await portalUser()])).rows[0].r.erased).toBe(true);
  // an unverified login 30 days old is due under unverified_account (7 days)
  const u = uid("c"); await su("insert into candidate_user(id,name,email,email_verified,created_at,updated_at) values($1,'Fake',$2,false,now() - interval '30 days',now())", [u, `${u}@example.test`]);
  await run("app_admin", null, "select private.run_retention()");
  expect(await n("candidate.erase")).toBeGreaterThanOrEqual(before[0]! + 2);
  expect([await n("portal_user.erase"), await n("retention.run")]).toEqual([before[1]! + 1, before[2]! + 1]);
});

// =====================================================================================================================
// M4: app roles queue email only to their own side, as new pending rows, and their dedupe keys never meet another role's
const email = (role: Role, cols: Record<string, unknown>, conflict = false) => {
  const k = Object.keys(cols);
  return run(role, role === "app_admin" ? A : null, `insert into email_outbox(${k.join(",")}) values(${k.map((_, i) => `$${i + 1}`).join(",")})${conflict ? " on conflict (dedupe_key) do nothing" : ""}`, Object.values(cols));
};
const own: Record<string, Record<string, unknown>> = {
  app_candidate: { candidate_user_id: "c" }, app_portal: { portal_user_id: "p" }, app_fetcher: { candidate_user_id: "c" }, app_admin: { staff_user_id: "s" },
};
const roles4 = ["app_candidate", "app_portal", "app_fetcher", "app_admin"] as const;
const keyCount = async (k: string) => (await su("select count(*)::int n from email_outbox where dedupe_key=$1", [k])).rows[0].n as number;

test("M4 must not: an app role queues a row that is not new (sent, attempts set, sent_at set), the probe's 'sent' row included", async () => {
  for (const r of roles4)
    for (const extra of [{ status: "sent", sent_at: new Date() }, { status: "sending" }, { attempts: 1 }, { sent_at: new Date() }])
      await rule({ refuse: () => email(r, { template: "t", ...own[r], ...extra }), expect: "email_outbox: " });
});
test("M4 must not: an app role queues email to another side (the probe's staff password_reset included)", async () => {
  const bad: [Role, Record<string, unknown>][] = [
    ["app_candidate", { template: "password_reset", staff_user_id: B, params: { link: "https://example.test/not-ours" } }],
    ["app_candidate", { portal_user_id: "p" }], ["app_candidate", { membership_id: 1 }], ["app_candidate", { contact_message_id: 1 }],
    ["app_portal", { candidate_user_id: "c" }], ["app_portal", { staff_user_id: "s" }], ["app_portal", { contact_message_id: 1 }],
    ["app_fetcher", { staff_user_id: "s" }], ["app_fetcher", { portal_user_id: "p" }], ["app_fetcher", { membership_id: 1 }], ["app_fetcher", { contact_message_id: 1 }],
  ];
  for (const [r, cols] of bad) await rule({ refuse: () => email(r, { template: "t", ...cols }), expect: "email_outbox: " });
});
test("M4 must do: each role queues email to its own side", async () => {
  const good: [Role, Record<string, unknown>][] = [
    ["app_candidate", { candidate_user_id: "c" }], ["app_portal", { portal_user_id: "p" }], ["app_portal", { membership_id: 1 }], ["app_fetcher", { candidate_user_id: "c" }],
    ["app_admin", { staff_user_id: "s" }], ["app_admin", { contact_message_id: 1 }], ["app_admin", { candidate_user_id: "c" }], ["app_admin", { portal_user_id: "p" }],
  ];
  for (const [r, cols] of good) await rule({ ok: () => email(r, { template: "t", ...cols }) });
});
test("M4 must do: on conflict do nothing still makes one row for one key from one role; the same key from two roles makes two", async () => {
  const k = uid("dk");
  for (let i = 0; i < 2; i++) await email("app_candidate", { template: "t", candidate_user_id: "c", dedupe_key: k }, true);
  expect(await keyCount(`app_candidate:${k}`)).toBe(1);
  await email("app_portal", { template: "t", portal_user_id: "p", dedupe_key: k }, true);
  expect(await keyCount(`app_portal:${k}`)).toBe(1);
  expect(await keyCount(k)).toBe(0);
});
test("M4 must not: a key taken by app_candidate (even spelt with another role's prefix) stops app_admin's email (the probe's M4c)", async () => {
  const k = uid("dk");
  await email("app_candidate", { template: "x", candidate_user_id: "c", dedupe_key: k });
  await email("app_candidate", { template: "x", candidate_user_id: "c", dedupe_key: `app_admin:${k}` });
  await email("app_admin", { template: "strike_notice", portal_user_id: "p-1", dedupe_key: k }, true);
  expect((await su("select template from email_outbox where dedupe_key=$1", [`app_admin:${k}`])).rows).toEqual([{ template: "strike_notice" }]);
});
test("M4 must do: rows written with the owner's rights keep their key as it is", async () => {
  const k = uid("dk");
  await run("portal_owner", null, "insert into email_outbox(template,candidate_user_id,dedupe_key,status,sent_at) values('t','c',$1,'sent',now())", [k]);
  expect(await keyCount(k)).toBe(1);
});

// notification: the same prefix, through the two views as well
const notice = (role: Role, into: string, who: string, k: string) =>
  run(role, null, `insert into ${into}(${who.startsWith("p_") ? "portal_user_id" : "candidate_user_id"},category,template_key,dedupe_key) values($1,'a','t',$2) on conflict (dedupe_key) do nothing`, [who, k]);
const noticeKeys = async (k: string) => (await su("select dedupe_key from notification where dedupe_key like '%' || $1 order by dedupe_key", [k])).rows.map((r) => r.dedupe_key);

test("M4 must do: a notice key is prefixed with the role that wrote it, through the views too (current_user inside the trigger is the app role)", async () => {
  const c = await cand(), p = await portalUser(), k = uid("dk");
  await notice("app_candidate", "candidate_notification", c, k);
  await notice("app_candidate", "candidate_notification", c, k); // on conflict through the view: still one row
  await notice("app_portal", "portal_notification", p, k);
  await notice("app_fetcher", "notification", c, k);
  await notice("app_admin", "notification", p, k);
  await run("portal_owner", null, "insert into notification(candidate_user_id,category,template_key,dedupe_key) values($1,'a','t',$2)", [c, k]);
  expect(await noticeKeys(k)).toEqual([k, `app_admin:${k}`, `app_candidate:${k}`, `app_fetcher:${k}`, `app_portal:${k}`].sort());
});

// =====================================================================================================================
// Budget: the outbox, notification and audit triggers sit on every insert, so 1,000 rows of each stay cheap
test("budget: 1,000 email_outbox and 1,000 audit_event rows inserted as app_candidate in under 2 s together", async () => {
  const t = Date.now();
  await run("app_candidate", null, "insert into email_outbox(template,candidate_user_id,dedupe_key) select 't','c', md5(random()::text) from generate_series(1,1000)");
  await run("app_candidate", null, "insert into audit_event(kind,action,actor_candidate_user_id) select 'security','signin_failed','c' from generate_series(1,1000)");
  expect(Date.now() - t).toBeLessThan(2000);
});
