// Step 8 slice 8.1b: the outbox sender command on the test database, as app_admin, with a fake Brevo (an injected send function).
// No test calls the real network. Fake people only.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { main, sendPending, MAX_ATTEMPTS } from "../src/outbox-cli.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
let db: TestDb, su: pg.Pool, admin: pg.Pool;
let F: { cand(o?: object): Promise<string>; portal(o?: object): Promise<string>; staff(): Promise<string>; org(): Promise<number>; member(org: number, user: string | null, o?: object): Promise<number> };
type Sent = { to: string; subject: string; text: string };
const fake = (fail: (to: string) => boolean = () => false) => {
  const sent: Sent[] = [];
  return { sent, send: async (to: string, subject: string, text: string) => { if (fail(to)) throw new Error("Brevo send failed: HTTP 500"); sent.push({ to, subject, text }); } };
};
let n = 0;
const queue = async (cols: Record<string, unknown>) => {
  const k = Object.keys({ template: "t", dedupe_key: `k${++n}`, ...cols }), v = Object.values({ template: "t", dedupe_key: `k${n}`, ...cols });
  return Number((await su.query(`insert into email_outbox(${k.join(",")}) values(${k.map((_, i) => `$${i + 1}`).join(",")}) returning id`, v)).rows[0].id);
};
const row = async (id: number) => (await su.query("select status, attempts, sent_at from email_outbox where id=$1", [id])).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  admin = db.pool("app_admin");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
});
afterAll(() => db.drop());
beforeEach(() => su.query("delete from email_outbox"));

describe("outbox sender", () => {
  it("sends pending rows oldest first to the right address for each kind of owner, and marks them sent", async () => {
    const c = await F.cand(), p = await F.portal(), s = await F.staff(), o = await F.org();
    const m = await F.member(o, p), inv = await F.member(o, null, { status: "invited", email: "invitee@example.test" });
    const cm = Number((await su.query("insert into contact_message(surface,from_name,from_email,topic,body) values ('portal','Pat','pat@example.test','general','Hi') returning id")).rows[0].id);
    const ids = [
      await queue({ candidate_user_id: c, send_after: new Date(Date.now() - 5000) }),
      await queue({ portal_user_id: p, send_after: new Date(Date.now() - 9000) }),
      await queue({ staff_user_id: s, send_after: new Date(Date.now() - 1000) }),
      await queue({ membership_id: m, send_after: new Date(Date.now() - 4000) }),
      await queue({ membership_id: inv, send_after: new Date(Date.now() - 3000) }),
      await queue({ contact_message_id: cm, send_after: new Date(Date.now() - 2000) }),
    ];
    const f = fake();
    expect(await sendPending(admin, f.send)).toEqual({ sent: 6, retry: 0, failed: 0, dropped: 0 });
    expect(f.sent.map((x) => x.to)).toEqual([`${p}@example.test`, `${c}@example.test`, `${p}@example.test`, "invitee@example.test", "pat@example.test", `${s}@example.test`]);
    for (const id of ids) expect(await row(id)).toMatchObject({ status: "sent", attempts: 1 });
    expect((await row(ids[0]!)).sent_at).toBeInstanceOf(Date);
  });
  it("sends no more than the batch, and not a row whose time has not come", async () => {
    const c = await F.cand();
    for (let i = 0; i < 5; i++) await queue({ candidate_user_id: c });
    const later = await queue({ candidate_user_id: c, send_after: new Date(Date.now() + 3600_000) });
    const f = fake();
    expect((await sendPending(admin, f.send, 3)).sent).toBe(3);
    expect((await sendPending(admin, f.send, 3)).sent).toBe(2);
    expect(await row(later)).toMatchObject({ status: "pending", attempts: 0 });
  });
  it("retries a failed send on the next runs and gives up as failed after the third try", async () => {
    const c = await F.cand();
    const id = await queue({ candidate_user_id: c });
    const lines: string[] = [];
    const bad = fake(() => true);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(await sendPending(admin, bad.send, 50, (l) => lines.push(l))).toMatchObject({ retry: 1, failed: 0 });
      expect(await row(id)).toMatchObject({ status: "pending", attempts: i });
    }
    expect(await sendPending(admin, bad.send, 50, (l) => lines.push(l))).toMatchObject({ retry: 0, failed: 1 });
    expect(await row(id)).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, sent_at: null });
    expect(await sendPending(admin, bad.send)).toEqual({ sent: 0, retry: 0, failed: 0, dropped: 0 }); // never tried again
    expect(lines.join("\n")).not.toContain("example.test"); // no address in the log
  });
  it("one bad row does not stop the others, and a retry succeeds later", async () => {
    const a = await F.cand(), b = await F.cand();
    const ia = await queue({ candidate_user_id: a }), ib = await queue({ candidate_user_id: b });
    const f = fake((to) => to.startsWith(a));
    expect(await sendPending(admin, f.send)).toMatchObject({ sent: 1, retry: 1 });
    expect(await row(ib)).toMatchObject({ status: "sent" });
    expect(await sendPending(admin, fake().send)).toMatchObject({ sent: 1 });
    expect(await row(ia)).toMatchObject({ status: "sent", attempts: 2 });
  });
  it("never sends a row twice: a second run, and two runs at the same time, send each row once", async () => {
    const c = await F.cand();
    for (let i = 0; i < 20; i++) await queue({ candidate_user_id: c });
    const f = fake();
    const slow = async (...a: [string, string, string]) => { await new Promise((r) => setTimeout(r, 5)); return f.send(...a); };
    const [r1, r2] = await Promise.all([sendPending(admin, slow, 15), sendPending(admin, slow, 15)]);
    expect(r1.sent + r2.sent).toBe(20);
    expect(f.sent).toHaveLength(20);
    expect((await sendPending(admin, f.send)).sent).toBe(0);
    expect(f.sent).toHaveLength(20);
  });
  it("leaves a row a crash left in sending alone (at most once)", async () => {
    const c = await F.cand();
    const id = await queue({ candidate_user_id: c, status: "sending", attempts: 1 });
    const f = fake();
    await sendPending(admin, f.send);
    expect(f.sent).toHaveLength(0);
    expect((await row(id)).status).toBe("sending");
  });
  it("dedupe: queueing the same key twice gives one row and one email", async () => {
    const c = await F.cand();
    const q = () => admin.query("insert into email_outbox(template, candidate_user_id, dedupe_key) values ('t', $1, 'same-key') on conflict (dedupe_key) do nothing", [c]);
    await q(); await q();
    const f = fake();
    expect((await sendPending(admin, f.send)).sent).toBe(1);
    expect(f.sent).toHaveLength(1);
  });
  it("drops a row with no address: a deleted candidate, an erased person, an invite-less member", async () => {
    const gone = await F.cand({ deleted: new Date() });
    const ids = [await queue({ candidate_user_id: gone }), await queue({ candidate_user_id: "erased-123" })];
    const f = fake();
    expect(await sendPending(admin, f.send)).toEqual({ sent: 0, retry: 0, failed: 0, dropped: 2 });
    for (const id of ids) expect((await row(id)).status).toBe("dropped");
    expect(f.sent).toHaveLength(0);
  });
  it("wording is a generic placeholder and carries no stored params, and a hostile template name cannot inject anything", async () => {
    const c = await F.cand();
    await queue({ candidate_user_id: c, template: "evil\r\nBcc: x@y.test", params: JSON.stringify({ secret: "do-not-send-me" }) });
    const f = fake();
    await sendPending(admin, f.send);
    expect(f.sent[0]!.text).toMatch(/PLACEHOLDER/);
    expect(f.sent[0]!.text).not.toContain("do-not-send-me");
    expect(f.sent[0]!.subject + f.sent[0]!.text).not.toMatch(/Bcc: /);
  });
});

