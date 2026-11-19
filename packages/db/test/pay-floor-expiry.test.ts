// Integration (P7, #82): the daily pay floor sweep and re-sign reminder in the job expiry command (packages/db/src/job-expiry-cli.ts), on the real test
// database through the real command (main) and expireJobs as app_admin. Companies, members and floors are written as postgres (every CHECK, foreign key and
// trigger still fires). No network: the email stays in the outbox. Fake people only.
import { SOC2010_CODES } from "@portal/rules";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { confirmFloor, createPayFloor, FloorRefused, getFloorCheck, proposeFloor, withdrawPayFloor } from "../src/pay-floors";
import { expireJobs, FLOORS_END, FLOORS_REMIND, main, REMIND_DAYS } from "../src/job-expiry-cli";
import { seedStaff } from "../src/staff-seed-cli";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { confirmedApproval, makeBig } from "./pay-floors-helpers";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
let db: TestDb, su: pg.Pool, text: number;
let F: { org(o?: object): Promise<number>; portal(): Promise<string>; member(org: number, user: string, o?: object): Promise<number>; staff(): Promise<string>; text(p?: string): Promise<number> };
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  text = await F.text("pay_floor");
});
afterAll(() => db.drop());

async function company() {
  const org = await F.org({ name: "Fake Big Co" });
  const owner = await F.portal(), recruiter = await F.portal();
  const ownerM = Number(await F.member(org, owner, { role: "account_owner", signer: true }));
  await F.member(org, recruiter, { role: "recruiter", signer: true });
  await makeBig(su, F.staff, org);
  return { org, owner, recruiter, ownerM };
}
const CODES = [...SOC2010_CODES];
let fam = 0;
/** A floor signed 13 months ago, ending at now() + `until` (an SQL interval), in `status` (active through a confirmed approval, as the check does). */
async function floor(c: { org: number; ownerM: number }, until: string, status = "active", family = CODES[fam++]!) {
  const id = String((await one(
    "insert into pay_floor(organisation_id, role_family, floor_eur, consent_text_id, signer_membership_id, signed_at, valid_until) values ($1, $2, 40000, $3, $4, now() - interval '13 months', now() + $5::interval) returning id",
    [c.org, family, text, c.ownerM, until])).id);
  if (status === "active") await su.query("update pay_floor set status = 'active', approval_request_id = $2 where id = $1", [id, await confirmedApproval(su, F.staff, "pay_floor", "pay_floor", id)]);
  else if (status !== "pending_check") await su.query("update pay_floor set status = $2 where id = $1", [id, status]);
  return id;
}
const state = async (id: string) => one("select status, ended_at is not null as ended from pay_floor where id = $1", [id]);
const rows = async (template: string) => (await su.query(
  "select 'n' as k, portal_user_id as u, params, dedupe_key as key from notification where template_key = $1 union all select 'e', portal_user_id, params, dedupe_key from email_outbox where template = $1 order by 1, 4", [template])).rows;
const run = () => expireJobs(db.pool("app_admin"));

