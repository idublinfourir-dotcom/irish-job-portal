// C4 (#270) on the admin site: the staff actions that change roles or invite (/api/staff), block or suspend a login (/api/accounts), export
// (/api/staff/me/export) and set or lift a ban (/api/trust-safety/cases decide, confirm, decide_appeal, propose_ban_lift) need a sign-in in the last
// 10 minutes, from every role; "sign out everywhere" ends every staff session at once; staff cannot change their own email. Real route handlers on the
// real test database as app_admin, real staff sessions. Fake people only, no network.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { BASE, counted, median, oneOfEachRole, PW, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

// Measured on 19 November 2026: a stale refusal stops after the session read (2 statements: session, then the user); sign out everywhere reads the session
// and deletes the rows. Measured (two runs): stale 2 statements, 1.6 to 2.5 ms; revoke 6, 2.2 to 2.3 ms (medians of 9 warm calls). Raise only on purpose.
const BUDGET = { stale: 2, revoke: 6, staleMs: 15, revokeMs: 20 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
let db: TestDb;
let h: Awaited<ReturnType<typeof staffHarness>>;
const R = {} as Record<"staff" | "accounts" | "export" | "cases", Route>;

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  R.staff = await import("../../../apps/admin/app/api/staff/route");
  R.accounts = await import("../../../apps/admin/app/api/accounts/route");
  R.export = await import("../../../apps/admin/app/api/staff/me/export/route");
  R.cases = await import("../../../apps/admin/app/api/trust-safety/cases/route");
  await oneOfEachRole(h);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const age = (who: string, sql = "now() - interval '11 minutes'") => h.su.query(`update staff_session set created_at = ${sql} where user_id = $1`, [h.staff[who]]);
const MISSING = "fakeMissingStaffId000000000000000";
// Each sensitive call, with a body that passes the shape check but names nothing real, so a fresh call reaches the role check or a not-found.
const SENSITIVE: [string, keyof typeof R, string, unknown][] = [
  ["propose_role", "staff", "/api/staff", { action: "propose_role", staffId: MISSING, role: "content_editor" }],
  ["invite", "staff", "/api/staff", { action: "invite", email: "fake.invitee@example.test", name: "Fake Person", role: "content_editor" }],
  ["disable", "staff", "/api/staff", { action: "disable", staffId: MISSING }],
  ["block_portal", "accounts", "/api/accounts", { action: "block_portal", userId: MISSING, reason: "fake_reason" }],
  ["suspend_candidate", "accounts", "/api/accounts", { action: "suspend_candidate", userId: MISSING, reason: "fake_reason" }],
  ["export", "export", "/api/staff/me/export", undefined],
  ["decide ban", "cases", "/api/trust-safety/cases", { action: "decide", caseId: "999999999", outcome: "ban" }],
  ["confirm", "cases", "/api/trust-safety/cases", { action: "confirm", caseId: "999999999" }],
  ["decide_appeal", "cases", "/api/trust-safety/cases", { action: "decide_appeal", caseId: "999999999", result: "upheld" }],
  ["propose_ban_lift", "cases", "/api/trust-safety/cases", { action: "propose_ban_lift", caseId: "999999999" }],
];

describe("sensitive staff actions", () => {
  for (const role of ROLE_NAMES)
    it(`${role}: every sensitive action is reauth_required with a stale session, and reaches its normal answer with a fresh one`, async () => {
      const who = `only_${role}`;
      await age(who);
      for (const [name, route, path, body] of SENSITIVE) await h.no(h.call(R[route], path, who, body), 403, "reauth_required").catch((e) => { throw new Error(`${name}: ${e.message}`); });
      await age(who, "now() - interval '9 minutes'");
      for (const [name, route, path, body] of SENSITIVE) {
        const r = await h.call(R[route], path, who, body);
        expect(r.json.error, name).not.toBe("reauth_required");
        if (route === "export") expect(r.status, name).toBe(200);
        if ((route === "staff" || route === "accounts") && role !== "administrator") expect(r.json.error, name).toBe("not_administrator");
        if (route === "cases" && role !== "trust_and_safety") expect(r.json.error, name).toBe("not_trust_and_safety");
      }
    });
  it("signing in again is the re-ask: a new session is fresh", async () => {
    await age("only_administrator");
    await h.no(h.call(R.export, "/api/staff/me/export", "only_administrator"), 403, "reauth_required");
    const res = await h.AUTH(new Request(`${BASE}/api/auth/staff/sign-in/email`, {
      method: "POST", body: JSON.stringify({ email: "only_administrator@example.test", password: PW }), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": "198.51.100.240" } }));
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
    expect((await h.call(R.export, "/api/staff/me/export", null, undefined, { cookie })).status).toBe(200);
  });
  it("the other trust and safety actions and every GET still work with a stale session", async () => {
    await age("only_trust_and_safety");
    const r = await h.call(R.cases, "/api/trust-safety/cases", "only_trust_and_safety", { action: "notify", caseId: "999999999" });
    expect(r.json.error).not.toBe("reauth_required");
    expect((await h.call(R.cases, "/api/trust-safety/cases", "only_trust_and_safety")).status).toBe(200);
    await age("only_administrator");
    expect((await h.call(R.staff, "/api/staff", "only_administrator")).status).toBe(200);
  });
  it("signed out is no_session before the freshness check; a foreign Origin and a bad body on a fresh session are refused as before", async () => {
    for (const [name, route, path, body] of SENSITIVE) await h.no(h.call(R[route], path, null, body), 401, "no_session").catch((e) => { throw new Error(`${name}: ${e.message}`); });
    await age("only_administrator", "now()");
    await h.no(h.call(R.staff, "/api/staff", "only_administrator", { action: "disable", staffId: MISSING }, { origin: "https://evil.example" }), 403, "bad_origin");
    await h.no(h.call(R.accounts, "/api/accounts", "only_administrator", null, { raw: "{" }), 400, "bad_body");
    await h.no(h.call(R.cases, "/api/trust-safety/cases", "only_administrator", { action: "decide", caseId: "x".repeat(500), outcome: "ban" }), 400, "bad_id");
  });
  it(`a stale refusal costs at most ${BUDGET.stale} statements and ${BUDGET.staleMs} ms median`, async () => {
    await age("only_administrator");
    const body = { action: "disable", staffId: MISSING };
    const [r, statements] = await counted(() => h.call(R.staff, "/api/staff", "only_administrator", body));
    expect(r.status).toBe(403);
    expect(statements).toBeLessThanOrEqual(BUDGET.stale);
    expect(await median(() => h.call(R.staff, "/api/staff", "only_administrator", body))).toBeLessThan(BUDGET.staleMs);
  });
});

describe("staff sign out everywhere and email", () => {
  const auth = (path: string, cookie?: string, body: unknown = {}, origin = BASE) => h.AUTH(new Request(`${BASE}/api/auth/staff/${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin, "x-vercel-forwarded-for": "198.51.100.241", ...(cookie ? { cookie } : {}) } }));
  it("revoke-sessions ends every session of this staff login at once, from a stale session too; other staff keep theirs", async () => {
    await h.makeStaff("leaver", ["content_editor"]);
    const first = h.signedIn("leaver");
    await h.makeStaff("leaver2", ["content_editor"]);
    await age("leaver");
    expect((await auth("revoke-sessions", first)).status).toBe(200);
    await h.no(h.call(R.export, "/api/staff/me/export", null, undefined, { cookie: first }), 401, "no_session");
    expect((await h.call(R.export, "/api/staff/me/export", "leaver2")).status).toBe(200);
    expect((await h.su.query("select count(*)::int n from staff_session where user_id = $1", [h.staff.leaver])).rows[0].n).toBe(0);
  });
  it("is 401 signed out and 403 from a foreign Origin", async () => {
    expect((await auth("revoke-sessions")).status).toBe(401);
    expect((await auth("revoke-sessions", h.signedIn("only_content_editor"), {}, "https://evil.example")).status).toBe(403);
    expect((await h.call(R.export, "/api/staff/me/export", "only_content_editor")).json.error).not.toBe("no_session");
  });
  it("staff cannot change their own email (administrators do): change-email is refused and nothing changes", async () => {
    await age("only_content_editor", "now()");
    const r = await auth("change-email", h.signedIn("only_content_editor"), { newEmail: "fake.moved@example.test" });
    expect(r.status).toBe(400);
    expect((await h.su.query("select email from staff_user where id = $1", [h.staff.only_content_editor])).rows[0].email).toBe("only_content_editor@example.test");
  });
  it(`revoke-sessions costs at most ${BUDGET.revoke} statements and ${BUDGET.revokeMs} ms median`, async () => {
    const cookies: string[] = [];
    for (let i = 0; i < 10; i++) { await h.makeStaff(`many${i}`, ["content_editor"]); cookies.push(h.signedIn(`many${i}`)); }
    const [r, statements] = await counted(() => auth("revoke-sessions", cookies.pop()));
    expect(r.status).toBe(200);
    expect(statements).toBeLessThanOrEqual(BUDGET.revoke);
    expect(await median(() => auth("revoke-sessions", cookies.pop()))).toBeLessThan(BUDGET.revokeMs);
  });
});
