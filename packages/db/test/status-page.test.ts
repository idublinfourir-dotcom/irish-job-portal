// Integration: the employer status page functions (migration 0017) on the real test database, called as app_portal. The grants 0003 gave
// app_portal on strike are gone: it reads its own company's cases through private.status_page (any active member) and writes a reply or
// an appeal through private.status_write (the account owner only, inside the windows). The route is tested in status-route.test.ts.
// Fake people only; no network.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// Time budget for status_page on a company with 50 cases among 2,000 other companies' cases, median of 9 calls. Measured on
// 12 November 2026 while two other agents ran tests on the machine: 1.78, 1.78 and 1.86 ms over three runs. The limit is about 4 times the slowest, rounded up.
const PAGE_MS = 8;

let db: TestDb, su: pg.Pool, portal: pg.Pool;
let F: { org(o?: object): Promise<number>; portal(o?: object): Promise<string>; staff(): Promise<string>; member(org: number, user: string | null, o?: object): Promise<number> };
beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  portal = db.pool("app_portal");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
});
afterAll(() => db.drop());

const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
const page = async (user: string) => (await portal.query("select private.status_page($1) r", [user])).rows[0].r;
const write = (user: string, kind: string, caseId: number, text: unknown) => portal.query("select private.status_write($1, $2, $3, $4) r", [user, kind, caseId, text]);
const refused = async (p: Promise<unknown>, code: string) => { await expect(p).rejects.toThrow(new RegExp(`^status refused: ${code}\\b`)); };
// A case as superuser (strike_guard lets the superuser set any date). decidedAgo moves the decision back without restamping it.
async function strike(org: number, o: { reply?: string; appeal?: string; outcome?: string; level?: number; stage?: string; decidedAgo?: string; kind?: string } = {}) {
  const r = await one(`insert into strike(organisation_id, case_kind, reason_code, notice_summary, stage, outcome, level, reply_due_at, appeal_due_at)
    values ($1, $2, $3, 'The advert promised sponsorship.', $4, $5, $6, now() + $7::interval, now() + $8::interval) returning id`,
  [org, o.kind ?? "false_claim", o.kind === "instant_ban" ? "fake_job" : "false_sponsorship", o.stage ?? "employer_notified", o.outcome ?? null, o.level ?? null, o.reply ?? null, o.appeal ?? null]);
  if (o.decidedAgo) await su.query("update strike set decided_at = now() - $2::interval where id = $1", [r.id, o.decidedAgo]);
  return Number(r.id);
}
const row = (id: number) => one("select employer_reply, replied_at, appeal_text, appealed_at, stage from strike where id = $1", [id]);
async function company(status = "verified") {
  const org = Number(await F.org({ status }));
  const owner = await F.portal(), viewer = await F.portal(), poster = await F.portal(), recruiter = await F.portal();
  await F.member(org, owner, { role: "account_owner" });
  await F.member(org, viewer, { role: "viewer" });
  await F.member(org, poster, { role: "poster" });
  await F.member(org, recruiter, { role: "recruiter" });
  return { org, owner, viewer, poster, recruiter };
}

describe("grants (the gap closed by 0017)", () => {
  it("app_portal can no longer read any strike row or write a reply or appeal on one directly", async () => {
    const a = await company(), b = await company();
    const sb = await strike(b.org, { reply: "3 days" });
    // before 0017 both of these worked for any company's case
    await expect(portal.query("select id, employer_reply from strike where organisation_id = $1", [b.org])).rejects.toThrow(/permission denied/);
    await expect(portal.query("update strike set employer_reply = 'not ours' where id = $1", [sb])).rejects.toThrow(/permission denied/);
    await expect(portal.query("update strike set appeal_text = 'not ours' where id = $1", [sb])).rejects.toThrow(/permission denied/);
    await expect(portal.query("select private.status_member($1)", [a.owner])).rejects.toThrow(/permission denied/); // the helper is not granted
    expect((await row(sb)).employer_reply).toBeNull();
  });
});

