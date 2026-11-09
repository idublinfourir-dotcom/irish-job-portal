// Five rules written into the design after the trial (#137 a, b, c, Fix 6 PICK 4, C2 5 narrowed). Every action runs as the real role;
// fixtures are inserted as postgres. One "must do" and one "must not" per rule, plus the NULL cases.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, rule, tx, type Role, type TestDb } from "./db";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());

const uid = (p: string) => `${p}_${randomBytes(5).toString("hex")}`;
const su = (sql: string, args?: unknown[]) => db.query("postgres", sql, args);
// One transaction as `role` with the acting staff id set local (null leaves it unset).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const as = <T>(role: Role, staff: string | null, fn: (q: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<T>) =>
  tx(db.pool(role), async (c) => {
    if (staff !== null) await c.query("select set_config('app.staff_user_id', $1, true)", [staff]);
    return fn((s, a) => c.query(s, a));
  });
const run = (role: Role, staff: string | null, sql: string, args?: unknown[]) => as(role, staff, (q) => q(sql, args));

async function staff(role?: string, status = "active") {
  const i = uid("s");
  await su("insert into staff_user(id,name,email,email_verified,status) values($1,'Staff',$2,true,'active')", [i, `${i}@example.test`]);
  if (role) await su("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,$2,true)", [i, role]);
  if (status !== "active") await su("update staff_user set status=$2 where id=$1", [i, status]);
  return i;
}
const org = async () => (await su("insert into organisation(slug,display_name,kind,status) values($1,'Org','employer','verified') returning id", [uid("org")])).rows[0].id as string;
const propose = async (kind: string, table: string, target: string, by: string) =>
  (await run("app_admin", by, "insert into approval_request(kind,target_table,target_id) values($1,$2,$3) returning id", [kind, table, target])).rows[0].id as string;
const confirm = (rid: string, by: string | null) => run("app_admin", by, "update approval_request set status='confirmed' where id=$1", [rid]);
const mkStrike = async (o: string, by: string) =>
  (await run("app_admin", by, "insert into strike(organisation_id,case_kind,reason_code,stage,appeal_due_at) values($1,'false_claim','false_sponsorship','decided',now()+interval '6 days') returning id", [o])).rows[0].id as string;

let A: string, B: string, T: string;
beforeAll(async () => { A = await staff("administrator"); B = await staff("administrator"); T = await staff("trust_and_safety"); });

// ---- (a) #137 a: a ban covers only domains the organisation had when its case opened
// Strike 3 and its ban in one transaction, as the two-person tests do. The domain row is backdated as postgres.
async function banByDomain(domainAgeDays: number | "after") {
  const o = await org();
  const dom = `${uid("d")}.ie`;
  if (domainAgeDays !== "after") await su("insert into organisation_domain(organisation_id,domain,source,created_at) values($1,$2,'seed',now() - make_interval(days => $3))", [o, dom, domainAgeDays]);
  const st = await mkStrike(o, A);
  if (domainAgeDays === "after") await run("app_admin", A, "insert into organisation_domain(organisation_id,domain,source,added_by_staff_id) values($1,$2,'admin',$3)", [o, dom, A]);
  const rq = await propose("strike_3", "strike", st, A);
  await confirm(rq, T);
  return as("app_admin", A, async (q) => {
    await q("update strike set outcome='strike', level=3, approval_request_id=$2 where id=$1", [st, rq]);
    await q("insert into ban(email_domain, reason_code, strike_id, approval_request_id) values ($1,'strike_3',$2,$3)", [dom, st, rq]);
    await q("update organisation set claims_removed_at = now() where id=$1", [o]);
    await q("update organisation set status='banned' where id=$1", [o]);
  });
}

