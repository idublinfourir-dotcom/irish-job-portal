// Audit row R1: a staff member downloads their own data (GET /api/staff/me/export), through the admin app's real route handler on the real test database as
// app_admin, with real staff sessions. Every staff role is tried, plus no login, a disabled login and the other pools' cookies. Fake people only, no network.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { BASE, counted, median, oneOfEachRole, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";
import { exportFilename } from "../src/candidate";

// Measured on 18 November 2026 with 200 audit rows and 50 review items for the member: 6 statements (the session read 2, begin, the acting id, the export,
// commit), median 7.9 ms. The time budget is about 4 times the measure; pages are in perf/self-service.perf.ts. Raise these only on purpose.
const BUDGET = { statements: 6, medianMs: 30 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
let db: TestDb;
let h: Awaited<ReturnType<typeof staffHarness>>;
let R: Route;
const PATH = "/api/staff/me/export";

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  R = await import("../../../apps/admin/app/api/staff/me/export/route");
  await h.makeStaff("me", ["account_reviewer"]);
  await h.makeStaff("other", ["administrator"]);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

async function raw(cookie?: string, query = "") {
  const res = await R.GET(new Request(`${BASE}${PATH}${query}`, { headers: cookie ? { cookie } : {} }));
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text), headers: res.headers };
}

describe("staff: download my data", () => {
  it("holds the member's own account, roles, actions, claims and decisions as ids and codes; nothing of another staff member; one audit row", async () => {
    const me = h.staff.me!, other = h.staff.other!;
    await h.su.query("insert into review_item(queue, status, claimed_by_staff_user_id, claimed_at, decided_by_staff_user_id, decided_at, outcome, reason, detail) values ('scheduled_check', 'done', $1, now(), $2, now(), 'approved', 'secret reason text', '{\"evidence\":\"secret evidence\"}')", [me, other]);
    await h.su.query("insert into review_item(queue, status, claimed_by_staff_user_id, claimed_at) values ('scheduled_check', 'claimed', $1, now())", [other]);
    await h.su.query("insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, reason_text, before, source) values ('admin_action', $1, 'fake.mine', 'job', '1', 'private words', '{\"x\":1}', 'panel'), ('admin_action', $2, 'fake.theirs', 'job', '2', null, null, 'panel')", [me, other]);
    const r = await raw(h.signedIn("me"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-disposition")).toBe(`attachment; filename="${exportFilename(new Date())}"`);
    const d = r.json;
    expect(d.account).toMatchObject({ email: "me@example.test", status: "active", signInMethods: ["credential"] });
    expect(d.roles).toEqual([{ role: "account_reviewer", seededByOwner: true }]);
    expect(d.yourActions.map((a: { action: string }) => a.action)).toEqual(["fake.mine"]); // this export's own row shows in the next one (same snapshot)
    expect(d.reviewItems).toEqual([expect.objectContaining({ queue: "scheduled_check", status: "done", outcome: "approved", decidedAt: null })]);
    expect(d.reviewItems[0].claimedAt).toBeTruthy();
    for (const k of ["approvalRequests", "reportsDecided", "strikesDecided", "contactMessagesClaimed", "casesAssigned", "caseNotesWritten"]) expect(d[k]).toEqual([]);
    for (const x of [other, "other@example.test", "fake.theirs", "secret reason text", "secret evidence", "private words"]) expect(r.text).not.toContain(x);
    expect(r.text).not.toMatch(/token|password/i);
    expect((await h.su.query("select count(*)::int n from audit_event where actor_staff_user_id = $1 and action = 'staff.export'", [me])).rows[0].n).toBe(1);
  });

  it("every staff role exports its own data, and only its own", async () => {
    await oneOfEachRole(h);
    for (const role of ROLE_NAMES) {
      const r = await raw(h.signedIn(`only_${role}`));
      expect([r.status, r.json.account.email, r.json.roles]).toEqual([200, `only_${role}@example.test`, [{ role, seededByOwner: true }]]);
    }
  });

  it(`within ${BUDGET.statements} statements and ${BUDGET.medianMs} ms median, for a member with 200 audit rows and 50 review items`, async () => {
    await h.makeStaff("busy", ["fetched_job_reviewer"]);
    const busy = h.staff.busy!;
    await h.su.query("insert into audit_event(kind, actor_staff_user_id, action, source) select 'admin_action', $1, 'fake.action', 'panel' from generate_series(1, 200)", [busy]);
    await h.su.query("insert into review_item(queue, status, claimed_by_staff_user_id, claimed_at) select 'scheduled_check', 'dropped', $1, now() from generate_series(1, 50)", [busy]);
    const [r, statements] = await counted(() => raw(h.signedIn("busy")));
    expect(r.json.reviewItems).toHaveLength(50);
    const ms = await median(() => raw(h.signedIn("busy")));
    console.log(`staff export: ${statements} statements, median ${ms.toFixed(1)} ms`);
    expect(statements).toBeLessThanOrEqual(BUDGET.statements);
    expect(ms).toBeLessThan(BUDGET.medianMs);
  });
});

describe("security", () => {
  it("no login, a forged cookie and the other pools' cookie names are 401; a disabled login is 401; a query string is refused", async () => {
    for (const c of [undefined, "staff.session_token=forged.token", "portal.session_token=x", "candidate.session_token=x"]) expect((await raw(c)).json.error).toBe("no_session");
    await h.makeStaff("gone", ["content_editor"]);
    await h.su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.gone]);
    expect((await raw(h.signedIn("gone"))).status).toBe(401);
    // the id comes from the session only: naming another member is a bad query, not their data
    expect([(await raw(h.signedIn("me"), `?staff=${h.staff.other}`)).status, (await raw(h.signedIn("me"), "?id=x")).json.error]).toEqual([400, "bad_query"]);
  });

  it("staff cannot delete their own login: the route has GET only", () => {
    expect(Object.keys(R).filter((k) => /^(POST|PUT|PATCH|DELETE)$/.test(k))).toEqual([]);
  });
});