describe("status_page", () => {
  it("every active member sees the company's notified or decided cases, never another company's, never the reporter or staff", async () => {
    const a = await company(), b = await company();
    const waiting = await strike(a.org, { reply: "5 days" });
    await strike(a.org, { stage: "case_open" }); // not yet notified: not shown
    await strike(b.org, { reply: "5 days" });
    for (const u of [a.owner, a.viewer, a.poster, a.recruiter]) {
      const p = await page(u);
      expect(p.organisationId).toBe(a.org);
      expect(p.cases.map((c: { id: number }) => c.id)).toEqual([waiting]);
      expect(p.isOwner).toBe(u === a.owner);
      expect(p.cases[0].canReply).toBe(u === a.owner);
    }
    const c = (await page(a.owner)).cases[0];
    expect(Object.keys(c).sort()).toEqual(["appealDecidedAt", "appealDueAt", "appealText", "appealedAt", "canAppeal", "canReply", "caseKind", "createdAt", "decidedAt",
      "employerReply", "id", "jobId", "jobTitle", "level", "noticeSummary", "notifiedAt", "outcome", "reasonCode", "repliedAt", "replyDueAt", "stage"]);
    expect(JSON.stringify(await page(a.owner))).not.toMatch(/report|staff|received/i);
  });

  it("counts strikes in the last 12 months (overturned and older ones left out) and shows restriction and suspension", async () => {
    const a = await company();
    expect((await page(a.owner))).toMatchObject({ strikesLast12Months: 0, cases: [], status: "verified", restrictedUntil: null });
    await strike(a.org, { outcome: "strike", level: 1, stage: "applied", decidedAgo: "2 months", appeal: "-1 day" });
    await strike(a.org, { outcome: "strike", level: 1, stage: "applied", decidedAgo: "13 months" });
    const over = await strike(a.org, { outcome: "strike", level: 1, stage: "applied", appeal: "5 days" });
    const staff = await F.staff(), c = await su.connect(); // the trigger stamps the appeal decider from the acting staff id
    try { await c.query("begin"); await c.query("select set_config('app.staff_user_id', $1, true)", [staff]);
      await c.query("update strike set appeal_text = 'unfair', appealed_at = now() where id = $1", [over]);
      await c.query("update strike set stage = 'overturned' where id = $1", [over]); await c.query("commit"); } finally { c.release(); }
    const r = await su.connect(); // a strike 2 restriction without the two-person path (trust-safety.test.ts proves that path): triggers off for this one write
    try { await r.query("begin"); await r.query("set local session_replication_role = replica");
      await r.query("update organisation set restricted_until = now() + interval '90 days' where id = $1", [a.org]); await r.query("commit"); } finally { r.release(); }
    const p = await page(a.viewer);
    expect(p.strikesLast12Months).toBe(1);
    expect(p.restrictedUntil).not.toBeNull();
    expect(p.cases.find((c: { id: number }) => c.id === over)).toMatchObject({ stage: "overturned", appealText: "unfair", canAppeal: false });
    const s = await company("suspended");
    await strike(s.org, { kind: "instant_ban", reply: "7 days" });
    expect(await page(s.owner)).toMatchObject({ status: "suspended", cases: [{ caseKind: "instant_ban", canReply: true }] });
  });

  it("refuses a removed member, a blocked or deleted login, a login with no company and an unknown id", async () => {
    const a = await company();
    await strike(a.org, { reply: "5 days" });
    const removed = await F.portal(); await F.member(a.org, removed, { role: "account_owner", status: "removed" });
    const blocked = await F.portal(); await F.member(a.org, blocked, { role: "viewer" }); await su.query("update portal_user set status = 'blocked' where id = $1", [blocked]);
    const deleted = await F.portal(); await F.member(a.org, deleted, { role: "viewer" }); await su.query("update portal_user set deleted_at = now() where id = $1", [deleted]);
    const lone = await F.portal();
    await refused(page(removed), "NOT_A_MEMBER");
    await refused(page(lone), "NOT_A_MEMBER");
    await refused(page(blocked), "REFUSED");
    await refused(page(deleted), "REFUSED");
    await refused(page("no-such-login"), "REFUSED");
  });

  it(`stays within ${PAGE_MS} ms for 50 cases among 2,000 others`, async () => {
    const a = await company(), other = await F.org();
    await su.query(`insert into strike(organisation_id, case_kind, reason_code, stage, reply_due_at) select $1, 'false_claim', 'false_sponsorship', 'employer_notified', now() + interval '3 days' from generate_series(1, 2000)`, [other]);
    await su.query(`insert into strike(organisation_id, case_kind, reason_code, stage, reply_due_at) select $1, 'false_claim', 'false_sponsorship', 'employer_notified', now() + interval '3 days' from generate_series(1, 50)`, [a.org]);
    await su.query("analyze strike");
    expect((await page(a.owner)).cases).toHaveLength(50);
    const ms = [];
    for (let i = 0; i < 9; i++) { const t = performance.now(); await page(a.owner); ms.push(performance.now() - t); }
    const median = ms.sort((x, y) => x - y)[4]!;
    console.log(`status_page median ${median.toFixed(2)} ms`);
    expect(median).toBeLessThan(PAGE_MS);
  });
});

