// Integration: staff uploads (step 15 staff tools C, Q6 and Q7) through the real admin route handlers, real staff sessions and the real test database as
// app_admin, with memoryStore() as the file store (no network). Q6: /api/manual-jobs/sponsor-confirmation (the account reviewer uploads the employer's
// written confirmation, a different administrator confirms, the post shows Sponsor confirmed). Q7: /api/trust-safety/evidence (one evidence file on a
// report or a strike case, trust_and_safety only). Every role is tried, hostile input and hostile files, and retention removing the files. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FilesUnavailable, memoryStore, setFileStore, type MemoryStore } from "../src/file-store";
import { EXE, JPEG, PDF, PNG } from "../src/file-fixture";
import { MAX_UPLOAD_BODY } from "../src/files";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { BASE, counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Statements per call, requireStaff's 2 included (measured 19 Nov 2026; the limits are the counts): upload 13 (pre-check 5: begin, roles, job,
// pending, commit; then begin, roles, job, request, audit, commit), confirm 12 (begin, roles, lock request, job, text, confirm, statement with its
// use of the request, badge, audit, commit), list 6, open 7 (begin, roles, file, audit, commit), attach 11, evidence open 7. Times: medians of 9 warm
// calls through the route on 19 Nov 2026: upload 6.6 ms, confirm 6.8, list 2.2, evidence open 2.7, attach 4.5; the limits are about 4 times those,
// with a 15 ms floor for a busy laptop. Raise these only on purpose.
const BUDGET = { upload: 13, confirm: 12, list: 6, open: 7, attach: 11, evidenceOpen: 7, uploadMs: 30, confirmMs: 30, listMs: 15, openMs: 15, attachMs: 20 };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool, store: MemoryStore;
let sponsor: Route, evidence: Route, manual: Route, reports: Route, cases: Route;
let F: { org(o?: object): Promise<number>; cand(): Promise<string>; text(p: string): Promise<string> };
const S = "/api/manual-jobs/sponsor-confirmation", E = "/api/trust-safety/evidence";

beforeAll(async () => {
  db = await createTestDb();
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  h = await staffHarness(db);
  su = h.su;
  sponsor = await import("../../../apps/admin/app/api/manual-jobs/sponsor-confirmation/route");
  evidence = await import("../../../apps/admin/app/api/trust-safety/evidence/route");
  manual = await import("../../../apps/admin/app/api/manual-jobs/route");
  reports = await import("../../../apps/admin/app/api/trust-safety/reports/route");
  cases = await import("../../../apps/admin/app/api/trust-safety/cases/route");
  for (const r of ROLE_NAMES) await h.makeStaff(r, [r]);
  await h.makeStaff("ar2", ["account_reviewer"]);
  await h.makeStaff("ad2", ["administrator"]);
  await h.makeStaff("ar_ad", ["account_reviewer", "administrator"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["account_reviewer", "trust_and_safety", "administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
  store = memoryStore();
  setFileStore(store);
});
afterAll(async () => {
  setFileStore(undefined);
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

// ===== calls =====
const form = (bytes: Uint8Array, name = "letter.pdf", field = "file") => { const f = new FormData(); f.append(field, new Blob([bytes as Uint8Array<ArrayBuffer>]), name); return f; };
type Reply = { status: number; json: Record<string, any>; location: string | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function send(route: Route, path: string, who: string | null, o: { query?: string; body?: BodyInit; json?: unknown; origin?: string | null; length?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = h.signedIn(who);
  const post = o.body !== undefined || o.json !== undefined;
  if (post && o.origin !== null) headers.origin = o.origin ?? BASE;
  if (o.json !== undefined) headers["content-type"] = "application/json";
  if (o.length) headers["content-length"] = o.length;
  const res = await (post ? route.POST! : route.GET)(new Request(`${BASE}${path}${o.query ?? ""}`, {
    method: post ? "POST" : "GET", headers, body: o.json !== undefined ? JSON.stringify(o.json) : o.body,
  }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {}, location: res.headers.get("location") };
}
const is = (r: Reply, status: number, error: string) => expect([r.status, r.json.error], JSON.stringify(r.json)).toEqual([status, error]);
const okay = (r: { status: number; json: Reply["json"] }) => { expect(r.status, JSON.stringify(r.json)).toBe(200); return r.json; };
const upload = (who: string | null, jobId: unknown, body: BodyInit = form(PDF), o = {}) => send(sponsor, S, who, { query: `?jobId=${encodeURIComponent(String(jobId))}`, body, ...o });
const decide = (who: string | null, action: string, requestId: unknown, o = {}) => send(sponsor, S, who, { json: { action, requestId }, ...o });
const attach = (who: string | null, q: string, body: BodyInit = form(PNG, "photo.png"), o = {}) => send(evidence, E, who, { query: q, body, ...o });
const one = async (sql: string, a: unknown[] = []) => (await su.query(sql, a)).rows[0];
const keys = (prefix: string) => [...store.objects.keys()].filter((k) => k.startsWith(prefix));

// ===== data =====
let n = 0;
const desc = "We are hiring a software engineer to build our payments platform in Dublin. Full sponsorship offered.";
/** A live manual post (through the real manual-jobs route), or a draft one when the pay fails. */
async function manualPost(o: { draft?: boolean } = {}): Promise<{ org: number; job: string }> {
  const org = await F.org({ status: "verified", name: `Fake Upload Co ${++n}` });
  const r = okay(await h.call(manual, "/api/manual-jobs", "account_reviewer", {
    action: "create", organisationId: String(org), title: "Software Engineer", description: desc, county: "Dublin", occupationCode: "2136", contractMonths: null,
    salaryLow: o.draft ? 20000 : 50000, salaryHigh: o.draft ? null : 60000, weeklyHours: 39, closesOn: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10),
    applyUrl: "https://careers.example.ie/jobs/1",
  }));
  expect(r.status).toBe(o.draft ? "draft" : "live");
  return { org, job: r.jobId as string };
}
async function report(job: string) {
  return (await db.query("app_candidate", "insert into report(target_kind, target_job_id, reporter_candidate_user_id, reason, evidence_text) values ('job', $1, $2, 'no_sponsorship', 'Fake proof') returning id::text",
    [job, await F.cand()])).rows[0].id as string;
}
const strike = async (org: number) => (await one("insert into strike(organisation_id, case_kind, reason_code) values ($1, 'false_claim', 'false_sponsorship') returning id::text as id", [org])).id as string;
const NOT = { ar: ROLE_NAMES.filter((r) => r !== "account_reviewer"), ad: ROLE_NAMES.filter((r) => r !== "administrator"), ts: ROLE_NAMES.filter((r) => r !== "trust_and_safety") };

// ===== Q6 =====
describe("sponsor confirmation on a manual post (Q6)", () => {
  it("the account reviewer uploads, a different administrator reads and confirms: the statement is written and the post shows Sponsor confirmed", async () => {
    const { job } = await manualPost();
    const up = okay(await upload("account_reviewer", job));
    expect(replyProblems(loadSpec("admin"), "POST", S, 200, up)).toEqual([]);
    const key = (await one("select change->>'key' k from approval_request where id = $1", [up.requestId])).k as string;
    expect(key).toMatch(/^sponsor\/[0-9a-f-]{36}\.pdf$/);
    expect(store.objects.get(key)!.contentType).toBe("application/pdf");
    const list = okay(await send(sponsor, S, "administrator"));
    expect(replyProblems(loadSpec("admin"), "GET", S, 200, list)).toEqual([]);
    expect(list.pending).toContainEqual(expect.objectContaining({ requestId: up.requestId, jobId: job, fileName: "letter.pdf", contentType: "pdf", sizeBytes: PDF.length, proposedBy: h.staff.account_reviewer }));
    const open = await send(sponsor, S, "administrator", { query: `?requestId=${up.requestId}` });
    expect(open.status).toBe(302);
    expect(open.location).toContain(`https://files.example.test/${key}?`);
    expect(await one("select role_in_force, kind from audit_event where action = 'job.sponsor_confirmation_open' and object_id = $1", [up.requestId])).toEqual({ role_in_force: "administrator", kind: "data_access" });

    is(await decide("administrator", "confirm", up.requestId), 409, "no_statement_text"); // no sponsorship statement wording saved yet: nothing changes
    expect((await one("select status from approval_request where id = $1", [up.requestId])).status).toBe("pending");
    await F.text("sponsorship_statement");
    const c = okay(await decide("administrator", "confirm", up.requestId));
    expect(c).toEqual({ ok: true, jobId: job, badge: "sponsor_confirmed" });
    expect(replyProblems(loadSpec("admin"), "POST", S, 200, c)).toEqual([]);
    expect(await one("select badge, status from job where id = $1", [job])).toEqual({ badge: "sponsor_confirmed", status: "live" });
    expect(await one("select kind, confirmation_file_key, entered_by_staff_id, signer_membership_id, approval_request_id::text from sponsorship_statement where job_id = $1", [job]))
      .toEqual({ kind: "admin_on_behalf", confirmation_file_key: key, entered_by_staff_id: h.staff.account_reviewer, signer_membership_id: null, approval_request_id: up.requestId });
    expect(await one("select status, confirmed_by_staff_user_id, applied_at is not null as used from approval_request where id = $1", [up.requestId]))
      .toEqual({ status: "confirmed", confirmed_by_staff_user_id: h.staff.administrator, used: true });
    expect(await one("select actor_staff_user_id, second_staff_user_id from audit_event where action = 'job.sponsor_confirmed' and object_id = $1", [job]))
      .toEqual({ actor_staff_user_id: h.staff.administrator, second_staff_user_id: h.staff.account_reviewer });
    // the confirmed file stays readable (the statement holds it); the post cannot be confirmed twice
    expect((await send(sponsor, S, "account_reviewer", { query: `?requestId=${up.requestId}` })).status).toBe(302);
    is(await upload("account_reviewer", job), 409, "already_confirmed");
    is(await decide("ad2", "confirm", up.requestId), 409, "request_not_pending");
  });

  it("two people: the proposer never confirms, even holding the administrator role", async () => {
    const { job } = await manualPost();
    const { requestId } = okay(await upload("ar_ad", job));
    is(await decide("ar_ad", "confirm", requestId), 409, "same_person");
    expect(await one("select badge from job where id = $1", [job])).toEqual({ badge: "critical_skills_eligible" });
    okay(await decide("administrator", "confirm", requestId));
  });

  it("every role but the account reviewer is refused the upload and nothing is stored; every role but the administrator is refused the confirm", async () => {
    const { job } = await manualPost();
    const before = store.objects.size;
    for (const who of [...NOT.ar, "norole"]) is(await upload(who, job), 403, "not_account_reviewer");
    is(await upload("disabled", job), 401, "not_active");
    is(await upload(null, job), 401, "no_session");
    expect(store.objects.size).toBe(before);
    expect(await one("select count(*)::int n from approval_request where target_id = $1", [job])).toEqual({ n: 0 });
    const { requestId } = okay(await upload("account_reviewer", job));
    for (const who of [...NOT.ad, "ar2", "norole"]) is(await decide(who, "confirm", requestId), 403, "not_administrator");
    is(await decide("disabled", "confirm", requestId), 401, "not_active");
    is(await decide(null, "confirm", requestId), 401, "no_session");
    // the list and the file: the manual posting viewers only (account reviewer, trust and safety, administrator)
    for (const who of ["fetched_job_reviewer", "rules_data_editor", "services_case_handler", "content_editor", "norole"]) {
      is(await send(sponsor, S, who), 403, "not_manual_viewer");
      is(await send(sponsor, S, who, { query: `?requestId=${requestId}` }), 403, "not_manual_viewer");
    }
    for (const who of ["account_reviewer", "trust_and_safety", "administrator"]) expect((await send(sponsor, S, who, { query: `?requestId=${requestId}` })).status).toBe(302);
    is(await send(sponsor, S, null), 401, "no_session");
    is(await send(sponsor, S, "disabled"), 401, "not_active");
    expect(await one("select status from approval_request where id = $1", [requestId])).toEqual({ status: "pending" });
  });

  it("only a live manual post of a company that is not restricted, one request at a time", async () => {
    is(await upload("account_reviewer", (await manualPost({ draft: true })).job), 409, "job_not_live");
    const emp = await F.org({ status: "verified" });
    const src = (await one("select id from job_source where kind = 'portal' and board = 'employer'")).id;
    const other = (await one("insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, salary_low, status, closes_at, own_page_url, search_vector) " +
      "values ($1, 'employer', $2, 'Fake', 'Fake', 'it', 'critical_skills', 60000, 'live', now() + interval '20 days', 'https://example.test/a', 'fake') returning id::text as id", [emp, src])).id;
    is(await upload("account_reviewer", other), 404, "not_found"); // an employer's own job is not a manual post
    is(await upload("account_reviewer", "999999999"), 404, "not_found");
    const { org, job } = await manualPost();
    const { requestId } = okay(await upload("account_reviewer", job));
    const before = store.objects.size;
    is(await upload("ar2", job), 409, "decision_pending");
    expect(store.objects.size).toBe(before);
    const k = await su.connect();
    try { // a strike 2 restriction set straight on the row, as employer-jobs-route.test.ts does
      await k.query("begin");
      await k.query("set local session_replication_role = replica");
      await k.query("update organisation set restricted_until = now() + interval '60 days' where id = $1", [org]);
      await k.query("commit");
    } finally { k.release(); }
    is(await decide("administrator", "confirm", requestId), 409, "company_restricted");
    expect(await one("select badge from job where id = $1", [job])).toEqual({ badge: "critical_skills_eligible" });
  });

  it("two uploads at once: one request, and the other's stored file is removed", async () => {
    const { job } = await manualPost();
    const before = keys("sponsor/").length;
    const r = await Promise.all([upload("account_reviewer", job), upload("ar2", job)]);
    expect(r.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(keys("sponsor/").length).toBe(before + 1);
  });

  it("refused by an administrator or withdrawn by the proposer: the stored file is removed; another account reviewer may not refuse", async () => {
    const a = await manualPost(), b = await manualPost();
    const ra = okay(await upload("account_reviewer", a.job)).requestId, rb = okay(await upload("account_reviewer", b.job)).requestId;
    const key = async (id: string) => (await one("select change->>'key' k from approval_request where id = $1", [id])).k as string;
    const [ka, kb] = [await key(ra), await key(rb)];
    for (const who of ["fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "services_case_handler", "content_editor", "norole"]) is(await decide(who, "refuse", ra), 403, "not_sponsor_staff");
    is(await decide("ar2", "refuse", ra), 403, "not_administrator");
    okay(await decide("administrator", "refuse", ra));
    okay(await decide("account_reviewer", "refuse", rb));
    await vi.waitFor(() => { expect(store.objects.has(ka)).toBe(false); expect(store.objects.has(kb)).toBe(false); });
    expect((await su.query("select status from approval_request where id in ($1, $2) order by id", [ra, rb])).rows.map((x) => x.status)).toEqual(["refused", "withdrawn"]);
    is(await send(sponsor, S, "administrator", { query: `?requestId=${ra}` }), 404, "not_found");
    is(await decide("administrator", "confirm", ra), 409, "request_not_pending");
    okay(await upload("account_reviewer", a.job)); // a new request may follow
  });

  it("hostile input and hostile files: refused before anything is stored", async () => {
    const { job } = await manualPost();
    const before = store.objects.size;
    is(await upload("account_reviewer", job, form(EXE, "letter.pdf")), 415, "wrong_file_type"); // a program named .pdf
    is(await upload("account_reviewer", job, form(new TextEncoder().encode("<html><script>alert(1)</script></html>"), "x.pdf")), 415, "wrong_file_type");
    is(await upload("account_reviewer", job, form(new Uint8Array(0))), 400, "empty_file");
    const big = new Uint8Array(4 * 1024 * 1024 + 1); big.set(PDF);
    is(await upload("account_reviewer", job, form(big)), 413, "file_too_large");
    is(await upload(null, job, form(PDF), { length: String(MAX_UPLOAD_BODY + 1) }), 413, "file_too_large"); // by header, before the session
    is(await upload("account_reviewer", job, form(PDF, "a.pdf", "other")), 400, "bad_file");
    const two = form(PDF); two.append("file", new Blob([PDF]), "b.pdf");
    is(await upload("account_reviewer", job, two), 400, "bad_file");
    for (const bad of ["1 or 1=1", "-1", "0x1", "9".repeat(30), "a".repeat(500), ""]) is(await upload("account_reviewer", bad), 400, "bad_input");
    is(await send(sponsor, S, "account_reviewer", { query: `?jobId=${job}&jobId=${job}`, body: form(PDF) }), 400, "bad_query");
    is(await send(sponsor, S, "account_reviewer", { query: `?jobId=${job}&x=1`, body: form(PDF) }), 400, "bad_query");
    is(await upload("account_reviewer", job, form(PDF), { origin: "https://evil.example" }), 403, "bad_origin");
    is(await upload("account_reviewer", job, form(PDF), { origin: null }), 403, "bad_origin");
    expect(store.objects.size).toBe(before);
    // the JSON actions
    is(await decide("administrator", "confirm", "1; drop table job"), 400, "bad_request_id");
    is(await decide("administrator", "confirm", 5), 400, "bad_request_id");
    is(await decide("administrator", "approve", "1"), 400, "bad_action");
    is(await send(sponsor, S, "administrator", { json: { action: "confirm", requestId: "1", extra: true } }), 400, "bad_body");
    is(await send(sponsor, S, "administrator", { json: [] }), 400, "bad_body");
    is(await send(sponsor, S, "administrator", { json: { action: "confirm", requestId: "1" }, length: "5000" }), 400, "bad_body");
    is(await decide("administrator", "confirm", "999999999"), 404, "not_found");
    is(await send(sponsor, S, "administrator", { query: "?requestId=1%27" }), 404, "not_found");
    is(await send(sponsor, S, "administrator", { query: "?other=1" }), 400, "bad_query");
  });

  it("file storage off: 503, nothing written", async () => {
    const { job } = await manualPost();
    setFileStore({ put: async () => { throw new FilesUnavailable("off"); }, remove: async () => {}, link: async () => { throw new FilesUnavailable("off"); } });
    try {
      is(await upload("account_reviewer", job), 503, "files_unavailable");
      expect(await one("select count(*)::int n from approval_request where target_id = $1", [job])).toEqual({ n: 0 });
    } finally { setFileStore(store); }
  });
});

// ===== Q7 =====
describe("evidence on a report or a strike case (Q7)", () => {
  it("trust and safety attach one file to a report and to a case, read it back, and the item shows it", async () => {
    const { org, job } = await manualPost();
    const rep = await report(job), cs = await strike(org);
    expect(okay(await send(reports, "/api/trust-safety/reports", "trust_and_safety", { query: `?id=${rep}` })).item.evidenceFile).toBe(false);
    const a = okay(await attach("trust_and_safety", `?reportId=${rep}`));
    expect(a).toEqual({ ok: true, contentType: "png", sizeBytes: PNG.length });
    expect(replyProblems(loadSpec("admin"), "POST", E, 200, a)).toEqual([]);
    const rk = (await one("select evidence_storage_key k from report where id = $1", [rep])).k as string;
    expect(rk).toMatch(/^evidence\/[0-9a-f-]{36}\.png$/);
    okay(await attach("trust_and_safety", `?caseId=${cs}`, form(JPEG, "scan.jpg")));
    const sk = (await one("select evidence_storage_key k from strike where id = $1", [cs])).k as string;
    expect(sk).toMatch(/^evidence\/[0-9a-f-]{36}\.jpg$/);
    expect(okay(await send(reports, "/api/trust-safety/reports", "trust_and_safety", { query: `?id=${rep}` })).item.evidenceFile).toBe(true);
    expect(okay(await send(cases, "/api/trust-safety/cases", "trust_and_safety", { query: `?id=${cs}` })).item.evidenceFile).toBe(true);
    const o = await send(evidence, E, "trust_and_safety", { query: `?caseId=${cs}` });
    expect(o.status).toBe(302);
    expect(decodeURIComponent(o.location!)).toContain("image/jpeg");
    expect(await one("select kind, role_in_force from audit_event where action = 'trust_safety.evidence_open' and object_type = 'strike' and object_id = $1", [cs]))
      .toEqual({ kind: "data_access", role_in_force: "trust_and_safety" });
    expect(await one("select after from audit_event where action = 'trust_safety.evidence_attach' and object_type = 'report' and object_id = $1", [rep]))
      .toEqual({ after: { content_type: "png", size_bytes: PNG.length } });
    const before = store.objects.size;
    is(await attach("trust_and_safety", `?reportId=${rep}`), 409, "already_attached"); // one file each, never replaced
    expect(store.objects.size).toBe(before);
  });

  it("a company report (#102) takes an evidence file the same way", async () => {
    const { org } = await manualPost();
    const rep = (await db.query("app_candidate", "insert into report(target_kind, target_organisation_id, reporter_candidate_user_id, reason) values ('organisation', $1, $2, 'fake_company') returning id::text",
      [org, await F.cand()])).rows[0].id as string;
    okay(await attach("trust_and_safety", `?reportId=${rep}`));
    expect((await one("select evidence_storage_key k from report where id = $1", [rep])).k).toMatch(/^evidence\/[0-9a-f-]{36}\.png$/);
    expect(okay(await send(reports, "/api/trust-safety/reports", "trust_and_safety", { query: `?id=${rep}` })).item).toMatchObject({ evidenceFile: true, targetKind: "organisation", organisationId: String(org) });
    is(await attach("account_reviewer", `?reportId=${rep}`), 403, "not_trust_and_safety");
  });

  it("every role but trust and safety is refused, attach and read", async () => {
    const { org, job } = await manualPost();
    const rep = await report(job), cs = await strike(org);
    okay(await attach("trust_and_safety", `?caseId=${cs}`));
    const before = store.objects.size;
    for (const who of [...NOT.ts, "norole"]) {
      is(await attach(who, `?reportId=${rep}`), 403, "not_trust_and_safety");
      is(await send(evidence, E, who, { query: `?caseId=${cs}` }), 403, "not_trust_and_safety");
    }
    for (const who of ["disabled", null] as const) {
      is(await attach(who, `?reportId=${rep}`), 401, who ? "not_active" : "no_session");
      is(await send(evidence, E, who, { query: `?caseId=${cs}` }), 401, who ? "not_active" : "no_session");
    }
    expect(store.objects.size).toBe(before);
    expect((await one("select evidence_storage_key k from report where id = $1", [rep])).k).toBeNull();
  });

  it("not on a decided report or a case whose appeal is decided; unknown ids, bad queries and hostile files are refused", async () => {
    const { org, job } = await manualPost();
    const rep = await report(job), cs = await strike(org);
    await su.query("update report set status = 'cleared', reporter_candidate_user_id = null, decided_at = now() where id = $1", [rep]);
    is(await attach("trust_and_safety", `?reportId=${rep}`), 409, "already_decided");
    await su.query("update strike set outcome = 'cleared', stage = 'decided' where id = $1", [cs]);
    okay(await attach("trust_and_safety", `?caseId=${cs}`)); // a decided case may still get evidence for its appeal
    const done = (await one("insert into strike(organisation_id, case_kind, reason_code, outcome, level, stage, appealed_at, appeal_decided_at, appeal_decided_by_staff_user_id) " +
      "values ($1, 'false_claim', 'false_sponsorship', 'strike', 1, 'upheld', now(), now(), $2) returning id::text as id", [org, h.staff.trust_and_safety])).id as string;
    is(await attach("trust_and_safety", `?caseId=${done}`), 409, "already_decided");
    is(await attach("trust_and_safety", "?reportId=999999999"), 404, "not_found");
    is(await send(evidence, E, "trust_and_safety", { query: "?reportId=999999999" }), 404, "not_found");
    is(await send(evidence, E, "trust_and_safety", { query: `?reportId=${rep}` }), 404, "not_found"); // no file
    for (const bad of ["1 or 1=1", "-1", "a".repeat(500), "1.5"]) is(await attach("trust_and_safety", `?reportId=${encodeURIComponent(bad)}`), 404, "not_found");
    for (const q of ["", `?reportId=${rep}&caseId=${cs}`, "?id=1", `?reportId=${rep}&reportId=${rep}`]) {
      is(await attach("trust_and_safety", q), 400, "bad_query");
      is(await send(evidence, E, "trust_and_safety", { query: q }), 400, "bad_query");
    }
    const open = await report((await manualPost()).job);
    const before = store.objects.size;
    is(await attach("trust_and_safety", `?reportId=${open}`, form(EXE, "proof.png")), 415, "wrong_file_type");
    is(await attach("trust_and_safety", `?reportId=${open}`, form(new Uint8Array(0))), 400, "empty_file");
    is(await attach("trust_and_safety", `?reportId=${open}`, form(PDF, "a.pdf", "evidence")), 400, "bad_file");
    is(await attach("trust_and_safety", `?reportId=${open}`, "not a form"), 400, "bad_file");
    is(await attach(null, `?reportId=${open}`, form(PDF), { length: String(MAX_UPLOAD_BODY + 1) }), 413, "file_too_large");
    is(await attach("trust_and_safety", `?reportId=${open}`, form(PDF), { origin: "https://evil.example" }), 403, "bad_origin");
    expect(store.objects.size).toBe(before);
  });

  it("two attaches at once: one file kept, the other's stored copy removed", async () => {
    const rep = await report((await manualPost()).job);
    const before = keys("evidence/").length;
    const r = await Promise.all([attach("trust_and_safety", `?reportId=${rep}`), attach("trust_and_safety", `?reportId=${rep}`, form(PDF))]);
    expect(r.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(keys("evidence/").length).toBe(before + 1);
  });
});

// ===== retention =====
describe("retention removes the stored files with their rows (0052)", () => {
  const admin = () => db.pool("app_admin");
  const run = async (rule: string, target: string | null) => {
    for (;;) {
      const r = (await admin().query("select private.run_retention(1000) r")).rows[0].r;
      if ((r.rule === rule && r.target === target) || r.rule === null) return r;
    }
  };
  it("a cleared report, a decided case and a closed manual post's confirmation give back their keys", async () => {
    const { org, job } = await manualPost();
    const rep = await report(job), cs = await strike(org);
    okay(await attach("trust_and_safety", `?reportId=${rep}`));
    okay(await attach("trust_and_safety", `?caseId=${cs}`));
    const [rk, sk] = [(await one("select evidence_storage_key k from report where id = $1", [rep])).k, (await one("select evidence_storage_key k from strike where id = $1", [cs])).k];
    await su.query("update report set status = 'cleared', reporter_candidate_user_id = null, decided_at = now() - interval '10 years' where id = $1", [rep]);
    await su.query("update strike set outcome = 'cleared', stage = 'decided' where id = $1", [cs]);
    await su.query("update strike set decided_at = now() - interval '10 years' where id = $1", [cs]);
    const r21 = await run("strike_and_report_evidence", "strike");
    expect(r21.storage_keys).toContain(sk);
    const r22 = await run("strike_and_report_evidence", "report");
    expect(r22.storage_keys).toContain(rk);

    const p = await manualPost();
    const { requestId } = okay(await upload("account_reviewer", p.job));
    okay(await decide("administrator", "confirm", requestId));
    const ck = (await one("select confirmation_file_key k from sponsorship_statement where job_id = $1", [p.job])).k;
    await su.query("update job set status = 'closed', closed_at = now() - interval '10 years', close_reason = 'closed' where id = $1", [p.job]);
    const r32 = await run("closed_job_unreferenced", null);
    expect(r32.storage_keys).toContain(ck);
    expect(await one("select count(*)::int n from sponsorship_statement where job_id = $1", [p.job])).toEqual({ n: 0 });
  });
});

// ===== performance =====
describe("budgets", () => {
  it("statements per call and median times through the route", async () => {
    const posts = await Promise.all(Array.from({ length: 10 }, () => manualPost()));
    const [up, c1] = await counted(() => upload("account_reviewer", posts[0]!.job));
    const [, c2] = await counted(() => decide("administrator", "confirm", up.json.requestId));
    const [, c3] = await counted(() => send(sponsor, S, "administrator"));
    const [, c4] = await counted(() => send(sponsor, S, "administrator", { query: `?requestId=${up.json.requestId}` }));
    const reps = await Promise.all(posts.map((p) => report(p.job)));
    const [, c5] = await counted(() => attach("trust_and_safety", `?reportId=${reps[0]}`));
    const [, c6] = await counted(() => send(evidence, E, "trust_and_safety", { query: `?reportId=${reps[0]}` }));
    const got = { upload: c1, confirm: c2, list: c3, open: c4, attach: c5, evidenceOpen: c6 };
    for (const [k, v] of Object.entries(got)) expect(v, k).toBeLessThanOrEqual(BUDGET[k as keyof typeof BUDGET]);
    const ids: string[] = [];
    const med = {
      uploadMs: await median(async (i) => { ids.push(okay(await upload("account_reviewer", posts[(i % 9) + 1]!.job)).requestId); }),
      confirmMs: await median(async (i) => { okay(await decide("administrator", "confirm", ids[i])); }),
      listMs: await median(async () => { okay(await send(sponsor, S, "administrator")); }),
      openMs: await median(async () => { expect((await send(evidence, E, "trust_and_safety", { query: `?reportId=${reps[0]}` })).status).toBe(302); }),
      attachMs: await median(async (i) => { okay(await attach("trust_and_safety", `?reportId=${reps[(i % 9) + 1]}`)); }),
    };
    console.log("staff uploads budgets:", JSON.stringify({ ...got, ...Object.fromEntries(Object.entries(med).map(([k, v]) => [k, Math.round(v * 10) / 10])) }));
    for (const [k, v] of Object.entries(med)) expect(v, k).toBeLessThan(BUDGET[k as keyof typeof BUDGET]);
  });
});
