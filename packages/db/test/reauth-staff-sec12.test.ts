// Audit SEC-12 (27 Nov 2026): six more staff writes need a sign-in in the last 10 minutes (C4, #270), like /api/staff: settings propose and confirm,
// data request erase_propose and erase_confirm, company domains add and remove, owner reassign request and complete, company merge, and account review
// approve. The steps that only stop a change (refuse, cancel, release, close) and every GET still work on an older session. Real route handlers on the
// real test database as app_admin, real staff sessions, from every role. Fake people only, no network.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { counted, oneOfEachRole, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

// The same budget as reauth-staff.test.ts: a stale refusal stops after the session read (the session, then the user). Raise only on purpose.
const BUDGET = { stale: 2 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
let db: TestDb;
let h: Awaited<ReturnType<typeof staffHarness>>;
type Name = "settings" | "dataRequests" | "domains" | "owner" | "merge" | "review";
const R = {} as Record<Name, Route>;
const PATH: Record<Name, string> = {
  settings: "/api/settings", dataRequests: "/api/data-requests", domains: "/api/companies/domains", owner: "/api/companies/owner-reassign", merge: "/api/companies/merge", review: "/api/account-review",
};

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  R.settings = await import("../../../apps/admin/app/api/settings/route");
  R.dataRequests = await import("../../../apps/admin/app/api/data-requests/route");
  R.domains = await import("../../../apps/admin/app/api/companies/domains/route");
  R.owner = await import("../../../apps/admin/app/api/companies/owner-reassign/route");
  R.merge = await import("../../../apps/admin/app/api/companies/merge/route");
  R.review = await import("../../../apps/admin/app/api/account-review/route");
  await oneOfEachRole(h);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const age = (who: string, sql = "now() - interval '11 minutes'") => h.su.query(`update staff_session set created_at = ${sql} where user_id = $1`, [h.staff[who]]);
const NONE = "999999999";
// Bodies that pass each route's shape check but name nothing real, so a fresh call reaches the role check or a not-found.
const SENSITIVE: [string, Name, unknown][] = [
  ["settings propose", "settings", { action: "propose", key: "fake_key", value: 1 }],
  ["settings confirm", "settings", { action: "confirm", requestId: NONE }],
  ["erase_propose", "dataRequests", { action: "erase_propose", itemId: NONE }],
  ["erase_confirm", "dataRequests", { action: "erase_confirm", requestId: NONE }],
  ["domain add", "domains", { action: "add", organisationId: NONE, domain: "fake-company.example", reason: "fake_reason" }],
  ["domain remove", "domains", { action: "remove", organisationId: NONE, domain: "fake-company.example", reason: "fake_reason" }],
  ["owner request", "owner", { action: "request", membershipId: NONE, domainChecked: true, croChecked: true }],
  ["owner complete", "owner", { action: "complete", requestId: NONE }],
  ["merge", "merge", { absorbedId: NONE, survivorId: "999999998" }],
  ["approve", "review", { action: "approve", itemId: NONE }],
];
const NOT_SENSITIVE: [string, Name, unknown][] = [
  ["settings refuse", "settings", { action: "refuse", requestId: NONE }],
  ["send_confirm", "dataRequests", { action: "send_confirm", itemId: NONE, purpose: "export" }],
  ["close", "dataRequests", { action: "close", itemId: NONE }],
  ["erase_refuse", "dataRequests", { action: "erase_refuse", requestId: NONE }],
  ["owner cancel", "owner", { action: "cancel", requestId: NONE }],
  ["claim", "review", { action: "claim", itemId: NONE }],
  ["release", "review", { action: "release", itemId: NONE }],
  ["reject", "review", { action: "reject", itemId: NONE, reason: "fake_reason" }],
];
const run = (list: typeof SENSITIVE, who: string | null) => Promise.all(list.map(async ([name, r, body]) => [name, await h.call(R[r], PATH[r], who, body)] as const));

describe("SEC-12: the six staff writes need a fresh sign-in", () => {
  for (const role of ROLE_NAMES)
    it(`${role}: each is 403 reauth_required on a session older than 10 minutes, and reaches its normal answer on a fresh one`, async () => {
      const who = `only_${role}`;
      await age(who);
      for (const [name, r] of await run(SENSITIVE, who)) expect([r.status, r.json.error], name).toEqual([403, "reauth_required"]);
      await age(who, "now() - interval '9 minutes'");
      for (const [name, r] of await run(SENSITIVE, who)) {
        expect(r.json.error, name).not.toBe("reauth_required");
        expect(r.status, `${name} ${JSON.stringify(r.json)}`).toBeLessThan(500); // a known refusal (role, not found, bad key), never a 500
      }
    });
  it("the steps that only stop a change, and every GET, still work on an old session", async () => {
    for (const role of ROLE_NAMES) {
      const who = `only_${role}`;
      await age(who);
      for (const [name, r] of await run(NOT_SENSITIVE, who)) {
        expect(r.json.error, `${role} ${name}`).not.toBe("reauth_required");
        expect(r.status, `${role} ${name} ${JSON.stringify(r.json)}`).toBeLessThan(500);
      }
    }
    await age("only_administrator");
    for (const p of ["settings", "dataRequests"] as const) expect((await h.call(R[p], PATH[p], "only_administrator")).status, p).toBe(200);
    await age("only_account_reviewer");
    expect((await h.call(R.owner, PATH.owner, "only_account_reviewer")).status).toBe(200);
    expect((await h.call(R.review, PATH.review, "only_account_reviewer")).status).toBe(200);
  });
  it("signed out is no_session before the freshness check; a foreign Origin is refused before it; a bad body on a stale session is still bad", async () => {
    for (const [name, r] of await run(SENSITIVE, null)) expect([r.status, r.json.error], name).toEqual([401, "no_session"]);
    await age("only_administrator");
    for (const [name, rt, body] of SENSITIVE) await h.no(h.call(R[rt], PATH[rt], "only_administrator", body, { origin: "https://evil.example" }), 403, "bad_origin").catch((e) => { throw new Error(`${name}: ${e.message}`); });
    expect((await h.call(R.settings, PATH.settings, "only_administrator", null, { raw: "{" })).status).toBe(400);
    expect((await h.call(R.owner, PATH.owner, "only_administrator", { action: "complete", requestId: "1 or 1=1" })).status).toBe(400);
    expect((await h.call(R.review, PATH.review, "only_administrator", { action: "approve", itemId: NONE, addDomain: "yes" })).status).toBe(400);
  });
  it(`a stale refusal costs at most ${BUDGET.stale} statements, on both forms of the check`, async () => {
    await age("only_administrator");
    for (const [rt, body] of [["merge", SENSITIVE[8]![2]], ["owner", SENSITIVE[7]![2]], ["review", SENSITIVE[9]![2]]] as const) {
      const [r, statements] = await counted(() => h.call(R[rt], PATH[rt], "only_administrator", body));
      expect(r.json.error, rt).toBe("reauth_required");
      expect(statements, rt).toBeLessThanOrEqual(BUDGET.stale);
    }
  });
});
