// Step 8 slice 8.1b: the outbox sender command on the test database, as app_admin, with a fake Brevo (an injected send function).
// No test calls the real network. Fake people only.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { main, sendPending, MAX_ATTEMPTS, ALERTS, LIVE_JOBS, reservedAddress } from "../src/outbox-cli.ts";
import { writeDigest } from "../src/staff-digest-cli.ts";
import { createBrevoMail, BREVO_URL } from "../../auth/src/brevo.ts";
import { deleteAccount } from "../src/candidate.ts";
import { socTitle } from "../../rules/src/soc.ts";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
let db: TestDb, su: pg.Pool, admin: pg.Pool;
let F: { cand(o?: object): Promise<string>; portal(o?: object): Promise<string>; staff(): Promise<string>; org(): Promise<number>; member(org: number, user: string | null, o?: object): Promise<number> };
type Sent = { to: string; subject: string; text: string; html: string; headers?: Record<string, string> };
const fake = (fail: (to: string) => boolean = () => false) => {
  const sent: Sent[] = [];
  return { sent, send: async (to: string, subject: string, text: string, html: string, headers?: Record<string, string>) => { if (fail(to)) throw new Error("Brevo send failed: HTTP 500"); sent.push({ to, subject, text, html, headers }); } };
};
let n = 0;
const queue = async (cols: Record<string, unknown>) => {
  const k = Object.keys({ template: "t", dedupe_key: `k${++n}`, ...cols }), v = Object.values({ template: "t", dedupe_key: `k${n}`, ...cols });
  return Number((await su.query(`insert into email_outbox(${k.join(",")}) values(${k.map((_, i) => `$${i + 1}`).join(",")}) returning id`, v)).rows[0].id);
};
const CAND = "https://www.example.ie", EMPL = "https://employers.example.ie";
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
    expect(await sendPending(admin, f.send)).toEqual({ sent: 6, retry: 0, failed: 0, dropped: 0, old: 0 });
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
    expect(await sendPending(admin, bad.send)).toEqual({ sent: 0, retry: 0, failed: 0, dropped: 0, old: 0 }); // never tried again
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
    const slow = async (...a: [string, string, string, string]) => { await new Promise((r) => setTimeout(r, 5)); return f.send(...a); };
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
  it("the deleted-account notice goes to the address in params.email; another template for a deleted login with the same params is still dropped", async () => {
    const gone = await F.cand();
    await deleteAccount(db.pool("app_candidate"), gone); // the real D2 delete: deleted_at set, the notice queued with params.email
    const notice = Number((await su.query("select id from email_outbox where template='account_deleted' and candidate_user_id=$1", [gone])).rows[0].id);
    const other = await queue({ candidate_user_id: gone, template: "t", params: JSON.stringify({ email: "gone@example.test" }) });
    const noEmail = await queue({ candidate_user_id: gone, template: "account_deleted", params: JSON.stringify({}) });
    const f = fake();
    expect(await sendPending(admin, f.send)).toEqual({ sent: 1, retry: 0, failed: 0, dropped: 2, old: 0 });
    expect(f.sent.map((x) => x.to)).toEqual([`${gone}@example.test`]);
    expect(await row(notice)).toMatchObject({ status: "sent" });
    for (const id of [other, noEmail]) expect((await row(id)).status).toBe("dropped");
  });
  it("drops a row with no address: a deleted candidate, an erased person, an invite-less member", async () => {
    const gone = await F.cand({ deleted: new Date() });
    const ids = [await queue({ candidate_user_id: gone }), await queue({ candidate_user_id: "erased-123" })];
    const f = fake();
    expect(await sendPending(admin, f.send)).toEqual({ sent: 0, retry: 0, failed: 0, dropped: 2, old: 0 });
    for (const id of ids) expect((await row(id)).status).toBe("dropped");
    expect(f.sent).toHaveLength(0);
  });
  it("a notice carries no stored params (not even a staff reason), and a hostile template name cannot inject anything", async () => {
    const c = await F.cand(), p = await F.portal();
    await queue({ candidate_user_id: c, template: "evil\r\nBcc: x@y.test", params: JSON.stringify({ secret: "do-not-send-me" }) });
    await queue({ portal_user_id: p, template: "account_needs_info", params: JSON.stringify({ organisationId: "1", reason: "STAFF-REASON-CODE", question: "Staff typed this <b>" }) });
    const f = fake();
    await sendPending(admin, f.send, 50, undefined, CAND, EMPL);
    expect(f.sent).toHaveLength(2);
    for (const m of f.sent) {
      expect(m.subject + m.text + m.html).not.toMatch(/do-not-send-me|STAFF-REASON-CODE|Staff typed|Bcc: |PLACEHOLDER/);
      expect(m.html).toContain("Sign in");
    }
  });
  it("each notice links to the person's own site: a candidate to SITE_URL, an employer or a team member to PORTAL_SITE_URL, a staff or contact row to none", async () => {
    const c = await F.cand(), p = await F.portal(), s = await F.staff(), o = await F.org(), m = await F.member(o, p);
    const cm = Number((await su.query("insert into contact_message(surface,from_name,from_email,topic,body) values ('portal','Pat','pat2@example.test','general','Hi') returning id")).rows[0].id);
    await queue({ candidate_user_id: c, template: "account_merged" });
    await queue({ portal_user_id: p, template: "job_hidden" });
    await queue({ membership_id: m, template: "team_removed" });
    await queue({ staff_user_id: s, template: "t" });
    await queue({ contact_message_id: cm, template: "t" });
    const f = fake();
    expect((await sendPending(admin, f.send, 50, undefined, CAND, EMPL)).sent).toBe(5);
    const links = (to: string) => [...f.sent.filter((x) => x.to === to).flatMap((x) => [...x.html.matchAll(/href="([^"]+)"/g)].map((h) => h[1]))];
    expect(new Set(links(`${c}@example.test`))).toEqual(new Set([`${CAND}/`, `${CAND}/account/settings`])); // a candidate notice also links to the notification settings (B75)
    expect(new Set(links(`${p}@example.test`))).toEqual(new Set([`${EMPL}/`]));
    expect(links(`${s}@example.test`)).toEqual([]);
    expect(links("pat2@example.test")).toEqual([]);
    expect(f.sent.find((x) => x.subject === "You have left a company team")).toBeDefined();
  });
});

