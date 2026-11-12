// Step 8 live proof (a): the role grant command, run for real as app_admin on the test database (the two-person rule, the audit row,
// safe re-run, every refusal writing nothing). Fake people only; no network.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { grantRole } from "../src/role-grant-cli";
import { TS_ACT } from "../src/trust-safety";

// Budget for one grant: begin, lookup, role check, 2 set_config, request insert, confirm, role insert, audit insert, commit = 10 statements;
// budget 10. Time: a grant took about 15 ms here; budget 500 ms for one command's transaction on the shared test database.
const BUDGET = { statements: 10, ms: 500 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const CLI = fileURLToPath(new URL("../src/role-grant-cli.ts", import.meta.url));
let db: TestDb, su: pg.Pool;
beforeAll(async () => { db = await createTestDb(); su = db.pool("postgres"); });
afterAll(async () => { await db.drop(); });

const run = (args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" } });
const count = async (sql: string, args: unknown[] = []) => (await su.query(`select count(*)::int n from (${sql}) t`, args)).rows[0].n as number;
let n = 0;
async function staff(role: string | null, status = "active") {
  const id = `rg-${n++}-${Math.random().toString(36).slice(2, 8)}`, email = `${id}@example.test`;
  await su.query("insert into staff_user(id,name,email,email_verified,status) values($1,'Fake Staff',$2,true,$3)", [id, email, status]);
  if (role) await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,$2,true)", [id, role]);
  return { id, email };
}
const everything = async () => [await count("select 1 from approval_request"), await count("select 1 from staff_role"), await count("select 1 from audit_event where action='staff.role_grant'")];
async function refused(args: string[], re: RegExp) {
  const before = await everything();
  const r = run(args);
  expect(r.status, r.stdout).toBe(1);
  expect(r.stdout).toMatch(re);
  expect(await everything()).toEqual(before);
}

describe("role grant command", () => {
  it("grants a role: role row, confirmed and applied request, one audit row", async () => {
    const [p, c, t] = [await staff("content_editor"), await staff("administrator"), await staff(null)];
    const r = run([p.email.toUpperCase(), c.email, t.email, "trust_and_safety"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/granted trust_and_safety to .* \(approval request \d+\)/);
    expect(r.stdout).not.toMatch(/postgres:\/\//);
    const role = (await su.query("select * from staff_role where staff_user_id=$1", [t.id])).rows[0];
    expect(role).toMatchObject({ role: "trust_and_safety", granted_by_staff_user_id: c.id, seeded_by_owner: false });
    const req = (await su.query("select * from approval_request where id=$1", [role.approval_request_id])).rows[0];
    expect(req).toMatchObject({ kind: "grant_role", target_table: "staff_role", target_id: t.id, change: { role: "trust_and_safety" }, status: "confirmed", proposed_by_staff_user_id: p.id, confirmed_by_staff_user_id: c.id });
    expect(req.applied_at).not.toBeNull();
    const a = (await su.query("select * from audit_event where action='staff.role_grant' and object_id=$1", [String(role.id)])).rows;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: "admin_action", actor_staff_user_id: c.id, second_staff_user_id: p.id, object_type: "staff_role", source: "panel", after: { role: "trust_and_safety", approvalRequestId: String(req.id) } });
    // the role is usable: the trust and safety check passes for the new holder
    const ts = (await su.query(TS_ACT, [t.id])).rows[0];
    expect(ts).toMatchObject({ active: true, ts: true });
  });
  it("a second run writes nothing and exits 0", async () => {
    const [p, c, t] = [await staff("content_editor"), await staff("administrator"), await staff(null)];
    expect(run([p.email, c.email, t.email, "content_editor"]).status).toBe(0);
    const before = await everything();
    const r = run([p.email, c.email, t.email, "content_editor"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/already holds/);
    expect(await everything()).toEqual(before);
  });
  it("granting administrator uses grant_administrator", async () => {
    const [p, c, t] = [await staff("content_editor"), await staff("administrator"), await staff("content_editor")];
    expect(run([p.email, c.email, t.email, "administrator"]).status).toBe(0);
    const k = await su.query("select r.kind from approval_request r join staff_role s on s.approval_request_id=r.id where s.staff_user_id=$1 and s.role='administrator'", [t.id]);
    expect(k.rows[0].kind).toBe("grant_administrator");
  });
  it("refuses a confirmer without administrator, a proposer with no role, and inactive proposer or confirmer; nothing is written", async () => {
    const t = await staff(null), admin = await staff("administrator"), editor = await staff("content_editor");
    const norole = await staff(null), offP = await staff("content_editor", "disabled"), offC = await staff("administrator", "disabled");
    await refused([editor.email, (await staff("content_editor")).email, t.email, "content_editor"], /^refused: .*confirmer does not hold the role/);
    await refused([norole.email, admin.email, t.email, "content_editor"], /^refused: .*holds no role/);
    await refused([offP.email, admin.email, t.email, "content_editor"], /^refused: .*no acting staff member/);
    await refused([editor.email, offC.email, t.email, "content_editor"], /^refused: .*no acting staff member/);
    expect(await count("select 1 from staff_role where staff_user_id=$1", [t.id])).toBe(0);
  });
  it("refuses an unknown email, and the same person twice (before connecting)", async () => {
    const [p, c, t] = [await staff("content_editor"), await staff("administrator"), await staff(null)];
    await refused([p.email, c.email, "nobody@example.test", "content_editor"], /^refused: no staff member with the email nobody@example.test/);
    await refused(["ghost@example.test", c.email, t.email, "content_editor"], /^refused: no staff member/);
    const before = await everything();
    const r = run([c.email, c.email, t.email, "content_editor"]);
    expect(r.status).toBe(2);
    expect(await everything()).toEqual(before);
  });
  it("app_admin cannot skip the rule: a direct staff_role insert needs a confirmed request", async () => {
    const [p, t] = [await staff("content_editor"), await staff(null)];
    const direct = async (approval: string | null) => {
      const c = await db.pool("app_admin").connect();
      try {
        await c.query("begin");
        await c.query("select set_config('app.staff_user_id', $1, true)", [p.id]);
        await c.query("insert into staff_role(staff_user_id, role, granted_by_staff_user_id, approval_request_id) values ($1,'content_editor',$2,$3)", [t.id, p.id, approval]);
        await c.query("commit");
        return "accepted";
      } catch (e) { await c.query("rollback").catch(() => {}); return (e as Error).message; } finally { c.release(); }
    };
    expect(await direct(null)).toMatch(/two-person|check constraint/);
    const c2 = await db.pool("app_admin").connect();
    await c2.query("begin");
    await c2.query("select set_config('app.staff_user_id', $1, true)", [p.id]);
    const pending = (await c2.query("insert into approval_request(kind,target_table,target_id,change,reason) values ('grant_role','staff_role',$1,'{\"role\":\"content_editor\"}','x') returning id", [t.id])).rows[0].id;
    await c2.query("commit"); c2.release();
    expect(await direct(pending)).toMatch(/two-person/);
    expect(await count("select 1 from staff_role where staff_user_id=$1", [t.id])).toBe(0);
  });
  it("stays inside the performance budget", async () => {
    const [p, c, t] = [await staff("content_editor"), await staff("administrator"), await staff(null)];
    const client = new pg.Client({ connectionString: urlFor(db.name, "app_admin"), ssl: false });
    await client.connect();
    let calls = 0;
    const q = client.query.bind(client) as (...a: unknown[]) => unknown;
    (client as unknown as { query: unknown }).query = (...a: unknown[]) => { calls++; return q(...a); };
    const t0 = performance.now();
    try { await grantRole(client, { proposer: p.email, confirmer: c.email, staff: t.email, role: "content_editor" }); } finally { await client.end(); }
    expect(calls).toBeLessThanOrEqual(BUDGET.statements);
    expect(performance.now() - t0).toBeLessThan(BUDGET.ms);
  });
});