describe("status_write", () => {
  it("the owner replies once inside the window; replied_at is stamped and one audit row of codes is written", async () => {
    const a = await company();
    const k = await strike(a.org, { reply: "5 days" });
    expect((await write(a.owner, "reply", k, "  We never promised sponsorship.\nSee the advert.  ")).rows[0].r).toEqual({ caseId: k, kind: "reply" });
    const r = await row(k);
    expect(r.employer_reply).toBe("We never promised sponsorship.\nSee the advert.");
    expect(r.replied_at).not.toBeNull();
    await refused(write(a.owner, "reply", k, "second thoughts"), "ALREADY_REPLIED");
    const audit = (await su.query("select kind, actor_portal_user_id, before, after, reason_text from audit_event where action = 'strike.reply' and object_id = $1", [String(k)])).rows;
    expect(audit).toEqual([{ kind: "security", actor_portal_user_id: a.owner, before: { stage: "employer_notified" }, after: { stage: "employer_notified" }, reason_text: null }]);
    expect((await page(a.owner)).cases[0]).toMatchObject({ canReply: false, employerReply: r.employer_reply });
  });

  it("refuses a reply after the due date, on a decided case, and on a case not yet notified", async () => {
    const a = await company();
    const late = await strike(a.org, { reply: "-1 minute" });
    const decided = await strike(a.org, { reply: "5 days", outcome: "cleared", stage: "decided" });
    const unsent = await strike(a.org, { stage: "case_open" });
    await refused(write(a.owner, "reply", late, "late"), "REPLY_CLOSED");
    await refused(write(a.owner, "reply", decided, "after"), "REPLY_CLOSED");
    await refused(write(a.owner, "reply", unsent, "early"), "CASE_NOT_FOUND");
    for (const k of [late, decided, unsent]) expect((await row(k)).employer_reply).toBeNull();
  });

  it("the owner appeals once inside the appeal window; the case becomes appealed", async () => {
    const a = await company();
    const k = await strike(a.org, { outcome: "strike", level: 1, stage: "applied", appeal: "5 days" });
    expect((await page(a.owner)).cases[0].canAppeal).toBe(true);
    await write(a.owner, "appeal", k, "The job did not ask for sponsorship.");
    expect(await row(k)).toMatchObject({ appeal_text: "The job did not ask for sponsorship.", stage: "appealed" });
    expect((await row(k)).appealed_at).not.toBeNull();
    await refused(write(a.owner, "appeal", k, "again"), "ALREADY_APPEALED");
    expect((await page(a.owner)).cases[0]).toMatchObject({ canAppeal: false, stage: "appealed" });
  });

  it("refuses an appeal before the decision, after the appeal window, and after the appeal is decided", async () => {
    const a = await company();
    const open = await strike(a.org, { reply: "5 days", appeal: "5 days" });
    const late = await strike(a.org, { outcome: "strike", level: 1, stage: "applied", appeal: "-1 minute" });
    const none = await strike(a.org, { outcome: "cleared", stage: "decided" }); // cleared: no appeal window
    await refused(write(a.owner, "appeal", open, "x"), "APPEAL_CLOSED");
    await refused(write(a.owner, "appeal", late, "x"), "APPEAL_CLOSED");
    await refused(write(a.owner, "appeal", none, "x"), "APPEAL_CLOSED");
    for (const k of [open, late, none]) expect((await row(k)).appeal_text).toBeNull();
  });

  it("every other role and login changes nothing: members who are not the owner, another company's owner, removed, blocked, no company", async () => {
    const a = await company(), b = await company();
    const k = await strike(a.org, { reply: "5 days", outcome: "strike", level: 1, stage: "applied", appeal: "5 days" });
    await su.query("update strike set decided_at = null where id = $1", [k]); // reply and appeal both look open in time; the checks must still hold
    const removed = await F.portal(); await F.member(a.org, removed, { role: "account_owner", status: "removed" });
    const blocked = await F.portal(); await F.member(Number(await F.org()), blocked, { role: "account_owner" }); await su.query("update portal_user set status = 'blocked' where id = $1", [blocked]);
    const lone = await F.portal();
    for (const kind of ["reply", "appeal"]) {
      for (const u of [a.viewer, a.poster, a.recruiter, b.viewer]) await refused(write(u, kind, k, "x"), "NOT_OWNER");
      await refused(write(b.owner, kind, k, "x"), "CASE_NOT_FOUND");
      await refused(write(removed, kind, k, "x"), "NOT_A_MEMBER");
      await refused(write(lone, kind, k, "x"), "NOT_A_MEMBER");
      await refused(write(blocked, kind, k, "x"), "REFUSED");
    }
    expect(await row(k)).toMatchObject({ employer_reply: null, appeal_text: null, replied_at: null, appealed_at: null });
    expect((await one("select count(*)::int n from audit_event where object_type = 'strike' and object_id = $1", [String(k)])).n).toBe(0);
  });

  it("refuses hostile text and kinds, and stores text that looks like SQL as plain text", async () => {
    const a = await company();
    const k = await strike(a.org, { reply: "5 days" });
    for (const t of [null, "", "   ", "x".repeat(1801), "a\u202eb", "a\u0007b", "a\u200bb", "a\ufeffb", "a\u0085b"]) await refused(write(a.owner, "reply", k, t), "BAD_TEXT");
    await refused(write(a.owner, "decide", k, "x"), "BAD_REQUEST");
    await refused(write(a.owner, "reply", 999999999, "x"), "CASE_NOT_FOUND");
    expect((await row(k)).employer_reply).toBeNull();
    const sql = "'); update strike set outcome = 'cleared'; --\tend";
    await write(a.owner, "reply", k, sql);
    expect((await row(k)).employer_reply).toBe(sql);
    const k2 = await strike(a.org, { reply: "5 days" });
    await write(a.owner, "reply", k2, "y".repeat(1800));
  });
});