describe("outbox command (main)", () => {
  it("runs end to end from DATABASE_URL as app_admin with an injected sender, and exits 1 when a row is left to retry", async () => {
    const c = await F.cand();
    await queue({ candidate_user_id: c });
    const lines: string[] = [];
    const env = { DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable", SITE_URL: CAND, PORTAL_SITE_URL: EMPL };
    expect(await main([], env, (l) => lines.push(l), fake().send)).toBe(0);
    expect(lines.at(-1)).toBe("outbox: sent 1, to retry 0, failed for good 0, dropped (no address, nothing to send or too old) 0");
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

// Step 11 part 11c: the job_alert template, built at send time (the row shape is the one 11b writes).
describe("job alert email", () => {
  const SITE = "https://portal.example.ie";
  const hour = 3600_000;
  let org: number, src: number, tok = 0;
  beforeAll(async () => {
    org = await F.org();
    src = Number((await su.query("insert into job_source(kind, board) values ('portal', 'alert-email') returning id")).rows[0].id);
  });
  /** n live jobs (or another status), returning their ids oldest first. */
  const jobs = async (n: number, o: { status?: string; title?: string } = {}) => (await su.query(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, permit_type, salary_low, salary_high, status, closes_at, own_page_url, search_vector ${o.status === "closed" ? ", close_reason" : ""})
     select $1, 'admin_manual', $2, $3 || ' ' || g, 'Fake Employer', 'Cork', 'it', 'critical_skills', 40000, 50000, '${o.status ?? "live"}', now() + interval '10 days', 'https://example.test/a', to_tsvector('english','cook') ${o.status === "closed" ? ", 'closed'" : ""}
     from generate_series(1, $4::int) g returning id::text`, [org, src, o.title ?? "Cook", n])).rows.map((r) => r.id as string);
  const alertFor = async (c: string, o: Record<string, unknown> = {}) => {
    const cols = { candidate_user_id: c, frequency: "daily", unsubscribe_token: `tok${++tok}`.padEnd(40, "z"), ...o };
    const k = Object.keys(cols);
    return String((await su.query(`insert into alert(${k.join(",")}) values(${k.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(cols))).rows[0].id);
  };
  const alertRow = (c: string, alerts: [string, string[]][], o: Record<string, unknown> = {}) =>
    queue({ template: "job_alert", candidate_user_id: c, dedupe_key: `job_alert:${c}:${++n}`, params: JSON.stringify({ run_on: "2026-11-13", alerts: alerts.map(([a, j]) => ({ alert_id: Number(a), job_ids: j.map(Number) })) }), ...o });
  const tokenOf = async (a: string) => (await su.query("select unsubscribe_token t from alert where id=$1", [a])).rows[0].t as string;

  it("sends one HTML and text email for one alert: filters in words, a line and link per job, both unsubscribe links, the one-click headers", async () => {
    const c = await F.cand(), [j1, j2] = await jobs(2);
    const a = await alertFor(c, { county: "Cork", occupation_code: "2134" }), t = await tokenOf(a);
    const id = await alertRow(c, [[a, [j2!, j1!]]]);
    const f = fake();
    expect(await sendPending(admin, f.send, 50, undefined, SITE)).toEqual({ sent: 1, retry: 0, failed: 0, dropped: 0, old: 0 });
    const m = f.sent[0]!;
    expect(m.to).toBe(`${c}@example.test`);
    expect(m.text + m.html).not.toContain("PLACEHOLDER");
    expect(m.html).toContain(`href="${SITE}/jobs/${j2}"`);
    expect(m.text).toContain(`occupation ${socTitle("2134")} (2134), county Cork (daily)`);
    expect(m.text).toContain(`- Cook 2, Fake Employer, Cork, €40,000 to €50,000\n  ${SITE}/jobs/${j2}`);
    expect(m.text.indexOf(`/jobs/${j2}`)).toBeLessThan(m.text.indexOf(`/jobs/${j1}`)); // the row's order (newest first) is kept
    expect(m.text).toContain(`${SITE}/api/alerts/unsubscribe?token=${t}&scope=one`);
    expect(m.text).toContain(`${SITE}/api/alerts/unsubscribe?token=${t}&scope=all`);
    expect(m.headers).toEqual({ "List-Unsubscribe": `<${SITE}/api/alerts/unsubscribe?token=${t}&scope=all>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 1 });
  });
  it("B78: the job's badge and pay scale come from the database; the subject has the count and the alert's name; the links open this alert", async () => {
    const c = await F.cand(), [j1, j2] = await jobs(2);
    await su.query("update job set badge = 'critical_skills_eligible' where id = $1", [j1]);
    await su.query("update job set salary_low = null, salary_high = null, pay_grade = 'Grade III' where id = $1", [j2]);
    const a = await alertFor(c, { county: "Cork", sector: "it" });
    await alertRow(c, [[a, [j1!, j2!]]]);
    const f = fake();
    await sendPending(admin, f.send, 50, undefined, SITE);
    const m = f.sent[0]!;
    expect(m.subject).toBe("2 new jobs: it in Cork");
    expect(m.html).toMatch(/Cook 1<\/a> <span[^>]*>Critical<\/span>/);
    expect(m.html).not.toMatch(/Cook 2<\/a> <span/); // no badge, no pill (the Sponsor pill is held in job-alert-email.test.ts: a database sponsor badge needs a signed statement)
    expect(m.text).toContain("Fake Employer, Cork, €40,000 to €50,000, Critical Skills eligible");
    expect(m.text).toContain("Fake Employer, Cork, Public pay scale (Grade III)\n");
    expect(m.text).toContain(`Edit this alert: ${SITE}/account/alerts?edit=${a}`);
    expect(m.html).toContain(`href="${SITE}/jobs?sector=it&amp;county=Cork"`);
  });
  it("several alerts make one email with one block each; a notice of another template carries no headers", async () => {
    const c = await F.cand(), [j1, j2, j3] = await jobs(3);
    const a1 = await alertFor(c, { sector: "it" }), a2 = await alertFor(c, { salary_min: 30000, badge: "sponsor_confirmed", frequency: "weekly" });
    await alertRow(c, [[a1, [j1!, j2!]], [a2, [j3!]]]);
    await queue({ candidate_user_id: c });
    const f = fake();
    expect(await sendPending(admin, f.send, 50, undefined, SITE)).toMatchObject({ sent: 2 });
    const [alertMail, notice] = [f.sent.find((x) => x.text.includes("Your alert"))!, f.sent.find((x) => !x.text.includes("Your alert"))!];
    expect(alertMail.text.match(/Your alert:/g)).toHaveLength(2);
    expect(alertMail.text).toContain("sector it (daily)");
    expect(alertMail.text).toContain("pay from €30,000 a year, only employers with a confirmed sponsor (weekly)");
    expect(alertMail.text.match(/\/jobs\//g)).toHaveLength(3);
    expect(notice.headers).toBeUndefined();
  });
  it("leaves out a job closed since queueing (closed, or past its closing time), and drops the row when all are closed", async () => {
    const c = await F.cand(), [j1, j2, j3] = await jobs(3);
    const a = await alertFor(c);
    await su.query("update job set status='closed', close_reason='closed' where id=$1", [j1]);
    await su.query("update job set closes_at = now() - interval '1 minute' where id=$1", [j2]);
    const id = await alertRow(c, [[a, [j1!, j2!, j3!]]]);
    const f = fake();
    await sendPending(admin, f.send, 50, undefined, SITE);
    expect(f.sent[0]!.text).toContain(`/jobs/${j3}\n`);
    expect(f.sent[0]!.text).not.toMatch(new RegExp(`/jobs/(${j1}|${j2})\\b`));
    expect(await row(id)).toMatchObject({ status: "sent" });
    await su.query("update job set status='closed', close_reason='closed' where id=$1", [j3]);
    const id2 = await alertRow(c, [[a, [j1!, j2!, j3!]]]);
    const g = fake();
    expect(await sendPending(admin, g.send, 50, undefined, SITE)).toEqual({ sent: 0, retry: 0, failed: 0, dropped: 1, old: 0 });
    expect(g.sent).toHaveLength(0);
    expect(await row(id2)).toMatchObject({ status: "dropped", sent_at: null });
  });
  it("drops a row queued more than 3 days ago and sends one queued just under 3 days ago", async () => {
    const c = await F.cand(), [j] = await jobs(1);
    const a = await alertFor(c);
    const old = await alertRow(c, [[a, [j!]]], { send_after: new Date(Date.now() - 72 * hour - 60_000) });
    const edge = await alertRow(c, [[a, [j!]]], { send_after: new Date(Date.now() - 72 * hour + 60_000) });
    const f = fake();
    expect(await sendPending(admin, f.send, 50, undefined, SITE)).toEqual({ sent: 1, retry: 0, failed: 0, dropped: 1, old: 1 });
    expect((await row(old)).status).toBe("dropped");
    expect((await row(edge)).status).toBe("sent");
  });
  it("leaves out an alert unsubscribed or paused since queueing, and drops the row when none is active", async () => {
    const c = await F.cand(), [j1, j2] = await jobs(2);
    const keep = await alertFor(c, { sector: "it" }), gone = await alertFor(c, { county: "Kerry" }), paused = await alertFor(c, { county: "Mayo" });
    await su.query("update alert set status='unsubscribed' where id=$1", [gone]);
    await su.query("update alert set status='paused', pause_reason='candidate' where id=$1", [paused]);
    await alertRow(c, [[keep, [j1!]], [gone, [j2!]], [paused, [j2!]]]);
    const f = fake();
    await sendPending(admin, f.send, 50, undefined, SITE);
    expect(f.sent[0]!.text).toContain(`/jobs/${j1}\n`);
    expect(f.sent[0]!.text).not.toContain(`/jobs/${j2}\n`);
    expect(f.sent[0]!.text).not.toContain(await tokenOf(gone));
    expect(f.sent[0]!.text).not.toContain("Kerry");
    await su.query("update alert set status='unsubscribed' where id=$1", [keep]);
    const id = await alertRow(c, [[keep, [j1!]], [gone, [j2!]]]);
    expect((await sendPending(admin, fake().send, 50, undefined, SITE)).dropped).toBe(1);
    expect((await row(id)).status).toBe("dropped");
  });
  it("a candidate suspended after queueing gets nothing (row dropped); a job that became quota_full is left out, and the row is dropped if it was the only one", async () => {
    const c = await F.cand(), s = await F.cand(), [j1, j2] = await jobs(2);
    const a = await alertFor(c), as = await alertFor(s);
    await su.query("update job set quota_full = true where id = $1", [j1]);
    const full = await alertRow(c, [[a, [j1!]]]);
    const susp = await alertRow(s, [[as, [j2!]]]);
    await su.query("update candidate_user set suspended_at = now() where id = $1", [s]);
    const f = fake();
    expect(await sendPending(admin, f.send, 50, undefined, SITE)).toEqual({ sent: 0, retry: 0, failed: 0, dropped: 2, old: 0 });
    expect(f.sent).toHaveLength(0);
    for (const id of [full, susp]) expect(await row(id)).toMatchObject({ status: "dropped", sent_at: null });
    const mixed = await alertRow(c, [[a, [j1!, j2!]]]);
    await sendPending(admin, f.send, 50, undefined, SITE);
    expect(await row(mixed)).toMatchObject({ status: "sent" });
    expect(f.sent[0]!.text).toContain(`/jobs/${j2}\n`);
    expect(f.sent[0]!.text).not.toContain(`/jobs/${j1}\n`);
  });
  it("never shows another candidate's alerts: an alert id of someone else in the row is ignored (links, filters and token), a row with only those is dropped", async () => {
    const me = await F.cand(), other = await F.cand(), [j1, j2] = await jobs(2);
    const mine = await alertFor(me, { sector: "it" }), theirs = await alertFor(other, { county: "Galway" });
    await alertRow(me, [[theirs, [j2!]], [mine, [j1!]]]);
    const f = fake();
    await sendPending(admin, f.send, 50, undefined, SITE);
    const text = f.sent[0]!.text, t = await tokenOf(theirs);
    expect(text).toContain(`/jobs/${j1}\n`);
    for (const leak of [t, "Galway", `/jobs/${j2}\n`, other]) expect(text + JSON.stringify(f.sent[0]!.headers)).not.toContain(leak);
    const id = await alertRow(me, [[theirs, [j2!]]]);
    const g = fake();
    expect((await sendPending(admin, g.send, 50, undefined, SITE)).dropped).toBe(1);
    expect(g.sent).toHaveLength(0);
    expect((await row(id)).status).toBe("dropped");
  });
  it("a hostile row (bad ids, too many, wrong shape) sends nothing wrong and runs no injected SQL", async () => {
    const c = await F.cand(), [j] = await jobs(1), a = await alertFor(c);
    const bad = [await queue({ template: "job_alert", candidate_user_id: c, params: JSON.stringify({ alerts: [{ alert_id: "1 or 1=1", job_ids: ["1; drop table job"] }, { alert_id: Number(a), job_ids: [1e300, -1, "x", null] }] }) }),
      await queue({ template: "job_alert", candidate_user_id: c, params: JSON.stringify("alerts") }), await queue({ template: "job_alert", candidate_user_id: c })];
    const big = await alertRow(c, Array.from({ length: 30 }, () => [a, Array.from({ length: 50 }, () => j!)] as [string, string[]]));
    const f = fake();
    expect(await sendPending(admin, f.send, 50, undefined, SITE)).toEqual({ sent: 1, retry: 0, failed: 0, dropped: 3, old: 0 });
    for (const id of bad) expect((await row(id)).status).toBe("dropped");
    expect((await row(big)).status).toBe("sent");
    expect(f.sent[0]!.text.match(/Your alert:/g)).toHaveLength(10); // 30 alerts in the row: only the first 10 are read (D1)
    expect(f.sent[0]!.text.match(/\/jobs\//g)).toHaveLength(10 * 20); // and 20 jobs each
  });
  it("SITE_URL and PORTAL_SITE_URL: the command refuses to start when a row is pending and either is unset or not https; with both set it sends", async () => {
    const c = await F.cand(), [j] = await jobs(1), a = await alertFor(c);
    const id = await alertRow(c, [[a, [j!]]]);
    const lines: string[] = [];
    const env = { DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" };
    for (const bad of [undefined, "", "http://portal.example.ie", "portal.example.ie", "https://user:pw@x.example.ie"]) {
      for (const sites of [{ SITE_URL: bad, PORTAL_SITE_URL: EMPL }, { SITE_URL: SITE, PORTAL_SITE_URL: bad }]) {
        const f = fake();
        expect(await main([], { ...env, ...sites }, (l) => lines.push(l), f.send), JSON.stringify(sites)).toBe(2);
        expect(f.sent).toHaveLength(0);
        expect((await row(id)).status).toBe("pending");
      }
    }
    expect(lines.every((l) => /SITE_URL and PORTAL_SITE_URL/.test(l) && !l.includes("@"))).toBe(true);
    const f = fake();
    expect(await main([], { ...env, SITE_URL: SITE, PORTAL_SITE_URL: EMPL }, (l) => lines.push(l), f.send)).toBe(0);
    expect(f.sent).toHaveLength(1);
    // with nothing pending, neither is needed
    expect(await main([], env, (l) => lines.push(l), fake().send)).toBe(0);
  });
  it("a row sent without SITE_URL through sendPending is retried, not lost or sent with a bad link", async () => {
    const c = await F.cand(), [j] = await jobs(1), a = await alertFor(c);
    const id = await alertRow(c, [[a, [j!]]]);
    const f = fake();
    expect(await sendPending(admin, f.send, 50, undefined, "http://portal.example.ie")).toMatchObject({ sent: 0, retry: 1 });
    expect(f.sent).toHaveLength(0);
    expect((await row(id)).status).toBe("pending");
  });
  it("logs hold counts and row ids only, never an address, a token or a title", async () => {
    const c = await F.cand(), [j] = await jobs(1, { title: "SecretTitle" }), a = await alertFor(c);
    await alertRow(c, [[a, [j!]]]);
    const lines: string[] = [];
    await sendPending(admin, fake(() => true).send, 50, (l) => lines.push(l), SITE);
    expect(lines.join("\n")).toMatch(/row \d+ try 1/);
    expect(lines.join("\n")).not.toMatch(/@|example|SecretTitle|tok\d/);
  });
  it("through the real Brevo sender with a faked fetch: notices and the job alert go as HTML plus text with the sender name, the alert from its own sender", async () => {
    const c = await F.cand(), p = await F.portal(), [j] = await jobs(1, { title: '<script>alert(1)</script>"><img src=x onerror=1>' }), a = await alertFor(c);
    await alertRow(c, [[a, [j!]]]);
    await queue({ candidate_user_id: c, template: "inactive-warning" });
    await queue({ portal_user_id: p, template: "owner_transferred" });
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFake = (async (url: string, init: RequestInit) => (calls.push({ url, body: JSON.parse(init.body as string) }), new Response("{}", { status: 201 }))) as unknown as typeof fetch;
    const notices = createBrevoMail({ apiKey: "xkeysib-test", from: "no-reply@account.example.ie", fetch: fetchFake });
    const alertsMail = createBrevoMail({ apiKey: "xkeysib-test", from: "no-reply@alerts.example.ie", fetch: fetchFake });
    expect(await sendPending(admin, notices, 50, undefined, SITE, EMPL, alertsMail)).toEqual({ sent: 3, retry: 0, failed: 0, dropped: 0, old: 0 });
    expect(calls).toHaveLength(3);
    for (const { url, body } of calls) {
      expect(url).toBe(BREVO_URL);
      expect((body.sender as { name: string }).name).toBe("irishworkpermit.ie");
      expect(String(body.htmlContent)).toMatch(/^<!doctype html>/);
      expect(String(body.textContent).length).toBeGreaterThan(50);
      expect(String(body.htmlContent)).not.toMatch(/<script|<img/);
      expect(Object.keys(body.headers ?? {}).every((k) => /^List-Unsubscribe(-Post)?$/.test(k))).toBe(true); // nothing the sender refuses
    }
    const alert = calls.find((x) => /^\d+ new jobs?\b/.test(String(x.body.subject)))!;
    expect((alert.body.sender as { email: string }).email).toBe("no-reply@alerts.example.ie");
    expect(String(alert.body.htmlContent)).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(alert.body.headers).toMatchObject({ "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    for (const n of calls.filter((x) => x !== alert)) {
      expect((n.body.sender as { email: string }).email).toBe("no-reply@account.example.ie");
      expect(n.body).not.toHaveProperty("headers");
    }
    expect(String(calls.find((x) => x.body.subject === "You are now the account owner")!.body.htmlContent)).toContain(`href="${EMPL}/"`);
  });
  // #275: Brevo Free sends 300 a day; the run takes 200. Through the real command (main) as app_admin with the fake sender.
  const ENV = () => ({ DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable", SITE_URL: SITE, PORTAL_SITE_URL: EMPL });
  const lastRun = async () => (await su.query("select actor_system, after from audit_event where action = 'email_outbox.run' order by id desc limit 1")).rows[0];
  it("#275: 250 job alerts and 20 newer notices: every notice goes first, 200 in all, 70 left, and the warning and the audit row hold the right counts only", async () => {
    const cs = await Promise.all(Array.from({ length: 25 }, () => F.cand()));
    const [j] = await jobs(1);
    const as = await Promise.all(cs.map((c) => alertFor(c)));
    for (let i = 0; i < 250; i++) await alertRow(cs[i % 25]!, [[as[i % 25]!, [j!]]], { send_after: new Date(Date.now() - 2 * hour - i * 1000) });
    for (let i = 0; i < 20; i++) await queue({ template: "account_merged", candidate_user_id: cs[i]!, send_after: new Date(Date.now() - 60_000) });
    const lines: string[] = [], f = fake();
    expect(await main(["--batch", "200"], ENV(), (l) => lines.push(l), f.send)).toBe(0);
    expect(f.sent).toHaveLength(200);
    expect(f.sent.slice(0, 20).every((m) => m.subject === "Your accounts have been joined")).toBe(true);
    expect(f.sent.slice(20).some((m) => m.subject === "Your accounts have been joined")).toBe(false);
    expect((await su.query("select count(*)::int n from email_outbox where status = 'pending' and template = 'job_alert'")).rows[0].n).toBe(70);
    expect(lines.at(-1)).toBe("::warning::email outbox (#275, Brevo Free 300 a day): 70 emails left unsent; dropped this run: 0 job alerts too old (over 3 days), 0 with no address or nothing to send");
    expect(await lastRun()).toEqual({ actor_system: "outbox-cli by app_admin", after: { sent: 200, retry: 0, failed: 0, dropped: 0, old: 0, left: 70 } });
    // security: counts only, never an address, a candidate id or a title
    for (const l of lines) { expect(l).not.toMatch(/@|Cook/); for (const c of cs) expect(l).not.toContain(c); }
    // the next run sends the 70 and is quiet
    lines.length = 0;
    expect(await main(["--batch", "200"], ENV(), (l) => lines.push(l), fake().send)).toBe(0);
    expect(lines.some((l) => l.startsWith("::warning::"))).toBe(false);
    expect((await lastRun()).after).toMatchObject({ sent: 70, left: 0 });
  });
  it("#275: an alert dropped as too old is warned about even with nothing left, and a run with nothing to do is quiet", async () => {
    const c = await F.cand(), [j] = await jobs(1), a = await alertFor(c);
    await alertRow(c, [[a, [j!]]], { send_after: new Date(Date.now() - 80 * hour) });
    await queue({ candidate_user_id: "nobody" }); // no address: dropped, not a limit problem
    const lines: string[] = [];
    expect(await main([], ENV(), (l) => lines.push(l), fake().send)).toBe(0);
    expect(lines.at(-1)).toBe("::warning::email outbox (#275, Brevo Free 300 a day): 0 emails left unsent; dropped this run: 1 job alerts too old (over 3 days), 1 with no address or nothing to send");
    lines.length = 0;
    expect(await main([], ENV(), (l) => lines.push(l), fake().send)).toBe(0);
    expect(lines).toEqual(["outbox: sent 0, to retry 0, failed for good 0, dropped (no address, nothing to send or too old) 0"]);
  });
  it("#275: the next staff digest gives administrators the numbers of the last run (counts only) and other staff none", async () => {
    const cs = await Promise.all(Array.from({ length: 3 }, () => F.cand()));
    for (const c of cs) await alertFor(c);
    for (let i = 0; i < 3; i++) await queue({ template: "account_merged", candidate_user_id: cs[i]! });
    expect(await main(["--batch", "1"], ENV(), () => {}, fake().send)).toBe(0); // 1 sent, 2 left
    const ad = await F.staff(), ts = await F.staff();
    await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, 'administrator', true), ($2, 'trust_and_safety', true)", [ad, ts]);
    await su.query("insert into report(target_kind, target_job_id, reason) select 'job', id, 'no_sponsorship' from job where status = 'live' limit 1"); // work for trust_and_safety
    await su.query("delete from email_outbox where template = 'staff_report_new'");
    await writeDigest(admin);
    const subscribers = (await su.query("select count(distinct candidate_user_id)::int n from alert where status = 'active'")).rows[0].n;
    const params = async (s: string) => (await su.query("select params from email_outbox where template = 'staff_digest' and staff_user_id = $1", [s])).rows[0]?.params;
    expect(await params(ad)).toMatchObject({ emailsLeft: 2, alertSubscribers: subscribers });
    expect(await params(ad)).not.toHaveProperty("alertsTooOld"); // zero: no line
    const t = await params(ts);
    for (const k of ["emailsLeft", "alertsTooOld", "alertSubscribers"]) expect(t).not.toHaveProperty(k);
    await su.query("update email_outbox set status = 'dropped' where template <> 'staff_digest'");
    const f = fake();
    await sendPending(admin, f.send, 50);
    const m = f.sent.find((x) => x.to === `${ad}@example.test`)!;
    expect(m.text).toContain("Emails left unsent by the last send run: 2");
    expect(m.text).toContain(`Active job alert subscribers: ${subscribers}`);
    for (const c of cs) expect(m.text + m.html).not.toContain(c);
  });
  it("E2: the real run drops a reserved address (the dev staff dev-admin@portal.invalid, .test, example.com) and never sends it; counts say dropped", async () => {
    await su.query("update email_outbox set status = 'dropped' where status = 'pending'");
    const dev = await F.staff(), real = await F.staff();
    await su.query("update staff_user set email = 'dev-admin@portal.invalid' where id = $1", [dev]);
    await su.query("update staff_user set email = 'fake-staff@gmail.com' where id = $1", [real]); // a real-looking domain, still only the fake sender
    await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, 'administrator', true), ($2, 'administrator', true)", [dev, real]);
    await writeDigest(admin);
    const ids = async (s: string) => (await su.query("select id from email_outbox where template = 'staff_digest' and staff_user_id = $1", [s])).rows.map((r) => r.id);
    expect((await ids(dev)).length).toBe(1);
    const f = fake(), lines: string[] = [];
    expect(await main([], ENV(), (l) => lines.push(l), f.send, undefined, reservedAddress)).toBe(0); // the drop rule the real run uses by default
    expect(f.sent.map((x) => x.to)).not.toContain("dev-admin@portal.invalid");
    expect(f.sent.map((x) => x.to)).toContain("fake-staff@gmail.com");
    expect(f.sent.every((x) => !reservedAddress(x.to))).toBe(true); // every other fake person on example.test was dropped too
    expect((await su.query("select status from email_outbox where id = any($1)", [await ids(dev)])).rows).toEqual([{ status: "dropped" }]);
    expect(lines.at(-1)).toMatch(/^outbox: sent \d+, to retry 0, failed for good 0, dropped \(no address, nothing to send or too old\) [1-9]\d*$/);
    expect(lines.join("\n")).not.toContain("portal.invalid"); // no address in the log
  });
  it("performance: a batch of 200 alert rows is read in two statements and sent within the budget", async () => {
    const cs = await Promise.all(Array.from({ length: 20 }, () => F.cand()));
    const js = await jobs(100, { title: "Perf" });
    let rowsMade = 0;
    for (const c of cs) {
      const as = [await alertFor(c, { sector: "it" }), await alertFor(c, { county: "Cork" })];
      for (let i = 0; i < 10; i++, rowsMade++) await alertRow(c, as.map((a, k) => [a, js.slice((i + k) * 5, (i + k) * 5 + 10)] as [string, string[]]));
    }
    expect(rowsMade).toBe(200);
    const f = fake(), seen: string[] = [];
    const counted = { query: (q: unknown, ...rest: unknown[]) => (seen.push(typeof q === "string" ? q : "?"), (admin.query as (...a: unknown[]) => unknown)(q, ...rest)) } as unknown as pg.Pool;
    const t0 = performance.now();
    expect(await sendPending(counted, f.send, 200, undefined, SITE)).toEqual({ sent: 200, retry: 0, failed: 0, dropped: 0, old: 0 });
    const ms = performance.now() - t0;
    expect(f.sent).toHaveLength(200);
    expect(seen.filter((q) => q === ALERTS)).toHaveLength(1);
    expect(seen.filter((q) => q === LIVE_JOBS)).toHaveLength(1);
    expect(seen.length).toBeLessThanOrEqual(2 + 2 + 200); // claim, addresses, the two reads, one mark per row
    expect(ms).toBeLessThan(20_000); // loose: about 0.4 s on the dev machine
  });
});
