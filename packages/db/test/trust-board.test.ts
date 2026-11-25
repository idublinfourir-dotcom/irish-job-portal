// Integration: the trust and safety reads of B69 and B70 (src/trust-board.ts) and the staff note, on the real test database through the admin app's real route handlers
// with real staff sessions. Companies and cases are made by the real steps; the bulk for paging is written as postgres. Staff text must never reach a notice, an email or an
// audit row. Fake people only; no network.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { counted, median, staffHarness, type Route } from "./staff-routes-harness";
import { loadSpec, replyProblems } from "./openapi";
import { decodeReviewCursor } from "../src/account-review";
import { trustLabel } from "../src/trust-board";
import { encodeIdCursor } from "../src/wire";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Statements counted on every pg.Client.query call, measured 25 Nov 2026 (printed): first page of the list = session reads + role check + the list and the counts together;
// a later page has no counts. Medians of 9 warm calls, small data: 5.5 to 7.5 ms (the size runs are in perf/trust-board.perf.ts). The time limits are about 8 times the measure for a busy laptop.
const BUDGET = { list: { statements: 5, ms: 50 }, listNext: { statements: 4, ms: 50 }, bans: { statements: 4, ms: 50 }, wrc: { statements: 4, ms: 50 } };

let db: TestDb, su: pg.Pool;
let h: Awaited<ReturnType<typeof staffHarness>>;
let F: { org: (o?: object) => Promise<string>; portal: (o?: { email?: string }) => Promise<string>; cand: () => Promise<string> };
let id: (p: string) => string;
const R = {} as Record<"list" | "bans" | "wrc" | "cases" | "reports", Route>;
type Item = { kind: string; id: string; label: string; createdAt: string; organisationId: string | null; displayName: string | null; organisationKind: string | null; jobId: string | null; reason: string; state: string; jobReports: number; companyReports: number };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ id, F } = fixtures(db) as unknown as { id: typeof id; F: typeof F });
  h = await staffHarness(db);
  R.list = await import("../../../apps/admin/app/api/trust-safety/list/route");
  R.bans = await import("../../../apps/admin/app/api/trust-safety/bans/route");
  R.wrc = await import("../../../apps/admin/app/api/trust-safety/wrc/route");
  R.cases = await import("../../../apps/admin/app/api/trust-safety/cases/route");
  R.reports = await import("../../../apps/admin/app/api/trust-safety/reports/route");
  for (const n of ["ts1", "ts2", "ts3"]) await h.makeStaff(n, ["trust_and_safety"]);
  await h.makeStaff("reviewer", ["account_reviewer"]);
  await h.makeStaff("adminonly", ["administrator"]);
  await h.makeStaff("handler", ["services_case_handler"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["trust_and_safety"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
  source = (await su.query("insert into job_source(kind, board) values ('portal', 'portal') returning id::text")).rows[0].id;
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];
const get = (route: Route, who: string | null, query = "") => h.call(route, "", who, undefined, { query });
const post = (who: string | null, body: unknown, o: { origin?: string | null } = {}) => h.call(R.cases, "", who, body, o);
const ok = (who: string, body: unknown) => h.ok(post(who, body));
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();
const pastWindow = (c: string) => su.query("update strike set reply_due_at = now() - interval '1 minute' where id = $1", [c]);

let source: string;
/** A verified company with an owner on its own domain (saved a week ago), a CRO number and live jobs: what a ban can be applied to. */
async function company(o: { kind?: string; jobs?: number } = {}) {
  const domain = `${id("co")}.example.test`;
  const cro = String(Math.floor(Math.random() * 9e7) + 1e7);
  const org = await F.org({ kind: o.kind ?? "employer", cro, status: "verified" });
  const owner = await F.portal({ email: `${id("owner")}@${domain}` });
  const member = (await one("insert into membership(organisation_id, portal_user_id, role, status, is_signer, joined_at) values ($1, $2, 'account_owner', 'active', true, now() - interval '1 day') returning id::text", [org, owner])).id;
  await su.query("insert into organisation_domain(organisation_id, domain, source, created_at) values ($1, $2, 'seed', now() - interval '7 days')", [org, domain]);
  const jobs: string[] = [];
  for (let i = 0; i < (o.jobs ?? 1); i++)
    jobs.push((await one(
      "insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, salary_low, status, closes_at, own_page_url, search_vector, posted_by_membership_id) " +
      "values ($1, 'employer', $2, 'Fake Cook', 'Fake Org', 'it', 'critical_skills', 40000, 'live', now() + interval '20 days', 'https://example.test/a', 'fake', $3) returning id::text", [org, source, member])).id);
  return { org: String(org), cro, domain, jobs };
}
async function report(job: string, reason = "no_sponsorship") {
  const who = await F.cand();
  return (await db.query("app_candidate", "insert into report(target_kind, target_job_id, reporter_candidate_user_id, reason, evidence_text) values ('job', $1, $2, $3, 'Fake proof') returning id::text", [job, who, reason])).rows[0].id as string;
}
async function companyReport(org: string) {
  const who = await F.cand();
  return (await db.query("app_candidate", "insert into report(target_kind, target_organisation_id, reporter_candidate_user_id, reason, evidence_text) values ('organisation', $1, $2, 'fake_company', 'Fake proof') returning id::text", [org, who])).rows[0].id as string;
}
/** An applied instant ban (conclusive evidence, a second officer confirms): the case id. */
async function bannedCase(co: { org: string }) {
  const { caseId } = await ok("ts1", { action: "open", organisationId: co.org, caseKind: "instant_ban", reasonCode: "asks_for_money" });
  await ok("ts1", { action: "decide", caseId, outcome: "ban", conclusive: true });
  await ok("ts2", { action: "confirm", caseId });
  return caseId as string;
}
/** Every page of a list: the items in order, the first page's counts. */
async function walk(route: Route, query: string) {
  const items: Item[] = [];
  let counts: unknown, token: string | null = null, pages = 0;
  do {
    const r = await get(route, "ts1", `${query}${token ? `&after=${token}` : ""}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    if (pages++ === 0) counts = r.json.counts;
    items.push(...r.json.items);
    token = r.json.next;
  } while (token && pages < 30);
  return { items, counts, pages };
}

describe("B69: the list", () => {
  it("open tab: reports and cases in one list, one label each, the report counts per job and per company, no reporter or evidence", async () => {
    const co = await company({ jobs: 2 });
    const [a1, a2, a3] = [await report(co.jobs[0]!), await report(co.jobs[0]!), await report(co.jobs[0]!)];
    await report(co.jobs[1]!);
    await companyReport(co.org);
    const { caseId } = await ok("ts1", { action: "open", organisationId: co.org, jobId: co.jobs[0], caseKind: "false_claim", reasonCode: "false_sponsorship" });
    const r = await get(R.list, "ts1");
    expect(r.status).toBe(200);
    const items: Item[] = (await walk(R.list, "?tab=open")).items;
    const mine = (rid: string) => items.find((x) => x.kind === "report" && x.id === rid)!;
    expect(mine(a1)).toMatchObject({ label: trustLabel("report", a1), jobId: co.jobs[0], organisationId: co.org, displayName: "Fake Org", organisationKind: "employer", reason: "no_sponsorship", state: "open", jobReports: 3, companyReports: 5 });
    expect(mine(a2).jobReports).toBe(3);
    expect(mine(a3).companyReports).toBe(5);
    expect(items.find((x) => x.kind === "case" && x.id === caseId)).toMatchObject({ label: trustLabel("case", caseId), state: "case_open", reason: "false_sponsorship", jobId: co.jobs[0], jobReports: 3, companyReports: 5 });
    expect(trustLabel("report", "7")).toBe("R-0007");
    expect(trustLabel("case", "12345")).toBe("C-12345");
    expect(JSON.stringify(r.json)).not.toMatch(/Fake proof|reporter/i); // #99: no reporter, no evidence text in the list
    expect(r.json.counts.open).toBeGreaterThanOrEqual(6);
    expect(Object.keys(r.json.counts).sort()).toEqual(["appeals", "closed", "open", "waiting"]);
    expect(replyProblems(loadSpec("admin"), "GET", "/api/trust-safety/list", 200, r.json)).toEqual([]);
  });

  it("keyset paging: 45 reports with the very same time come in 20, 20, 5 with none missing or repeated; the counts come with the first page only", async () => {
    const co = await company();
    await su.query("insert into report(target_kind, target_organisation_id, reason, created_at) select 'organisation', $1, 'fake_company', '2026-01-01 10:00:00+00' from generate_series(1, 45)", [co.org]);
    const first = await get(R.list, "ts1", "?tab=open");
    expect(first.json.items).toHaveLength(20);
    expect(first.json.counts).not.toBeNull();
    const second = await get(R.list, "ts1", `?tab=open&after=${first.json.next}`);
    expect(second.json.counts).toBeNull();
    const { items } = await walk(R.list, "?tab=open");
    const batch = items.filter((x) => x.createdAt === "2026-01-01T10:00:00.000Z").map((x) => x.id);
    expect(batch).toHaveLength(45);
    expect(batch).toEqual([...batch].sort((x, y) => Number(x) - Number(y))); // equal times: by id
    expect(new Set(items.map((x) => x.label)).size).toBe(items.length);
    expect(items.map((x) => Date.parse(x.createdAt))).toEqual(items.map((x) => Date.parse(x.createdAt)).sort((x, y) => x - y)); // oldest first
  });

  it("the tabs: a notified case waits for the reply, an appeal is in appeals, a decided report and a finished case are in the closed history, newest first; counts match", async () => {
    const co = await company();
    const { caseId: waiting } = await ok("ts1", { action: "open", organisationId: co.org, caseKind: "false_claim", reasonCode: "false_sponsorship" });
    await ok("ts1", { action: "notify", caseId: waiting });
    const ban = await bannedCase(await company());
    await ok("ts2", { action: "record_appeal", caseId: ban, text: "We dispute this.", receivedAt: ago(1) });
    const cleared = await report((await company()).jobs[0]!);
    await ok("ts1", { action: "decide", caseId: (await ok("ts1", { action: "open", organisationId: (await company()).org, caseKind: "false_claim", reasonCode: "false_sponsorship" })).caseId, outcome: "cleared" });
    await h.ok(h.call(R.reports, "", "ts1", { action: "clear", reportId: cleared }));
    const tab = async (t: string) => walk(R.list, `?tab=${t}`);
    const [open, wait, appeals, closed] = [await tab("open"), await tab("waiting"), await tab("appeals"), await tab("closed")];
    expect(wait.items.map((x) => [x.kind, x.id, x.state])).toContainEqual(["case", waiting, "employer_notified"]);
    expect(open.items.some((x) => x.id === waiting && x.kind === "case")).toBe(false);
    expect(appeals.items.map((x) => [x.kind, x.id, x.state])).toContainEqual(["case", ban, "appealed"]);
    expect(wait.items.every((x) => x.kind === "case")).toBe(true);
    expect(closed.items.map((x) => [x.kind, x.id])).toContainEqual(["report", cleared]);
    expect(closed.items.some((x) => x.kind === "case" && x.state === "applied")).toBe(false); // a case still in its appeal is not closed
    expect(closed.items.map((x) => Date.parse(x.createdAt))).toEqual(closed.items.map((x) => Date.parse(x.createdAt)).sort((x, y) => y - x)); // newest first
    for (const [name, t] of [["open", open], ["waiting", wait], ["appeals", appeals], ["closed", closed]] as const) expect((t.counts as Record<string, number>)[name], name).toBe(Math.min(200, t.items.length));
  });

  it("every count stops at 200: 230 decided reports count as 200", async () => {
    const co = await company();
    await su.query("insert into report(target_kind, target_organisation_id, reason, status) select 'organisation', $1, 'fake_company', 'cleared' from generate_series(1, 230)", [co.org]);
    expect((await get(R.list, "ts1", "?tab=closed")).json.counts.closed).toBe(200);
  });
});

describe("B69: a staff note on a case", () => {
  it("is kept with its writer, shows in the case read, and never reaches a notice, an email or an audit row", async () => {
    const co = await company();
    const { caseId } = await ok("ts1", { action: "open", organisationId: co.org, caseKind: "false_claim", reasonCode: "false_sponsorship", noticeSummary: "A public summary." });
    const n1 = await ok("ts1", { action: "add_note", caseId, text: "NOTE-SECRET-1 phoned the owner,\nno answer." });
    await ok("ts2", { action: "add_note", caseId, text: "NOTE-SECRET-2" });
    expect(n1.noteId).toMatch(/^\d+$/);
    await ok("ts1", { action: "notify", caseId }); // queues the employer's notices
    await pastWindow(caseId);
    await ok("ts1", { action: "decide", caseId, outcome: "cleared" });
    const item = (await get(R.cases, "ts1", `?id=${caseId}`)).json.item;
    expect(item.notes).toEqual([
      { id: n1.noteId, text: "NOTE-SECRET-1 phoned the owner,\nno answer.", staffName: "Fake ts1", createdAt: expect.any(String) },
      { id: expect.any(String), text: "NOTE-SECRET-2", staffName: "Fake ts2", createdAt: expect.any(String) },
    ]);
    expect(replyProblems(loadSpec("admin"), "GET", "/api/trust-safety/cases", 200, { item })).toEqual([]);
    expect((await su.query("select 1 from email_outbox where params::text like '%NOTE-SECRET%'")).rowCount).toBe(0);
    expect((await su.query("select 1 from email_outbox where dedupe_key like $1", [`%strike:${caseId}:%`])).rowCount).toBeGreaterThan(0); // notices were made, none holds a note
    const audits = (await su.query("select action, after::text, reason_text from audit_event where object_type = 'strike' and object_id = $1", [caseId])).rows;
    expect(audits.filter((a) => a.action === "trust_safety.note_add")).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain("NOTE-SECRET");
    expect((await su.query("select 1 from audit_event where after::text like '%NOTE-SECRET%' or reason_text like '%NOTE-SECRET%'")).rowCount).toBe(0);
  });

  it("refuses: no text, a long text, control characters, a case that does not exist, an unknown field, no Origin; and only a trust and safety officer writes one", async () => {
    const co = await company();
    const { caseId } = await ok("ts1", { action: "open", organisationId: co.org, caseKind: "false_claim", reasonCode: "false_sponsorship" });
    const no = async (who: string | null, body: unknown, status: number, error: string, o: { origin?: string | null } = {}) => { const r = await post(who, body, o); expect([r.status, r.json.error], JSON.stringify(body).slice(0, 80)).toEqual([status, error]); };
    await no("ts1", { action: "add_note", caseId, text: "   " }, 400, "bad_text");
    await no("ts1", { action: "add_note", caseId, text: "x".repeat(5001) }, 400, "bad_text");
    await no("ts1", { action: "add_note", caseId, text: "bad \u0007 bell" }, 400, "bad_text");
    await no("ts1", { action: "add_note", caseId, text: 12 }, 400, "bad_text");
    await no("ts1", { action: "add_note", caseId }, 400, "bad_body");
    await no("ts1", { action: "add_note", caseId, text: "ok", extra: 1 }, 400, "bad_body");
    await no("ts1", { action: "add_note", caseId: "abc", text: "ok" }, 400, "bad_id");
    await no("ts1", { action: "add_note", caseId: "999999999", text: "ok" }, 404, "not_found");
    await no("ts1", { action: "add_note", caseId, text: "ok" }, 403, "bad_origin", { origin: null });
    await no("ts1", { action: "add_note", caseId, text: "ok" }, 403, "bad_origin", { origin: "https://evil.example.test" });
    for (const who of ["reviewer", "adminonly", "handler", "norole"]) await no(who, { action: "add_note", caseId, text: "ok" }, 403, "not_trust_and_safety");
    await no("disabled", { action: "add_note", caseId, text: "ok" }, 401, "not_active");
    await no(null, { action: "add_note", caseId, text: "ok" }, 401, "no_session");
    expect((await one("select count(*)::int n from strike_note where strike_id = $1", [caseId])).n).toBe(0);
    // the table itself: only the admin app reads or adds, nobody changes or deletes
    for (const role of ["app_portal", "app_candidate", "app_fetcher"] as const) await expect(db.pool(role).query("select 1 from strike_note"), role).rejects.toMatchObject({ code: "42501" });
    await expect(db.pool("app_admin").query("update strike_note set body = 'x'"), "update").rejects.toMatchObject({ code: "42501" });
    await expect(db.pool("app_admin").query("delete from strike_note"), "delete").rejects.toMatchObject({ code: "42501" });
  });
});

describe("B70: the ban list and the WRC list", () => {
  it("lists every banned value with its company, reason, case, date and who; a lift in waiting shows; it holds no way to add one", async () => {
    const co = await company();
    const caseId = await bannedCase(co);
    const { items } = await walk(R.bans, "?");
    const mine = items.filter((x) => (x as unknown as { caseId: string }).caseId === caseId) as unknown as Record<string, unknown>[];
    expect(mine.map((x) => [x.type, x.value]).sort()).toEqual([["cro_number", co.cro], ["email_domain", co.domain]]);
    expect(mine[0]).toMatchObject({ reasonCode: "asks_for_money", caseLabel: trustLabel("case", caseId), caseKind: "instant_ban", organisationId: co.org, displayName: "Fake Org", proposedBy: "Fake ts1", confirmedBy: "Fake ts2", liftPending: false });
    expect(Date.now() - Date.parse(mine[0]!.addedAt as string)).toBeLessThan(60_000);
    await ok("ts1", { action: "propose_ban_lift", caseId });
    const again = ((await walk(R.bans, "?")).items as unknown as Record<string, unknown>[]).filter((x) => x.caseId === caseId);
    expect(again.every((x) => x.liftPending === true)).toBe(true);
    expect(replyProblems(loadSpec("admin"), "GET", "/api/trust-safety/bans", 200, (await get(R.bans, "ts1")).json)).toEqual([]);
    expect(["POST" in R.bans, "PUT" in R.bans, "DELETE" in R.bans]).toEqual([false, false, false]); // a standalone add or remove does not exist (#44, CF109, #104)
  });

  it("pages newest first, 20 ban rows a page, with none missing or repeated", async () => {
    const co = await company();
    const c = await bannedCase(co);
    const k = await su.connect();
    try {
      await k.query("set session_replication_role = replica"); // as fill.ts: the rows are only for paging
      const a = (await k.query("select id, confirmed_by_staff_user_id, proposed_by_staff_user_id from approval_request where kind = 'ban' order by id limit 1")).rows[0];
      await k.query("insert into ban(cro_number, reason_code, strike_id, approval_request_id) select 'paging' || g, 'asks_for_money', $1, $2 from generate_series(1, 45) g", [c, a.id]);
    } finally { k.release(); }
    const first = await get(R.bans, "ts1");
    expect(first.json.next).toEqual(expect.any(String));
    const { items, pages } = await walk(R.bans, "?");
    const ids = items.map((x) => (x as unknown as { banId: string }).banId);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(new Set(items.map((x) => `${(x as unknown as { banId: string }).banId}:${(x as unknown as { type: string }).type}`)).size).toBe(items.length);
    expect(ids.map(Number)).toEqual([...ids.map(Number)].sort((x, y) => y - x));
    expect((await one("select count(*)::int n from ban")).n).toBe(new Set(ids).size);
  });

  it("the WRC list holds the agency cases staff ticked off, with the date and who, newest first", async () => {
    const agency = await company({ kind: "agency" });
    const caseId = await bannedCase(agency);
    const plain = await bannedCase(await company());
    expect((await walk(R.wrc, "?")).items.some((x) => (x as unknown as { caseId: string }).caseId === caseId)).toBe(false); // not ticked yet
    await ok("ts1", { action: "mark_wrc", caseId });
    const list = (await walk(R.wrc, "?")).items as unknown as Record<string, unknown>[];
    expect(list[0]).toMatchObject({ caseId, caseLabel: trustLabel("case", caseId), organisationId: agency.org, organisationKind: "agency", reasonCode: "asks_for_money", reportedBy: "Fake ts1" });
    expect(Date.now() - Date.parse(list[0]!.reportedAt as string)).toBeLessThan(60_000);
    expect(list.some((x) => x.caseId === plain)).toBe(false);
    expect(replyProblems(loadSpec("admin"), "GET", "/api/trust-safety/wrc", 200, (await get(R.wrc, "ts1")).json)).toEqual([]);
    // paging by (time, id): 25 more ticks written as postgres
    await su.query("insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, at, source) select 'admin_action', $2, 'trust_safety.wrc_reported', 'strike', $1, now() - (g || ' hours')::interval, 'panel' from generate_series(1, 25) g", [caseId, h.staff.ts2]);
    const all = (await walk(R.wrc, "?")).items;
    expect(all).toHaveLength(26);
    const times = all.map((x) => Date.parse((x as unknown as { reportedAt: string }).reportedAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });
});

describe("security", () => {
  it("each read: only an active trust and safety officer; no other role stands in, nobody signed out, no portal or candidate cookie", async () => {
    for (const [name, route] of [["list", () => R.list], ["bans", () => R.bans], ["wrc", () => R.wrc]] as const) {
      for (const who of ["reviewer", "adminonly", "handler", "norole"]) expect([(await get(route(), who)).status, (await get(route(), who)).json.error], `${name} ${who}`).toEqual([403, "not_trust_and_safety"]);
      expect(await get(route(), "disabled")).toMatchObject({ status: 401, json: { error: "not_active" } });
      expect(await get(route(), null)).toMatchObject({ status: 401 });
      expect((await h.call(route(), "", null, undefined, { cookie: "candidate.session_token=fake.value; portal.session_token=fake.value" })).json.error).toBe("no_session");
      expect((await get(route(), "ts3")).status, name).toBe(200);
    }
  });

  it("hostile input: an unknown tab, repeated or unknown keys, a made-up, long or foreign token, an injection, wrong types", async () => {
    const tok = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const good = (await get(R.list, "ts1", "?tab=open")).json.next ?? tok({ b: "open", t: "2026-01-01 10:00:00+00", k: "case", i: "1" });
    const bad = async (route: Route, q: string, error: string) => { const r = await get(route, "ts1", q); expect([r.status, r.json.error], q.slice(0, 60)).toEqual([400, error]); };
    for (const t of ["evil", "OPEN", "open'--", "all", "", "%00", "x".repeat(5000)]) await bad(R.list, `?tab=${encodeURIComponent(t)}`, t === "" ? "bad_tab" : "bad_tab");
    await bad(R.list, "?tab=open&tab=closed", "bad_query");
    await bad(R.list, "?tab=open&x=1", "bad_query");
    await bad(R.list, "?id=1", "bad_query");
    await bad(R.bans, "?tab=open", "bad_query");
    await bad(R.wrc, "?after=a&after=b", "bad_query");
    for (const after of ["1", "1;drop table report", "!!", "x".repeat(300), tok({}), tok({ b: "open", t: "now()", k: "case", i: "1" }), tok({ b: "open", t: "2026-01-01 10:00:00+00", k: "evil", i: "1" }),
      tok({ b: "open", t: "2026-01-01 10:00:00+00", k: "case", i: "1 or 1=1" }), tok({ b: "closed", t: "2026-01-01 10:00:00+00", k: "case", i: "1" }), tok({ b: "open", t: "2026-01-01 10:00:00+00", k: "case", i: "1", x: 1 }), encodeIdCursor("cases", "5")]) {
      await bad(R.list, `?tab=open&after=${after}`, "bad_cursor");
    }
    expect((await get(R.list, "ts1", `?tab=closed&after=${good}`)).json.error).toBe("bad_cursor"); // a token of another tab
    for (const after of ["1", encodeIdCursor("cases", "5"), tok({ t: "2026-01-01 10:00:00+00", i: "1" })]) await bad(R.bans, `?after=${after}`, "bad_cursor");
    for (const after of ["1", encodeIdCursor("bans", "5"), tok({ t: "yesterday", i: "1" })]) await bad(R.wrc, `?after=${after}`, "bad_cursor");
    expect(() => decodeReviewCursor("1")).toThrow();
  });

  it("the list shows nothing a role must not see: no reporter, no evidence, no staff note text", async () => {
    const co = await company();
    const r = await report(co.jobs[0]!);
    const { caseId } = await ok("ts1", { action: "open", organisationId: co.org, caseKind: "false_claim", reasonCode: "false_sponsorship" });
    await ok("ts1", { action: "add_note", caseId, text: "NOTE-HIDDEN-FROM-LIST" });
    const all = JSON.stringify([...(await walk(R.list, "?tab=open")).items, ...(await walk(R.list, "?tab=closed")).items]);
    expect(all).not.toMatch(/Fake proof|NOTE-HIDDEN|reporter|evidence|candidate_user|portal_user/i);
    expect(r).toBeTruthy();
  });
});

describe("budgets: statements and time on a small database", () => {
  it("each read stays inside its statement count and median time", async () => {
    const co = await company({ jobs: 3 });
    for (const j of co.jobs) await report(j);
    await bannedCase(co);
    const cases: [string, keyof typeof BUDGET, () => Promise<unknown>][] = [
      ["list, first page", "list", () => get(R.list, "ts1", "?tab=open")],
      ["list, a later page", "listNext", async () => get(R.list, "ts1", `?tab=closed&after=${Buffer.from(JSON.stringify({ b: "closed", t: "2030-01-01 00:00:00+00", k: "report", i: "1" })).toString("base64url")}`)],
      ["bans", "bans", () => get(R.bans, "ts1")],
      ["wrc", "wrc", () => get(R.wrc, "ts1")],
    ];
    for (const [name, key, run] of cases) {
      await run();
      const [, n] = await counted(run);
      const ms = await median(run);
      console.log(`${name}: ${n} statements, median ${ms.toFixed(1)} ms`);
      expect(n, `${name} statements`).toBeLessThanOrEqual(BUDGET[key].statements);
      expect(ms, `${name} time`).toBeLessThan(BUDGET[key].ms);
    }
  });
});
