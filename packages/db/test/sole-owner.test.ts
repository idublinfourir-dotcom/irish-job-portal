/* eslint-disable @typescript-eslint/no-explicit-any */
// Step 15 Q2 gap round: no erase leaves an open company with no owner (migration 0050). The shared erase_portal_user refuses the only active owner of an
// open company (close_company_first); the daily retention run leaves such a login out and writes one reminder for administrators per company and
// month, read through the real /api/scheduled-checks handler. Real test database, the real retention loop (retention-cli.ts drain) as app_admin.
// No network. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { memoryStore } from "../src/file-store";
import { drain } from "../src/retention-cli";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { costOf } from "./perf/pages";
import { staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 180000, hookTimeout: 120000 });

// One retention call that leaves out 2,000 deleted sole owners of open companies and writes their 2,000 reminders (as app_admin, rolled back):
// measured 19 Nov 2026 at 149,381 pages and 167 to 171 ms (mostly the 2,000 inserts and their index entries); limits about 2 times that.
const BUDGET = { pages: 300_000, ms: 500 };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, su: pg.Pool;
let F: any;
const rows = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows;
const exists = async (id: string) => (await su.query("select 1 from portal_user where id = $1", [id])).rowCount === 1;
const run = async () => {
  const c = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
  await c.connect();
  const lines: string[] = [];
  try { return { code: await drain(c, (l) => lines.push(l), undefined, undefined, () => memoryStore()), lines }; } finally { await c.end(); }
};
/** A portal login deleted 40 days ago (past the 30-day grace, rule 9), owner of a new company with this status. */
async function deletedOwner(status: string, member = false) {
  const p = await F.portal(), org = await F.org({ status });
  await F.member(org, p, { role: "account_owner", signer: true });
  if (member) await F.member(org, await F.portal());
  await su.query("update portal_user set deleted_at = now() - interval '40 days' where id = $1", [p]);
  return { p, org };
}
const reminders = (org: string) => rows("select reason, detail, status from review_item where queue = 'scheduled_check' and detail->>'organisationId' = $1", [org]);

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  ({ F } = fixtures(db) as any);
  route = (await import("../../../apps/admin/app/api/scheduled-checks/route")) as unknown as Route;
  await h.makeStaff("ad1", ["administrator"]);
  await h.makeStaff("re1", ["rules_data_editor"]);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("the shared erase refuses the only active owner of an open company", () => {
  it("erase_portal_user returns close_company_first and changes nothing; a closed company's sole owner and a lone member are erased", async () => {
    const { p, org } = await deletedOwner("verified");
    const admin = db.pool("app_admin");
    expect((await admin.query("select private.erase_portal_user($1, true) r", [p])).rows[0].r).toEqual({ erased: false, reason: "close_company_first" });
    expect([await exists(p), (await rows("select status from membership where organisation_id = $1", [org]))[0].status]).toEqual([true, "active"]);
    const closed = await deletedOwner("closed");
    expect((await admin.query("select private.erase_portal_user($1, true) r", [closed.p])).rows[0].r.erased).toBe(true);
    const lone = await F.portal(), o2 = await F.org();
    await F.member(o2, lone, { role: "recruiter" });
    expect((await admin.query("select private.erase_portal_user($1, true) r", [lone])).rows[0].r.erased).toBe(true);
  });
});

describe("the retention run leaves such a login for staff", () => {
  let sole: { p: string; org: string }, closed: { p: string; org: string }, shared: { p: string; org: string };
  beforeAll(async () => {
    sole = await deletedOwner("verified");
    closed = await deletedOwner("closed");
    shared = await deletedOwner("pending_review", true);
  });
  it("erases the closed company's owner, leaves the sole owner and the owner with members, ends green, one reminder per open company", async () => {
    const r = await run();
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect([await exists(sole.p), await exists(closed.p), await exists(shared.p)]).toEqual([true, false, true]);
    expect(await reminders(sole.org)).toEqual([{ reason: "sole_owner_retention", status: "open",
      detail: { role: "administrator", organisationId: sole.org, key: expect.stringMatching(new RegExp(`^sole_owner_retention:${sole.org}:\\d{4}-\\d{2}$`)) } }]);
    expect(await reminders(shared.org)).toEqual([]); // an owner with members is reassigned through /api/companies/owner-reassign, as before
    expect((await run()).code).toBe(0);
    expect(await reminders(sole.org)).toHaveLength(1); // a second run the same month writes nothing more
  });
  it("administrators see the reminder at /api/scheduled-checks; a rules data editor does not", async () => {
    const mine = (j: any) => j.items.filter((x: any) => x.detail.organisationId === sole.org);
    expect(mine(await h.ok(h.call(route, "/api/scheduled-checks", "ad1")))).toHaveLength(1);
    expect(mine(await h.ok(h.call(route, "/api/scheduled-checks", "re1")))).toHaveLength(0);
  });
  it("once the company is closed, the next run erases the login", async () => {
    await su.query("update organisation set status = 'closed' where id = $1", [sole.org]);
    expect((await run()).code).toBe(0);
    expect(await exists(sole.p)).toBe(false);
  });
});

describe("performance", () => {
  it("pages and time of one retention call leaving out 2,000 sole owners", async () => {
    await su.query("insert into portal_user(id, name, email, email_verified, created_at, updated_at, deleted_at) select 'so-' || g, 'Fake', 'so-' || g || '@example.test', true, now(), now(), now() - interval '40 days' from generate_series(1, 2000) g");
    await su.query("insert into organisation(slug, display_name, kind, status) select 'so-org-' || g, 'Fake Org', 'employer', 'verified' from generate_series(1, 2000) g");
    await su.query("insert into membership(organisation_id, portal_user_id, role, status, is_signer) select o.id, 'so-' || substr(o.slug, 8), 'account_owner', 'active', true from organisation o where o.slug like 'so-org-%'");
    await su.query("analyze");
    const c = await db.pool("app_admin").connect();
    const measure = async () => {
      await c.query("begin");
      try {
        const plan = (await c.query("explain (analyze, buffers, format json) select private.run_retention(1000)")).rows[0]["QUERY PLAN"];
        expect((await c.query("select count(*)::int n from review_item where reason = 'sole_owner_retention'")).rows[0].n).toBeGreaterThanOrEqual(2000);
        return costOf("run_retention", plan);
      } finally { await c.query("rollback"); }
    };
    try {
      await measure(); // warm
      const cost = await measure();
      console.log(`retention with 2,000 sole owners left out: ${cost.pages} pages, ${cost.ms} ms`);
      expect(cost.pages).toBeLessThanOrEqual(BUDGET.pages);
      expect(cost.ms).toBeLessThanOrEqual(BUDGET.ms);
    } finally { c.release(); }
  });
});
