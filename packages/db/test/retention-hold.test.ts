// Step 15 R3 and R4 (migration 0041) on the real test database, through the real daily run (retention-cli drain, as app_admin) and the real outbox
// sender with a fake send: audit rows past the audit_event setting go in batches and the rest stay; an open services case that holds a candidate's
// deletion writes one notice and one email per person per rule, once; an open report alone writes none. Fake data only, no network.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drain } from "../src/retention-cli.ts";
import { sendPending } from "../src/outbox-cli.ts";
import { createTestDb, type TestDb } from "./db";
import { daysAgo, fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
let db: TestDb, su: pg.Pool, admin: pg.Pool;
let F: { cand(o?: object): Promise<string>; text(): Promise<number> };
const one = async (sql: string, p: unknown[] = []) => (await su.query(sql, p)).rows[0];
const run = async (batch = 1000) => {
  const c = await admin.connect();
  const lines: string[] = [];
  try { return { code: await drain(c, (l) => lines.push(l), batch), lines }; } finally { c.release(); }
};
const openCase = async (cand: string) => {
  const consent = (await su.query("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [cand, await F.text()])).rows[0].id;
  await su.query("insert into services_case(candidate_user_id, permit_type, payer, consent_record_id) values ($1, 'critical_skills', 'employer', $2)", [cand, consent]);
};
const held = (cand: string) => su.query(
  "select n.template_key, n.category, n.params, n.dedupe_key, o.template, o.params as mail_params, o.status from notification n " +
  "left join email_outbox o on o.dedupe_key = n.dedupe_key where n.candidate_user_id = $1 order by n.id", [cand]).then((r) => r.rows);

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  admin = db.pool("app_admin");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
});
afterAll(() => db.drop());

describe("R3: audit log retention", () => {
  it("a setting of 24 months (a placeholder guess) is there", async () => {
    expect(await one("select value, unit, is_guess from setting where key = 'audit_event'")).toEqual({ value: 24, unit: "months", is_guess: true });
  });
  it("rows older than the setting go in batches, newer ones stay, and the run ends green", async () => {
    await su.query("insert into audit_event(kind, actor_system, action, at, source) select 'admin_action', 'fake', 'fake.old', now() - interval '25 months' - i * interval '1 minute', 'scheduled_job' from generate_series(1, 5) i");
    await su.query("insert into audit_event(kind, actor_system, action, at, source) values ('admin_action', 'fake', 'fake.new', now() - interval '23 months', 'scheduled_job')");
    const r = await run(2);
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(r.lines.filter((l) => l.startsWith("audit_event"))).toEqual(["audit_event: 2 done, 3 left, 0 skipped", "audit_event: 2 done, 1 left, 0 skipped", "audit_event: 1 done, 0 left, 0 skipped"]);
    expect(await one("select count(*)::int n from audit_event where action = 'fake.old'")).toEqual({ n: 0 });
    expect(await one("select count(*)::int n from audit_event where action = 'fake.new'")).toEqual({ n: 1 });
  });
  it("an empty setting deletes nothing, in the run and in audit_purge; a longer one keeps more", async () => {
    await su.query("insert into audit_event(kind, actor_system, action, at, source) values ('admin_action', 'fake', 'fake.older', now() - interval '30 months', 'scheduled_job')");
    await su.query("update setting set value = null where key = 'audit_event'"); // as postgres: the two-person guard is for app_admin only
    expect((await run()).lines).toEqual(["retention: 0 rows handled"]);
    expect(await one("select private.audit_purge() n")).toEqual({ n: "0" });
    await su.query("update setting set value = 36 where key = 'audit_event'");
    expect(await one("select private.audit_purge() n")).toEqual({ n: "0" });
    await su.query("update setting set value = 24 where key = 'audit_event'");
    expect(await one("select private.audit_purge() n")).toEqual({ n: "1" });
  });
  it("app_admin cannot change the period alone: the two-person rule refuses it", async () => {
    const c = await admin.connect();
    try {
      await expect(c.query("begin; select set_config('app.staff_user_id', 'nobody', true); update setting set value = 0 where key = 'audit_event'")).rejects.toThrow(/no acting staff member/);
    } finally { await c.query("rollback"); c.release(); }
    expect(await one("select value from setting where key = 'audit_event'")).toEqual({ value: 24 });
  });
});

describe("R4: an open case holds deletion and the person is told once", () => {
  let deleted: string, unverified: string, reported: string, closed: string;
  beforeAll(async () => {
    deleted = await F.cand({ deleted: daysAgo(31) }); // rule 8, deleted_account_grace
    unverified = await F.cand({ verified: false, created: daysAgo(8) }); // rule 6, unverified_account
    reported = await F.cand({ deleted: daysAgo(31) }); // held by an open report only
    closed = await F.cand({ deleted: daysAgo(31) }); // a closed case holds nothing
    for (const c of [deleted, unverified]) await openCase(c);
    await openCase(closed);
    await su.query("update services_case set status = 'closed', closed_at = now(), close_reason = 'withdrawn' where candidate_user_id = $1", [closed]);
    await su.query("insert into report(target_kind, target_candidate_user_id, reason) values ('profile', $1, 'other')", [reported]);
  });
  it("one notice and one pending email per held person and rule; the erasure stays refused; nothing for a report or a closed case", async () => {
    const r = await run();
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(await held(deleted)).toEqual([{ template_key: "deletion_on_hold", category: "account", params: { rule: "deleted_account_grace" }, dedupe_key: `deletion_on_hold:deleted_account_grace:${deleted}`,
      template: "deletion_on_hold", mail_params: { rule: "deleted_account_grace", email: `${deleted}@example.test` }, status: "pending" }]);
    expect(await held(unverified)).toEqual([{ template_key: "deletion_on_hold", category: "account", params: { rule: "unverified_account" }, dedupe_key: `deletion_on_hold:unverified_account:${unverified}`,
      template: "deletion_on_hold", mail_params: { rule: "unverified_account" }, status: "pending" }]);
    expect(await held(reported)).toEqual([]);
    expect(await one("select count(*)::int n from candidate_user where id = any($1)", [[deleted, unverified, reported]])).toEqual({ n: 3 });
    expect(await one("select count(*)::int n from candidate_user where id = $1", [closed])).toEqual({ n: 0 }); // erased as usual
  });
  it("later daily runs write nothing more", async () => {
    await run();
    await run();
    expect(await one("select count(*)::int n from notification where template_key = 'deletion_on_hold'")).toEqual({ n: 2 });
    expect(await one("select count(*)::int n from email_outbox where template = 'deletion_on_hold'")).toEqual({ n: 2 });
  });
  it("the sender delivers both: the deleted login's to the address in params, with placeholder wording only", async () => {
    const sent: { to: string; text: string }[] = [];
    await sendPending(admin, async (to, _s, text) => { sent.push({ to, text }); });
    expect(sent.map((s) => s.to).sort()).toEqual([`${deleted}@example.test`, `${unverified}@example.test`].sort());
    for (const s of sent) expect(s.text).toMatch(/^PLACEHOLDER WORDING/);
  });
});