test("(a) must do: a ban names a domain the organisation had before the case opened", async () => {
  await rule({ ok: () => banByDomain(1) });
});
test("(a) must not: a ban names a domain added after the case opened", async () => {
  await rule({ refuse: () => banByDomain("after"), expect: "email_domain" });
});
test("(a) must do: app_admin adds a domain alone, and created_at defaults to now()", async () => {
  const o = await org();
  const r = await run("app_admin", null, "insert into organisation_domain(organisation_id,domain,source) values($1,$2,'admin') returning created_at", [o, `${uid("d")}.ie`]);
  expect(Math.abs(new Date(r.rows[0].created_at).getTime() - Date.now())).toBeLessThan(5000);
});
test("(a) must not: app_admin writes created_at on organisation_domain or strike", async () => {
  const o = await org();
  await rule({ refuse: () => run("app_admin", null, "insert into organisation_domain(organisation_id,domain,source,created_at) values($1,'x.ie','admin',now() - interval '1 year')", [o]), expect: "permission denied" });
  await rule({ refuse: () => run("app_admin", null, "update organisation_domain set created_at = now() - interval '1 year'"), expect: "permission denied" });
  await rule({ refuse: () => run("app_admin", A, "insert into strike(organisation_id,case_kind,reason_code,created_at) values($1,'false_claim','false_sponsorship',now())", [o]), expect: "permission denied" });
  await rule({ refuse: () => run("app_admin", A, "update strike set created_at = now() + interval '1 year'"), expect: "permission denied" });
});
test("(a) must not: created_at is NULL on organisation_domain or strike, even as postgres", async () => {
  const o = await org();
  await rule({ refuse: () => su("insert into organisation_domain(organisation_id,domain,source,created_at) values($1,'n.ie','seed',null)", [o]), expect: "23502" });
  await rule({ refuse: () => su("insert into strike(organisation_id,case_kind,reason_code,created_at) values($1,'false_claim','false_sponsorship',null)", [o]), expect: "23502" });
});

// ---- (b) #137 b: the confirmer must hold the role that covers the kind
test("(b) must do: trust_and_safety confirms strike_2; administrator confirms threshold and grant_role", async () => {
  const s2 = await propose("strike_2", "strike", uid("t"), A);
  await rule({ ok: () => confirm(s2, T) });
  const th = await propose("threshold", "rule", uid("t"), T);
  await rule({ ok: () => confirm(th, A) });
  const gr = await propose("grant_role", "staff_role", uid("t"), A);
  await rule({ ok: () => confirm(gr, B) });
});
test("(b) must not: administrator confirms strike_2, strike_3, ban or ban_lift; trust_and_safety confirms threshold", async () => {
  for (const kind of ["strike_2", "strike_3", "ban", "ban_lift"]) {
    const r = await propose(kind, "strike", uid("t"), T);
    await rule({ refuse: () => confirm(r, A), expect: "role that covers" });
  }
  const th = await propose("threshold", "rule", uid("t"), A);
  await rule({ refuse: () => confirm(th, T), expect: "role that covers" });
});
test("(b) must do: refusing still needs only some role (an administrator refuses a strike_2)", async () => {
  const r = await propose("strike_2", "strike", uid("t"), T);
  await rule({ ok: () => run("app_admin", A, "update approval_request set status='refused' where id=$1", [r]) });
});
test("(b) must not: a confirmation with no acting id or an empty one", async () => {
  const r = await propose("strike_2", "strike", uid("t"), A);
  await rule({ refuse: () => confirm(r, null), expect: "acting staff" });
  await rule({ refuse: () => confirm(r, ""), expect: "acting staff" });
});

// ---- (c) #137 c: removing a staff role is one person's act
test("(c) must do: app_admin removes a staff role alone, with no request", async () => {
  const x = await staff("content_editor");
  const r = await run("app_admin", A, "delete from staff_role where staff_user_id=$1", [x]);
  expect(r.rowCount).toBe(1);
});
test("(c) must not: a trigger guards the staff_role delete", async () => {
  const r = await su("select tgname from pg_trigger where tgrelid = 'staff_role'::regclass and not tgisinternal and (tgtype & 8) <> 0");
  expect(r.rows).toEqual([]);
});

// ---- Fix 6 PICK 4: withdrawing a request needs an acting staff id
test("(c) must do: the proposer withdraws a request with the acting id set", async () => {
  const r = await propose("threshold", "rule", uid("t"), A);
  await rule({ ok: () => run("app_admin", A, "update approval_request set status='withdrawn' where id=$1", [r]) });
});
test("(c) must not: a withdraw with no acting id, an empty one, or a disabled login's", async () => {
  const r = await propose("threshold", "rule", uid("t"), A);
  const gone = await staff("administrator", "disabled");
  for (const who of [null, "", gone, "no_such_staff"])
    await rule({ refuse: () => run("app_admin", who, "update approval_request set status='withdrawn' where id=$1", [r]), expect: "acting staff" });
});

// ---- C2 5 narrowed: re-enabling a disabled login is refused only when it holds a role
test("(c) must do: app_admin turns on a disabled login that holds no role", async () => {
  const x = await staff(undefined, "disabled");
  await rule({ ok: () => run("app_admin", A, "update staff_user set status='active' where id=$1", [x]) });
});
test("(c) must not: app_admin turns on a disabled login that holds a role (staff_user.status is NOT NULL, so no NULL case)", async () => {
  const x = await staff("administrator", "disabled");
  await rule({ refuse: () => run("app_admin", A, "update staff_user set status='active' where id=$1", [x]), expect: "disabled login" });
});