describe("outbox command (main)", () => {
  it("runs end to end from DATABASE_URL as app_admin with an injected sender, and exits 1 when a row is left to retry", async () => {
    const c = await F.cand();
    await queue({ candidate_user_id: c });
    const lines: string[] = [];
    const env = { DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" };
    expect(await main([], env, (l) => lines.push(l), fake().send)).toBe(0);
    expect(lines.at(-1)).toBe("outbox: sent 1, to retry 0, failed for good 0, dropped (no address) 0");
    await queue({ candidate_user_id: c });
    expect(await main([], env, (l) => lines.push(l), fake(() => true).send)).toBe(1);
  });
  it("without a key the real command exits 2 and sends nothing (a child process, no network)", async () => {
    const c = await F.cand();
    const id = await queue({ candidate_user_id: c });
    const cli = fileURLToPath(new URL("../src/outbox-cli.ts", import.meta.url));
    const e = await promisify(execFile)(process.execPath, [cli], { env: { PATH: process.env.PATH, DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" } }).then(() => ({ code: 0, stdout: "" }), (x: { code: number; stdout: string }) => x);
    expect(e.code).toBe(2);
    expect(e.stdout).toMatch(/nothing was sent/);
    expect((await row(id)).status).toBe("pending");
  });
});

describe("outbox security", () => {
  it("only app_admin can claim or mark rows: the other app roles are refused", async () => {
    const c = await F.cand();
    await queue({ candidate_user_id: c });
    for (const role of ["app_candidate", "app_portal", "app_fetcher"] as const) {
      await expect(sendPending(db.pool(role), fake().send), role).rejects.toThrow(/permission denied/);
    }
    expect((await su.query("select count(*)::int n from email_outbox where status='pending'")).rows[0].n).toBe(1);
  });
  it("a refused sender never marks a row sent, and the error text holds no address", async () => {
    const c = await F.cand();
    const id = await queue({ candidate_user_id: c });
    const lines: string[] = [];
    await sendPending(admin, fake(() => true).send, 50, (l) => lines.push(l));
    expect((await row(id)).sent_at).toBeNull();
    expect(lines.join("")).not.toMatch(/@/);
  });
});
