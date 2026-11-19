// Integration (step 15 P9, #278): an agency whose licence a later WRC list no longer lists (missing from two lists in a row) moves to needs_info,
// cannot publish, and its live jobs go to staff, through the real import command (registers-cli.ts wrc --file, as app_admin) on the test database.
// Staff clear it through the real account review calls. The WRC site is never fetched (a local made-up PDF). Made-up agencies only.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { approveAccount, claimReview } from "../src/account-review";
import { main } from "../src/registers-cli";
import { importWrc, parseWrc, WRC_LAPSE } from "../src/wrc-import";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { wrcBbox, wrcPdf, type WrcLine } from "./registers-helpers";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Measured 19 Nov 2026 on the test database (2,000 licences, 500 agencies, 50 lapsing with 2 live jobs each): the lapse statement, median of 5,
// 11 to 16 ms over four runs; the whole import of the 1,950-row list (lapse included) 45 to 50 ms. Budgets about 4 to 5 times the slowest run.
const BUDGET = { lapseMs: 60, importMs: 250 };

let db: TestDb, su: (sql: string, a?: unknown[]) => Promise<pg.QueryResult>;
let F: { org(o?: object): Promise<string>; portal(): Promise<string>; member(org: string, user: string, o?: object): Promise<string>; staff(): Promise<string> };
let src: string;
beforeAll(async () => {
  db = await createTestDb();
  ({ F, su } = fixtures(db) as unknown as { F: typeof F; su: typeof su });
  src = (await su("select id::text from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
});
afterAll(() => db.drop());

const hasPdftotext = (() => { try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();
const tmp = mkdtempSync(join(tmpdir(), "lapse-it-"));
let nFile = 0;
const noFetch = (async () => { throw new Error("no network in tests"); }) as unknown as typeof fetch;
const L = (n: number): WrcLine => ({ name: `Lapse Test Agency ${n} Limited`, address: `${n} Example Road`, licence: `EA${8000 + n}`, county: "Dublin" });
/** The real command on a made-up PDF holding licences 1..40 except `missing`. */
async function runWrc(today: string, missing: number[]) {
  const file = join(tmp, `l${++nFile}.pdf`);
  writeFileSync(file, wrcPdf(Array.from({ length: 40 }, (_, i) => i + 1).filter((n) => !missing.includes(n)).map(L)));
  const out: string[] = [];
  const code = await main(["wrc", "--file", file, "--accept-count-change"], { WRC_ADMIN_DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" },
    (l) => void out.push(l), { fetch: noFetch, today: () => today });
  expect(code, out.join("\n")).toBe(0);
  return out.join("\n");
}
async function agency(n: number | null, status = "verified", kind = "agency") {
  const org = await F.org({ kind, status, wrc: n === null ? null : `EA${8000 + n}`, name: `Lapse Agency ${n}` });
  const owner = await F.portal();
  await F.member(org, owner, { role: "account_owner", signer: true });
  return { org, owner };
}
const job = async (org: string, status = "live") => (await su(
  `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, salary_low, status, closes_at, search_vector, own_page_url, permit_employer_kind)
   values ($1, 'agency', $2, 'Fake Nurse', 'Fake Agency', 'Dublin', 'health', '2231', 'critical_skills', 60000, $3, now() + interval '20 days', to_tsvector('english', 'fake'), 'https://example.test/a', 'self') returning id::text`,
  [org, src, status])).rows[0].id as string;
const one = async (sql: string, a: unknown[] = []) => (await su(sql, a)).rows[0];
const status = async (org: string) => (await one("select status from organisation where id = $1", [org])).status;
const writes = async () => one(
  "select (select count(*) from review_item)::int items, (select count(*) from notification)::int notices, (select count(*) from email_outbox)::int emails, " +
  "(select count(*) from audit_event where actor_system = 'wrc_import')::int audits");

describe.skipIf(!hasPdftotext)("the WRC import pauses an agency whose licence is no longer listed", () => {
  it("only the agency missing from two lists in a row moves to needs_info, once; its live jobs stay live with one staff item each; staff clear it", async () => {
    const listed = await agency(1), once = await agency(2), gone = await agency(3), pending = await agency(4, "pending_review"), asked = await agency(5, "needs_info");
    const employer = await agency(null, "verified", "employer");
    await su("insert into review_item(queue, organisation_id, reason) values ('account_review', $1, 'new organisation')", [pending.org]);
    const listedJob = await job(listed.org), employerJob = await job(employer.org);
    const goneJobs = [await job(gone.org), await job(gone.org)], goneDraft = await job(gone.org, "draft");
    const before = await writes();

    await runWrc("2026-11-01", []);
    expect(await runWrc("2026-11-08", [2, 3, 4, 5])).toMatch(/0 agencies moved to needs more info, 0 of their live jobs/);
    expect(await writes()).toEqual(before); // missing once: nothing
    const log = await runWrc("2026-11-15", [3, 4, 5]); // 2 is back; 3, 4 and 5 now missing twice in a row
    expect(log).toMatch(/2 agencies moved to needs more info, 2 of their live jobs queued for staff/);

    expect(await status(listed.org)).toBe("verified");
    expect(await status(once.org)).toBe("verified");
    expect(await status(employer.org)).toBe("verified");
    expect(await status(gone.org)).toBe("needs_info");
    expect(await status(pending.org)).toBe("needs_info");
    expect(await status(asked.org)).toBe("needs_info");
    // the live jobs stay live, one item each; the draft, the listed agency's and the employer's jobs get none
    const goneItems = (await su("select job_id::text, queue, status from review_item where job_id = any($1::bigint[]) order by job_id", [goneJobs])).rows;
    expect(goneItems).toEqual(goneJobs.map((j) => ({ job_id: j, queue: "licence_lapse_job", status: "open" })));
    expect((await su("select status from job where id = any($1::bigint[])", [goneJobs])).rows).toEqual([{ status: "live" }, { status: "live" }]);
    expect((await su("select count(*)::int n from review_item where job_id = any($1::bigint[])", [[goneDraft, listedJob, employerJob]])).rows[0].n).toBe(0);
    // one account item each: new for the verified agency, the existing one marked for the pending one; only the date, nothing from the list
    const acct = (await su("select organisation_id::text org, reason, detail from review_item where queue = 'account_review' and status = 'open' and organisation_id = any($1::bigint[]) order by organisation_id", [[gone.org, pending.org]])).rows;
    expect(acct).toEqual([
      { org: gone.org, reason: "licence not found", detail: { licence_not_found_on: "2026-11-15" } },
      { org: pending.org, reason: "new organisation", detail: { licence_not_found_on: "2026-11-15" } },
    ].sort((a, b) => Number(a.org) - Number(b.org)));
    // the owner's existing needs-more-info notice and email, codes only; the agency already in needs_info gets nothing new
    const notes = (await su("select portal_user_id u, template_key t, params from notification order by id")).rows;
    expect(notes).toEqual(expect.arrayContaining([{ u: gone.owner, t: "account_needs_info", params: { organisationId: gone.org, reason: "licence_not_found" } }]));
    expect(notes.filter((r) => r.u === asked.owner)).toEqual([]);
    const mails = (await su("select portal_user_id u, template, params from email_outbox where portal_user_id = $1", [gone.owner])).rows;
    expect(mails).toEqual([{ u: gone.owner, template: "account_needs_info", params: { organisationId: gone.org, reason: "licence_not_found" } }]);
    const text = JSON.stringify([notes, mails, acct]);
    expect(text).not.toMatch(/Lapse Test Agency|Example Road|EA800/); // never the list's names, addresses or numbers (#212)
    const audit = (await su("select actor_system, actor_staff_user_id, action, before, after, reason_code, source from audit_event where object_id = $1 and object_type = 'organisation'", [gone.org])).rows;
    expect(audit).toEqual([{ actor_system: "wrc_import", actor_staff_user_id: null, action: "organisation.licence_not_found", before: { status: "verified" },
      after: { status: "needs_info" }, reason_code: "licence_not_found", source: "scheduled_job" }]);

    // a third missed list, and then the licence back on the list: nothing new, nothing cleared
    const after = await writes();
    expect(await runWrc("2026-11-22", [3, 4, 5])).toMatch(/0 agencies moved/);
    await runWrc("2026-11-29", []);
    expect(await writes()).toEqual(after);
    expect(await status(gone.org)).toBe("needs_info");

    // publishing is refused by the existing guard (job_org_live) while in needs_info; editing a live job is not
    await expect(su("update job set status = 'live' where id = $1", [goneDraft])).rejects.toThrow(/organisation is not verified/);
    await expect(su("insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, salary_low, status, closes_at, search_vector, own_page_url) values ($1, 'agency', $2, 'x', 'x', 'it', 'critical_skills', 60000, 'live', now() + interval '9 days', to_tsvector('x'), 'https://example.test/b')", [gone.org, src])).rejects.toThrow(/not verified/);

    // staff clear it through the existing account review path: the agency is verified again and can publish
    const staff = await F.staff();
    await su("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, 'account_reviewer', true)", [staff]);
    const admin = db.pool("app_admin");
    const item = (await one("select id::text from review_item where queue = 'account_review' and organisation_id = $1 and status = 'open'", [gone.org])).id;
    await claimReview(admin, staff, item);
    expect(await approveAccount(admin, staff, item)).toMatchObject({ organisationStatus: "verified" });
    await su("update job set status = 'live' where id = $1", [goneDraft]);
    expect((await one("select status from job where id = $1", [goneDraft])).status).toBe("live");
  });

  it("the agency answers through the existing needs-more-info path; the portal and fetcher logins still cannot read the list", async () => {
    const a = await agency(20);
    await job(a.org);
    await runWrc("2026-12-01", []);
    await runWrc("2026-12-08", [20]);
    await runWrc("2026-12-15", [20]);
    expect(await status(a.org)).toBe("needs_info");
    const portal = db.pool("app_portal");
    await su("update portal_user set email_verified = true where id = $1", [a.owner]);
    expect((await portal.query("select private.answer_review($1, 'We renewed our licence last week.') r", [a.owner])).rows[0].r).toMatchObject({ status: "pending_review" }); // back to staff
    expect((await one("select detail->>'answer' a from review_item where queue = 'account_review' and organisation_id = $1 and status = 'open'", [a.org])).a).toBe("We renewed our licence last week.");
    for (const role of ["app_portal", "app_fetcher", "app_candidate"] as const) await expect(db.pool(role).query("select * from wrc_licence limit 1")).rejects.toThrow(/permission denied/);
  });
});

describe("performance", () => {
  it(`the lapse step stays under ${BUDGET.lapseMs} ms and the 2,000-licence import under ${BUDGET.importMs} ms (500 agencies, 50 lapsing, 100 live jobs)`, async () => {
    await su("delete from review_item where queue in ('licence_lapse_job')");
    await su("delete from wrc_licence");
    await su(`insert into wrc_licence(licence_number, agency_name, county, first_seen_on, last_seen_on, missed_imports)
      select 'EA5' || lpad(g::text, 4, '0'), 'Perf Agency ' || g, 'Dublin', '2026-01-01', '2026-01-01', case when g <= 50 then 1 else 0 end from generate_series(1, 2000) g`);
    await su(`insert into organisation(slug, display_name, kind, status, wrc_licence_number) select 'perf-agency-' || g, 'Perf Agency ' || g, 'agency', 'verified', 'EA5' || lpad(g::text, 4, '0') from generate_series(1, 500) g`);
    await su(`insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, salary_low, status, closes_at, search_vector, own_page_url, permit_employer_kind)
      select o.id, 'agency', $1, 'Perf job', 'Perf', 'it', 'critical_skills', 60000, 'live', now() + interval '20 days', to_tsvector('x'), 'https://example.test/p', 'self'
      from organisation o, generate_series(1, 2) where o.slug like 'perf-agency-%'`, [src]);
    const admin = db.pool("app_admin");
    const lapsing = Array.from({ length: 50 }, (_, i) => `EA5${String(i + 1).padStart(4, "0")}`);
    // the lapse statement alone, in a transaction rolled back each time
    const ms: number[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await admin.connect();
      try {
        await c.query("begin");
        const t = performance.now();
        const r = (await c.query(WRC_LAPSE, [lapsing, "2026-12-20"])).rows[0];
        ms.push(performance.now() - t);
        expect(r).toEqual({ paused: 50, jobs: 100 });
      } finally { await c.query("rollback"); c.release(); }
    }
    const lapseMs = ms.sort((a, b) => a - b)[2]!;
    // the whole import: the 1,950 still listed (licences 51 to 2000), so 1 to 50 reach two missed lists
    const rows = parseWrc(wrcBbox(Array.from({ length: 1950 }, (_, i) => ({ name: `Perf Agency ${i + 51}`, address: "1 Road", licence: `EA5${String(i + 51).padStart(4, "0")}`, county: "Dublin" }))));
    const t = performance.now();
    const r = await importWrc(admin, rows, "2026-12-20", null, { acceptCountChange: true });
    const importMs = performance.now() - t;
    console.log(`licence lapse: statement ${lapseMs.toFixed(1)} ms, import ${importMs.toFixed(0)} ms`);
    expect([r.paused, r.jobsQueued]).toEqual([50, 100]);
    expect(lapseMs).toBeLessThan(BUDGET.lapseMs);
    expect(importMs).toBeLessThan(BUDGET.importMs);
  });
});
