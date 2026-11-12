// Migration 0009: the portal login reads membership and cannot write it (no insert, update or delete, on any column). The only
// writers are app_admin and the security definer functions (claim_organisation, register_organisation and the team functions of 0013). Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb, portal: pg.Pool, su: pg.Pool;
let orgA: number, orgB: number, attacker: string;
let mineViewer: number, mineInvite: number, theirOwner: number, theirInvite: number;
// fixtures.ts is untyped, so the three builders used here are described by hand.
let F: {
  org(o?: object): Promise<number>;
  portal(o?: object): Promise<string>;
  member(org: number, user: string | null, o?: object): Promise<number>;
};

beforeAll(async () => {
  db = await createTestDb();
  portal = db.pool("app_portal");
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  orgA = await F.org();
  orgB = await F.org();
  attacker = await F.portal();
  await F.member(orgA, attacker, { role: "account_owner", signer: true });
  mineViewer = await F.member(orgA, await F.portal(), { role: "viewer" });
  mineInvite = await F.member(orgA, null, { status: "invited", email: "mine@example.test" });
  theirOwner = await F.member(orgB, await F.portal(), { role: "account_owner", signer: true });
  theirInvite = await F.member(orgB, null, { status: "invited", email: "theirs@example.test" });
  await su.query("update membership set invite_token_hash = 'their-hash' where id = $1", [theirInvite]);
  await su.query("update membership set status = 'removed', removed_at = now() where id = $1", [mineViewer]);
});
afterAll(() => db.drop());

const rows = async () => (await su.query("select to_jsonb(m) r from membership m order by id")).rows.map((x) => x.r);

// One attempt as app_portal: it must be refused with "permission denied" and leave every membership row exactly as it was.
async function refused(sql: string, params: unknown[] = []) {
  const before = await rows();
  const err = await portal.query(sql, params).then(() => null, (e: pg.DatabaseError) => e);
  expect(err?.code, err ? err.message : "was allowed").toBe("42501");
  expect(await rows()).toEqual(before);
}

describe("app_portal cannot insert a membership", () => {
  const ins = "insert into membership(organisation_id, portal_user_id, role, status, is_signer) values ($1, $2, $3, 'active', $4)";
  it.each([
    ["in another company as account_owner", () => [orgB, attacker, "account_owner", true]],
    ["in another company as viewer", () => [orgB, attacker, "viewer", false]],
    ["in its own company as account_owner", () => [orgA, attacker, "account_owner", true]],
    ["in its own company as viewer", () => [orgA, attacker, "viewer", false]],
  ] as const)("%s", (_n, args) => refused(ins, [...args()]));
  it("an invite with a token hash", () =>
    refused("insert into membership(organisation_id, invited_email, role, status, invite_token_hash) values ($1, 'a@example.test', 'poster', 'invited', 'h')", [orgA]));
});

describe("app_portal cannot update a membership, on its own row or another company's", () => {
  // Each entry is the SET clause and a getter for $2 (none when the clause has no $2); ids exist only after beforeAll, hence the getters.
  const sets: [string, string, (() => unknown)?][] = [
    ["organisation_id", "organisation_id = $2", () => orgB],
    ["portal_user_id", "portal_user_id = $2", () => attacker],
    ["status (removed to active)", "status = 'active'"],
    ["role (viewer to account_owner)", "role = 'account_owner'"],
    ["is_signer", "is_signer = true"],
    ["invited_email", "invited_email = 'x@example.test'"],
    ["invite_token_hash", "invite_token_hash = 'x'"],
  ];
  const targets = [["its own removed viewer row", () => mineViewer], ["its own pending invite", () => mineInvite], ["another company's owner row", () => theirOwner], ["another company's pending invite", () => theirInvite]] as const;
  for (const [col, set, value] of sets)
    for (const [which, id] of targets)
      it(`${col}, ${which}`, () => refused(`update membership set ${set} where id = $1`, value ? [id(), value()] : [id()]));
  it("every column at once", () => refused("update membership set status = 'active', role = 'account_owner'"));
});

describe("app_portal cannot delete a membership", () => {
  it("its own", () => refused("delete from membership where id = $1", [mineInvite]));
  it("another company's", () => refused("delete from membership where id = $1", [theirOwner]));
  it("all rows", () => refused("delete from membership"));
});

describe("what stays", () => {
  it("app_portal still reads membership", async () => {
    const r = await portal.query("select count(*)::int n from membership");
    expect(r.rows[0].n).toBe((await rows()).length);
  });
  it("app_admin still inserts and updates (the staff path)", async () => {
    const u = await F.portal();
    await db.pool("app_admin").query("insert into membership(organisation_id, portal_user_id, role, status) values ($1, $2, 'viewer', 'active')", [orgB, u]);
    await db.pool("app_admin").query("update membership set role = 'recruiter' where portal_user_id = $1", [u]);
  });
  it("app_candidate and app_fetcher still have no right on membership", async () => {
    for (const role of ["app_candidate", "app_fetcher"] as const) {
      const err = await db.pool(role).query("update membership set role = role where false").then(() => null, (e: pg.DatabaseError) => e);
      expect(err?.code, role).toBe("42501");
    }
  });
  it("claim_organisation makes the owner membership, as app_portal", async () => {
    const o = await F.org({ status: "unclaimed" });
    await su.query("insert into organisation_domain(organisation_id, domain, source) values ($1, 'claim-ro.test', 'seed')", [o]);
    const u = await F.portal({ email: "boss@claim-ro.test" });
    await portal.query("select private.claim_organisation($1, $2)", [u, o]);
    const m = await su.query("select role, status, is_signer from membership where organisation_id = $1 and portal_user_id = $2", [o, u]);
    expect(m.rows).toEqual([{ role: "account_owner", status: "active", is_signer: true }]);
  });
  it("register_organisation makes the owner membership, as app_portal", async () => {
    const u = await F.portal();
    const r = await portal.query("select private.register_organisation($1, 'employer', 'Read Only Ltd', '7700', null) r", [u]);
    const m = await su.query("select role, status from membership where organisation_id = $1 and portal_user_id = $2", [r.rows[0].r.organisation_id, u]);
    expect(m.rows[0].role).toBe("account_owner");
  });
});