describe("the pay floor sweep (P7)", () => {
  let a: Awaited<ReturnType<typeof company>>, b: Awaited<ReturnType<typeof company>>;
  const f: Record<string, string> = {};
  beforeAll(async () => {
    a = await company();
    b = await company();
    f.passed = await floor(a, "-1 day");
    f.now = await floor(a, "0 seconds"); // on valid_until: it has passed by the time the sweep reads now()
    f.hour = await floor(a, "1 hour"); // ends later today: still active, reminded
    f.d29 = await floor(a, "29 days");
    f.d31 = await floor(a, "31 days"); // outside the 30 days
    f.d200 = await floor(a, "200 days");
    f.pending = await floor(a, "-1 day", "pending_check");
    f.withdrawn = await floor(a, "-1 day", "withdrawn");
    f.rejected = await floor(a, "-1 day", "rejected");
    f.replaced = await floor(a, "-1 day", "replaced");
    f.other = await floor(b, "200 days");
  });

  it("ends only the active floors past valid_until, stamps ended_at, tells the owner once, reminds the floors in their last 30 days once", async () => {
    const lines: string[] = [];
    expect(await main([], { EXPIRY_ADMIN_DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" }, (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toMatch(/, 2 pay floors ended, 2 pay floor reminders queued$/);
    for (const k of ["passed", "now"]) expect(await state(f[k]!), k).toEqual({ status: "expired", ended: true });
    for (const k of ["hour", "d29", "d31", "d200", "other"]) expect(await state(f[k]!), k).toEqual({ status: "active", ended: false });
    for (const k of ["pending", "withdrawn", "rejected", "replaced"]) expect((await state(f[k]!)).status, k).toBe(k === "pending" ? "pending_check" : k);
    const p = (id: string) => ({ organisationId: Number(a.org), floorId: Number(id) });
    // the owner only (not the recruiter who may sign, not company b), one notice and one email per floor, ids only
    expect(await rows("pay_floor_lapsed")).toEqual([
      { k: "e", u: a.owner, params: p(f.passed!), key: `app_admin:pay_floor_lapsed:${f.passed}` }, { k: "e", u: a.owner, params: p(f.now!), key: `app_admin:pay_floor_lapsed:${f.now}` },
      { k: "n", u: a.owner, params: p(f.passed!), key: `app_admin:pay_floor_lapsed:${f.passed}` }, { k: "n", u: a.owner, params: p(f.now!), key: `app_admin:pay_floor_lapsed:${f.now}` },
    ].sort((x, y) => x.k.localeCompare(y.k) || x.key.localeCompare(y.key)));
    expect((await rows("pay_floor_expiring")).map((r) => [r.k, r.u, r.params.floorId])).toEqual([["e", a.owner, Number(f.hour)], ["e", a.owner, Number(f.d29)], ["n", a.owner, Number(f.hour)], ["n", a.owner, Number(f.d29)]]
      .sort((x, y) => String(x[0]).localeCompare(String(y[0])) || `app_admin:pay_floor_expiring:${x[2]}`.localeCompare(`app_admin:pay_floor_expiring:${y[2]}`)));
    expect(await one("select category from notification where template_key = 'pay_floor_lapsed' limit 1")).toEqual({ category: "account" });
    // the rules run's own notice is not written by the sweep
    expect(await rows("pay_floor_expired")).toEqual([]);
  });

  it("a second run the same day writes nothing", async () => {
    const count = async () => (await one("select (select count(*) from notification)::int + (select count(*) from email_outbox)::int + (select count(*) from pay_floor where ended_at is not null)::int as n")).n;
    const before = await count();
    expect(await run()).toMatchObject({ floorsEnded: 0, floorsReminded: 0 });
    expect(await count()).toBe(before);
  });

  it("a reminded floor that then runs out gets its end notice, and no second reminder", async () => {
    await su.query("update pay_floor set valid_until = now() - interval '1 minute' where id = $1", [f.hour]);
    expect(await run()).toMatchObject({ floorsEnded: 1, floorsReminded: 0 });
    expect((await rows("pay_floor_lapsed")).filter((r) => r.params.floorId === Number(f.hour))).toHaveLength(2);
    expect((await rows("pay_floor_expiring")).filter((r) => r.params.floorId === Number(f.hour))).toHaveLength(2);
  });

  it("a company with no active owner gets nothing, and the floor still ends", async () => {
    const c = await company();
    const id = await floor(c, "-1 day");
    await su.query("update membership set status = 'removed' where id = $1", [c.ownerM]);
    expect(await run()).toMatchObject({ floorsEnded: 1 });
    expect(await state(id)).toEqual({ status: "expired", ended: true });
    expect((await rows("pay_floor_lapsed")).filter((r) => r.params.floorId === Number(id))).toEqual([]);
  });

  it("an expired floor stops counting exactly as one the rules run ended: no withdraw, no current floor in the check, a new floor replaces nothing", async () => {
    const who = { membershipId: a.ownerM, organisationId: Number(a.org), role: "account_owner" };
    const portal = db.pool("app_portal"), admin = db.pool("app_admin");
    await expect(withdrawPayFloor(portal, who, f.passed!)).rejects.toThrow(new FloorRefused("NOT_WITHDRAWABLE"));
    const family = (await one("select role_family from pay_floor where id = $1", [f.passed])).role_family as string;
    const fresh = await createPayFloor(portal, who, { roleFamily: family, floorEur: 41000, consentTextId: String(text) });
    const c = await su.connect();
    let ed: string, ad: string;
    try {
      ed = await seedStaff(c, { email: "ed-p7@example.test", name: "Fake Editor", roles: ["rules_data_editor"] }, "Fake-floor-password-1");
      ad = await seedStaff(c, { email: "ad-p7@example.test", name: "Fake Admin", roles: ["administrator"] }, "Fake-floor-password-1");
    } finally {
      c.release();
    }
    expect((await getFloorCheck(admin, ed, fresh.id))!.currentFloorEur).toBeNull();
    await proposeFloor(admin, ed, fresh.id);
    expect(await confirmFloor(admin, ad, fresh.id)).toEqual({ floorId: fresh.id, replacedId: null });
    expect(await state(f.passed!)).toEqual({ status: "expired", ended: true });
    // the floor still in force (d29) is replaced as before, so the sweep did not change the active path
    const fam29 = (await one("select role_family from pay_floor where id = $1", [f.d29])).role_family as string;
    const next = await createPayFloor(portal, who, { roleFamily: fam29, floorEur: 42000, consentTextId: String(text) });
    expect((await getFloorCheck(admin, ed, next.id))!.currentFloorEur).toBe(40000);
    await proposeFloor(admin, ed, next.id);
    expect(await confirmFloor(admin, ad, next.id)).toEqual({ floorId: next.id, replacedId: f.d29 });
    // the fresh 12-month floors are not reminded
    expect(await run()).toMatchObject({ floorsEnded: 0, floorsReminded: 0 });
  });

  it("only app_admin may run it: the portal, candidate and fetcher logins are refused and nothing changes", async () => {
    const id = await floor(b, "-1 day");
    for (const role of ["app_portal", "app_candidate", "app_fetcher"] as const) {
      await expect(db.query(role, FLOORS_END), role).rejects.toThrow();
      await expect(db.query(role, FLOORS_REMIND, [REMIND_DAYS]), role).rejects.toThrow();
    }
    expect(await state(id)).toEqual({ status: "active", ended: false });
    expect(await main([], { EXPIRY_ADMIN_DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable" }, () => {})).toBe(1);
    expect(await state(id)).toEqual({ status: "active", ended: false });
    expect(await main(["--all"], { EXPIRY_ADMIN_DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" }, () => {})).toBe(2); // takes no arguments
  });
});
