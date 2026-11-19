// Integration: staff approval of employer and agency accounts (#186, #187), on the real test database. First the database functions as app_admin
// (src/account-review.ts), then the real route handler of apps/admin with a Request and a real staff session (sign-in through the real auth route).
// Test data is made by the sign-up functions claim_organisation and register_organisation, as app_portal. Fake people only; no network.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { approveAccount, askForMoreInfo, claimReview, getAccountReview, listAccountReviews, rejectAccount, releaseReview, REVIEW_FIRST } from "../src/account-review";
import { QueueRefused } from "../src/admin-queue";
import { PAGE_SIZE } from "../src/search";
import { seedStaff } from "../src/staff-seed-cli";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { assertPageBudget, measurePages } from "./perf/pages";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Statements measured on 12 November 2026. Times are the median of 9 calls (as portal-login.test.ts does; one slow moment on a busy machine must not fail
// the run), and the limit is about 4 times the slowest median measured: medians over three runs on 12 November 2026: list 2.4 to 2.7 ms, item 1.7 to 2.0, claim 3.9 to 4.5, approve 6.4 to 6.6, approve with domain 8.2 to 8.5 (so 35 ms);
// first-time approve (with the label call) 4.2 to 5.4 ms, 6 statements, under the same 35 ms;
// through the route: list 5.2 to 5.5, approve with domain 10.4 to 11.0 (so 45 ms). Raise these only on purpose.
// Function level: list = role check + page (2); one item = role check + read (2); claim = begin, role check, update, commit (4);
// approve without domain = begin, role check, lock, decide, commit (5); a first-time registration adds the label call (6); with domain = + domain lock, other-owner check, add (8).
// Route level adds requireStaff's 2 (session by token, user by id).
const BUDGET = { list: 2, item: 2, claim: 4, approve: 5, approveFirstTime: 6, approveDomain: 8, routeExtra: 2, ms: 35, routeMs: 45, listPages: 2000, listFlagMs: 100 };

const secret = "trial-only-secret-trial-only-secret-32";
let db: TestDb;
let su: pg.Pool;
let id: (p: string) => string;
let F: { org: (o?: { status?: string; name?: string }) => Promise<number>; portal: (o?: { email?: string }) => Promise<string> };
let GET: (r: Request) => Promise<Response>, POST: (r: Request) => Promise<Response>, AUTH: (r: Request) => Promise<Response>;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ id, F } = fixtures(db) as unknown as { id: typeof id; F: typeof F });
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable", STAFF_AUTH_URL: "http://localhost:3002", STAFF_AUTH_SECRET: secret });
  ({ GET, POST } = await import("../../../apps/admin/app/api/account-review/route"));
  ({ POST: AUTH } = await import("../../../apps/admin/app/api/auth/staff/[...all]/route"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const admin = () => db.pool("app_admin");
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof QueueRefused ? e.why : `error: ${(e as Error).message}`;
  }
  return "accepted";
};

// ===== staff =====
const PW = "Fake-reviewer-password-1";
const staff: Record<string, string> = {}; // name -> staff id
const cookies: Record<string, string> = {};
let ipn = 10;
async function signIn(email: string): Promise<string> {
  const res = await AUTH(new Request("http://localhost:3002/api/auth/staff/sign-in/email", {
    method: "POST", body: JSON.stringify({ email, password: PW }),
    headers: { "content-type": "application/json", origin: "http://localhost:3002", "x-vercel-forwarded-for": `198.51.100.${ipn++}` },
  }));
  expect(res.status, email).toBe(200);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function makeStaff(name: string, roles: string[]) {
  const c = await su.connect();
  try {
    staff[name] = await seedStaff(c, { email: `${name}@example.test`, name: `Fake ${name}`, roles: roles.length ? roles : ["content_editor"] }, PW);
  } finally {
    c.release();
  }
  if (roles.length === 0) await su.query("delete from staff_role where staff_user_id = $1", [staff[name]]);
  cookies[name] = await signIn(`${name}@example.test`);
}
beforeAll(async () => {
  await makeStaff("reviewer", ["account_reviewer"]);
  await makeStaff("reviewer2", ["account_reviewer"]);
  await makeStaff("adminonly", ["administrator"]);
  await makeStaff("fetchedonly", ["fetched_job_reviewer"]);
  await makeStaff("norole", []);
  await makeStaff("disabled", ["account_reviewer"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [staff.disabled]); // after sign-in: the open session must be refused too
});

// ===== test data, made by the sign-up functions =====
const portal = () => db.pool("app_portal");
/** A company claim by a new verified login: an existing sponsor (unclaimed organisation) claimed on `domain`. Goes to review unless the domain is the company's own. */
async function claimed(o: { domain?: string; name?: string } = {}) {
  const domain = o.domain ?? `${id("co")}.example.test`;
  const org = await F.org({ status: "unclaimed", name: o.name ?? "Fake Sponsor Ltd" });
  const email = `${id("owner")}@${domain}`;
  const user = await F.portal({ email });
  const r = (await portal().query("select private.claim_organisation($1, $2) r", [user, org])).rows[0].r;
  const item = (await su.query("select id::text from review_item where queue = 'account_review' and organisation_id = $1 and status in ('open','claimed')", [org])).rows[0]?.id as string | undefined;
  return { org, user, email, domain, item: item!, status: r.status as string };
}
/** A new registration (first-time employer) by a new verified login: always goes to review. */
async function registered(o: { domain?: string; kind?: "employer" | "agency" } = {}) {
  const domain = o.domain ?? `${id("new")}.example.test`;
  const user = await F.portal({ email: `${id("founder")}@${domain}` });
  const kind = o.kind ?? "employer";
  const r = (await portal().query("select private.register_organisation($1, $2, 'Fresh Start Ltd', $3, $4) r", [user, kind, kind === "employer" ? id("cro") : null, kind === "agency" ? id("wrc") : null])).rows[0].r;
  const item = (await su.query("select id::text from review_item where queue = 'account_review' and organisation_id = $1", [r.organisation_id])).rows[0].id as string;
  return { org: String(r.organisation_id), user, domain, item };
}
const claimedBy = async (who: string, item: string) => claimReview(admin(), staff[who]!, item);
const orgRow = async (org: number | string) => (await su.query("select status, claimed_at, verified_at, signup_path from organisation where id = $1", [org])).rows[0];
const itemRow = async (item: string) => (await su.query("select status, claimed_by_staff_user_id, decided_by_staff_user_id, decided_at, outcome from review_item where id = $1", [item])).rows[0];
const domains = async (org: number | string) => (await su.query("select domain, source, added_by_staff_id from organisation_domain where organisation_id = $1", [org])).rows;
const audits = async (org: number | string) => (await su.query("select * from audit_event where object_type = 'organisation' and object_id = $1 and action like 'account_review.%' order by id", [String(org)])).rows;
// A ban row, written by the database owner with triggers and foreign keys off (a real ban needs a strike-3 case and an approval).
async function ban(col: "email_domain" | "cro_number", value: string) {
  const c = await su.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query(`insert into ban(${col}, reason_code, strike_id, approval_request_id) values ($1, 'fake_company', 0, 0)`, [value]);
    await c.query("commit");
  } finally {
    c.release();
  }
}
const members = async (org: number | string) => (await su.query("select status from membership where organisation_id = $1", [org])).rows.map((r) => r.status);

// ===== the functions =====
describe("list and look", () => {
  it("lists open and claimed account_review items oldest first with what a reviewer needs, a page at a time", async () => {
    const a = await claimed({ name: "Alpha Ltd" });
    const b = await registered();
    await claimedBy("reviewer", a.item);
    for (let i = 0; i < PAGE_SIZE + 2; i++) await registered();
    // other queues' items and decided items are not listed
    const other = await F.org({ status: "unclaimed" });
    await su.query("insert into review_item(queue, organisation_id, reason) values ('agency_client_check', $1, 'x')", [other]);
    // #262 (0049): the dead merge_confirmation queue is gone from the check
    await expect(su.query("insert into review_item(queue, organisation_id, reason) values ('merge_confirmation', $1, 'x')", [other])).rejects.toMatchObject({ code: "23514" });
    const done = await registered();
    await su.query("update review_item set status = 'done', outcome = 'approved', decided_at = now() where id = $1", [done.item]);

    const seen: { id: string; createdAt: string }[] = [];
    let page = await listAccountReviews(admin(), staff.reviewer!);
    expect(page.items).toHaveLength(PAGE_SIZE);
    expect(page.next).not.toBeNull();
    for (;;) {
      seen.push(...page.items);
      if (page.next === null) break;
      page = await listAccountReviews(admin(), staff.reviewer!, { after: page.next });
    }
    const ids = seen.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // no repeats across pages
    expect(ids).toContain(a.item);
    expect(ids).toContain(b.item);
    expect(ids).not.toContain(done.item);
    expect([...seen].sort((x, y) => x.createdAt.localeCompare(y.createdAt)).map((s) => s.id)).toEqual(ids); // oldest first
    const first = seen.find((s) => s.id === a.item) as unknown as Awaited<ReturnType<typeof getAccountReview>>;
    expect(first).toMatchObject({
      status: "claimed", claimedBy: staff.reviewer, reason: "claim", organisationId: String(a.org), displayName: "Alpha Ltd", kind: "employer",
      organisationStatus: "pending_review", signupPath: "dete_claim", claimantEmail: a.email, emailDomain: a.domain,
    });
    const reg = seen.find((s) => s.id === b.item) as unknown as NonNullable<Awaited<ReturnType<typeof getAccountReview>>>;
    expect(reg).toMatchObject({ reason: "new organisation", signupPath: "first_time", displayName: "Fresh Start Ltd", detail: { register: "cro_company", found: false, name_matches: false } });
    expect(reg.croNumber).not.toBeNull();
  });
  it("shows one item whatever its status, and null for an unknown id or another queue's item", async () => {
    const a = await claimed();
    expect(await getAccountReview(admin(), staff.reviewer!, a.item)).toMatchObject({ id: a.item, status: "open" });
    await su.query("update review_item set status = 'done', outcome = 'approved', decided_at = now() where id = $1", [a.item]);
    expect(await getAccountReview(admin(), staff.reviewer!, a.item)).toMatchObject({ status: "done" });
    const other = await F.org({ status: "unclaimed" });
    const wrong = (await su.query("insert into review_item(queue, organisation_id, reason) values ('agency_client_check', $1, 'x') returning id::text", [other])).rows[0].id;
    expect(await getAccountReview(admin(), staff.reviewer!, wrong)).toBeNull();
    expect(await getAccountReview(admin(), staff.reviewer!, "999999999999")).toBeNull();
    expect(await getAccountReview(admin(), staff.reviewer!, "1; drop table review_item")).toBeNull();
    expect(await refusal(listAccountReviews(admin(), staff.reviewer!, { after: "not-a-token" }))).toBe("bad_cursor");
  });
});

describe("claim and release", () => {
  it("claims an open item; the claimer may claim again; another reviewer is refused; release is the claimer's only", async () => {
    const a = await claimed();
    await claimedBy("reviewer", a.item);
    expect(await itemRow(a.item)).toMatchObject({ status: "claimed", claimed_by_staff_user_id: staff.reviewer });
    await claimedBy("reviewer", a.item);
    expect(await refusal(claimedBy("reviewer2", a.item))).toBe("claimed_by_other");
    expect(await refusal(releaseReview(admin(), staff.reviewer2!, a.item))).toBe("not_claimer");
    await releaseReview(admin(), staff.reviewer!, a.item);
    expect(await itemRow(a.item)).toMatchObject({ status: "open", claimed_by_staff_user_id: null });
    expect(await refusal(releaseReview(admin(), staff.reviewer!, a.item))).toBe("not_claimed");
  });
  it("takes over a stale claim (over 24 hours) and writes an audit row for it", async () => {
    const a = await claimed();
    await claimedBy("reviewer", a.item);
    await su.query("update review_item set claimed_at = now() - interval '48 hours' where id = $1", [a.item]);
    await claimedBy("reviewer2", a.item);
    expect(await itemRow(a.item)).toMatchObject({ claimed_by_staff_user_id: staff.reviewer2 });
    const t = (await su.query("select actor_staff_user_id, action, object_type from audit_event where object_type = 'review_item' and object_id = $1", [a.item])).rows;
    expect(t).toEqual([{ actor_staff_user_id: staff.reviewer2, action: "account_review.take_over", object_type: "review_item" }]);
  });
  it("refuses an unknown id, a made-up id and an item of another queue", async () => {
    const other = await F.org({ status: "unclaimed" });
    const wrong = (await su.query("insert into review_item(queue, organisation_id, reason) values ('agency_client_check', $1, 'x') returning id::text", [other])).rows[0].id;
    for (const bad of [wrong, "999999999999", "0", "-1", "1; drop table review_item", "abc", "99999999999999999999"]) expect(await refusal(claimedBy("reviewer", bad)), bad).toBe("not_found");
    expect((await itemRow(wrong)).status).toBe("open");
  });
});

describe("approve", () => {
  it("without the domain: the company is verified with verified_at, the item is done, one audit row with reason codes only, no domain row", async () => {
    const a = await claimed();
    await claimedBy("reviewer", a.item);
    const out = await approveAccount(admin(), staff.reviewer!, a.item);
    expect(out).toEqual({ organisationId: String(a.org), organisationStatus: "verified", domainAdded: null });
    expect(await orgRow(a.org)).toMatchObject({ status: "verified", signup_path: "dete_claim" });
    expect((await orgRow(a.org)).verified_at).not.toBeNull();
    expect(await itemRow(a.item)).toMatchObject({ status: "done", outcome: "approved", decided_by_staff_user_id: staff.reviewer });
    expect(await domains(a.org)).toEqual([]);
    const rows = await audits(a.org);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "admin_action", actor_staff_user_id: staff.reviewer, action: "account_review.approved", object_type: "organisation", object_id: String(a.org),
      changed_columns: ["status"], before: { status: "pending_review" }, after: { status: "verified", domain_added: false }, reason_code: "approved", reason_text: null, source: "panel",
    });
    expect(JSON.stringify(rows[0])).not.toContain(a.domain); // no email, no domain, no free text in the log
  });
  it("with the domain: the owner's domain is saved for the company (source admin, who added it); a colleague claiming ANOTHER company on it still goes to review", async () => {
    const a = await claimed();
    await claimedBy("reviewer", a.item);
    const out = await approveAccount(admin(), staff.reviewer!, a.item, { addDomain: true });
    expect(out.domainAdded).toBe(a.domain);
    expect(await domains(a.org)).toEqual([{ domain: a.domain, source: "admin", added_by_staff_id: staff.reviewer }]);
    expect((await audits(a.org))[0]).toMatchObject({ after: { status: "verified", domain_added: true } });
    // the domain belongs to the approved company, so another company's claim from it is not auto-verified
    const b = await claimed({ domain: a.domain });
    expect(b.status).toBe("pending_review");
    expect(b.item).toBeTruthy();
  });
  it("a claim on a company's OWN saved domain is verified at once (the rule #20 that approve-with-domain feeds)", async () => {
    const org = await F.org({ status: "unclaimed" });
    const d = `${id("own")}.example.test`;
    await su.query("insert into organisation_domain(organisation_id, domain, source) values ($1, $2, 'seed')", [org, d]);
    const user = await F.portal({ email: `${id("colleague")}@${d}` });
    const r = (await portal().query("select private.claim_organisation($1, $2) r", [user, org])).rows[0].r;
    expect(r.status).toBe("verified");
  });
  it("refuses to add a free email provider's domain; nothing changes and the item stays claimed; approving without the domain then works", async () => {
    const a = await claimed({ domain: "gmail.com" });
    await claimedBy("reviewer", a.item);
    expect(await refusal(approveAccount(admin(), staff.reviewer!, a.item, { addDomain: true }))).toBe("free_email_domain");
    expect(await orgRow(a.org)).toMatchObject({ status: "pending_review" });
    expect(await itemRow(a.item)).toMatchObject({ status: "claimed" });
    expect(await domains(a.org)).toEqual([]);
    expect(await audits(a.org)).toEqual([]);
    await approveAccount(admin(), staff.reviewer!, a.item);
    expect(await orgRow(a.org)).toMatchObject({ status: "verified" });
  });
  it("refuses to add a domain that belongs to another company; nothing is written", async () => {
    const domain = `${id("held")}.example.test`;
    const holder = await F.org();
    await su.query("insert into organisation_domain(organisation_id, domain, source) values ($1, $2, 'seed')", [holder, domain]);
    const a = await claimed({ domain });
    expect(a.status).toBe("pending_review"); // the sign-up function already sends it to review
    await claimedBy("reviewer", a.item);
    expect(await refusal(approveAccount(admin(), staff.reviewer!, a.item, { addDomain: true }))).toBe("domain_owned_by_other");
    expect(await orgRow(a.org)).toMatchObject({ status: "pending_review" });
    expect(await domains(a.org)).toEqual([]);
    expect((await su.query("select count(*)::int n from organisation_domain where domain = $1", [domain])).rows[0].n).toBe(1);
  });
  it("refuses addDomain when the company has no active owner, and a non-boolean addDomain", async () => {
    const a = await claimed();
    await claimedBy("reviewer", a.item);
    expect(await refusal(approveAccount(admin(), staff.reviewer!, a.item, { addDomain: "yes" as never }))).toBe("bad_input");
    await su.query("update membership set status = 'removed' where organisation_id = $1", [a.org]);
    expect(await refusal(approveAccount(admin(), staff.reviewer!, a.item, { addDomain: true }))).toBe("no_claimant");
    expect(await domains(a.org)).toEqual([]);
  });
  it("claimant checked again at approval: blocked, erased, or banned since the claim; all refused with nothing written, and reject still works", async () => {
    const blocked = await claimed();
    await su.query("update portal_user set status = 'blocked', blocked_at = now(), blocked_reason_code = 'fake_company' where id = $1", [blocked.user]);
    const erased = await claimed();
    // 0050: a sole owner of an open company is not erased (close_company_first), so the claimant leaves the company first, then is erased.
    await su.query("update membership set status = 'removed', removed_at = now() where organisation_id = $1 and portal_user_id = $2", [erased.org, erased.user]);
    expect((await admin().query("select private.erase_portal_user($1, true) r", [erased.user])).rows[0].r.erased).toBe(true);
    const domainBanned = await claimed();
    await ban("email_domain", domainBanned.domain);
    const numberBanned = await registered();
    await ban("cro_number", (await su.query("select cro_number from organisation where id = $1", [numberBanned.org])).rows[0].cro_number);
    const cases = [[blocked, "claimant_not_active"], [erased, "no_claimant"], [domainBanned, "claimant_not_active"], [numberBanned, "claimant_not_active"]] as const;
    for (const [c, why] of cases) {
      await claimedBy("reviewer", c.item);
      for (const addDomain of [false, true]) expect(await refusal(approveAccount(admin(), staff.reviewer!, c.item, { addDomain })), `${c.org} ${addDomain}`).toBe(why);
      expect(await orgRow(c.org)).toMatchObject({ status: "pending_review", verified_at: null });
      expect(await itemRow(c.item)).toMatchObject({ status: "claimed" });
      expect(await domains(c.org)).toEqual([]);
      expect(await audits(c.org)).toEqual([]);
    }
    for (const [c] of cases) expect(await rejectAccount(admin(), staff.reviewer!, c.item, "claimant_not_active")).toMatchObject({ organisationId: String(c.org) });
    expect(await orgRow(blocked.org)).toMatchObject({ status: "unclaimed" });
    expect(await orgRow(numberBanned.org)).toMatchObject({ status: "rejected" });
  });
  it("a ban on some other domain does not stop an approval", async () => {
    const a = await claimed();
    await ban("email_domain", "someone-else.example.test");
    await claimedBy("reviewer", a.item);
    await approveAccount(admin(), staff.reviewer!, a.item);
    expect(await orgRow(a.org)).toMatchObject({ status: "verified" });
  });
  it("two reviewers adding one domain to two different companies at once: one succeeds, the other gets domain_owned_by_other (the advisory lock)", async () => {
    for (let round = 0; round < 6; round++) {
      const domain = `${id("race")}.example.test`;
      const a = await claimed({ domain }), b = await claimed({ domain });
      await claimedBy("reviewer", a.item);
      await claimedBy("reviewer2", b.item);
      const r = await Promise.all([
        approveAccount(admin(), staff.reviewer!, a.item, { addDomain: true }).then(() => "ok", (e: QueueRefused) => e.why),
        approveAccount(admin(), staff.reviewer2!, b.item, { addDomain: true }).then(() => "ok", (e: QueueRefused) => e.why),
      ]);
      expect(r.sort(), `round ${round}`).toEqual(["domain_owned_by_other", "ok"]);
      expect((await su.query("select count(*)::int n from organisation_domain where domain = $1", [domain])).rows[0].n).toBe(1);
    }
  });
  it("approves a new registration too (first-time employer and agency)", async () => {
    for (const kind of ["employer", "agency"] as const) {
      const r = await registered({ kind });
      await claimedBy("reviewer", r.item);
      await approveAccount(admin(), staff.reviewer!, r.item, { addDomain: true });
      expect(await orgRow(r.org)).toMatchObject({ status: "verified" });
      expect((await domains(r.org))[0]).toMatchObject({ domain: r.domain });
    }
  });
  it("is refused without a claim, by a non-claimer, and twice; the organisation is untouched by the refused tries", async () => {
    const a = await claimed();
    expect(await refusal(approveAccount(admin(), staff.reviewer!, a.item))).toBe("not_claimed");
    await claimedBy("reviewer", a.item);
    expect(await refusal(approveAccount(admin(), staff.reviewer2!, a.item))).toBe("not_claimer");
    expect(await refusal(rejectAccount(admin(), staff.reviewer2!, a.item, "nope"))).toBe("not_claimer");
    expect(await refusal(askForMoreInfo(admin(), staff.reviewer2!, a.item))).toBe("not_claimer");
    expect(await orgRow(a.org)).toMatchObject({ status: "pending_review" });
    await approveAccount(admin(), staff.reviewer!, a.item);
    expect(await refusal(approveAccount(admin(), staff.reviewer!, a.item))).toBe("already_decided");
    expect(await refusal(rejectAccount(admin(), staff.reviewer!, a.item, "late"))).toBe("already_decided");
    expect(await refusal(askForMoreInfo(admin(), staff.reviewer!, a.item))).toBe("already_decided");
    expect(await orgRow(a.org)).toMatchObject({ status: "verified" });
    expect(await audits(a.org)).toHaveLength(1);
  });
  it("two approvals at the same moment: one wins, the other is refused, one audit row", async () => {
    const a = await claimed();
    await claimedBy("reviewer", a.item);
    const r = await Promise.all([approveAccount(admin(), staff.reviewer!, a.item, { addDomain: true }).then(() => "ok", (e: QueueRefused) => e.why), approveAccount(admin(), staff.reviewer!, a.item, { addDomain: true }).then(() => "ok", (e: QueueRefused) => e.why)]);
    expect(r.sort()).toEqual(["already_decided", "ok"]);
    expect(await audits(a.org)).toHaveLength(1);
    expect(await domains(a.org)).toHaveLength(1);
  });
  it("is refused when the company is no longer pending review (changed by something else)", async () => {
    const a = await claimed();
    await claimedBy("reviewer", a.item);
    await su.query("update organisation set status = 'suspended' where id = $1", [a.org]);
    expect(await refusal(approveAccount(admin(), staff.reviewer!, a.item))).toBe("organisation_not_pending");
    expect(await orgRow(a.org)).toMatchObject({ status: "suspended" });
  });
});

describe("approve: the First-time sponsor label (#73)", () => {
  const label = async (org: number | string) => (await su.query("select permit_history from organisation where id = $1", [org])).rows[0].permit_history as string;
  // a live job written as postgres, so the app guards do not interfere (as permit-history.test.ts does)
  async function job(org: number | string) {
    const src = (await su.query("insert into job_source(kind,board) values ('portal',$1) returning id", [id("b")])).rows[0].id;
    return (await su.query(`insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,search_vector)
      values ($1,'admin_manual',$2,'Cook','Org','it','critical_skills','live',now()+interval '20 days','https://example.test/a',to_tsvector('english','cook')) returning id`, [org, src])).rows[0].id as string;
  }
  const jobLabel = async (j: string) => (await su.query("select permit_history from job where id = $1", [j])).rows[0].permit_history as string;
  async function withDete(org: number | string, year: number, permits: number) {
    const tag = id("dete");
    const n = (await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, $2, 'alias', 'admin') returning id::text", [org, tag])).rows[0].id;
    await su.query("insert into dete_permit_count(dete_name, organisation_name_id, year, permits) values ($1, $2, $3, $4)", [tag, n, year, permits]);
  }
  const state = async (r: { org: number | string; item: string }) => JSON.stringify([await orgRow(r.org), await itemRow(r.item), await audits(r.org), await label(r.org)]);

  it("a first-time registration gets the label, its open jobs follow, and the audit row says so", async () => {
    const r = await registered();
    const j = await job(r.org);
    expect(await label(r.org)).toBe("not_linked");
    await claimedBy("reviewer", r.item);
    await approveAccount(admin(), staff.reviewer!, r.item);
    expect(await label(r.org)).toBe("first_time");
    expect(await jobLabel(j)).toBe("first_time");
    expect((await audits(r.org))[0]).toMatchObject({ after: { status: "verified", domain_added: false, first_time_label: true } });
  });
  it("an agency registration and a DETE claim are left as they were", async () => {
    const agency = await registered({ kind: "agency" });
    const claim = await claimed();
    for (const x of [agency, claim]) {
      await claimedBy("reviewer", x.item);
      await approveAccount(admin(), staff.reviewer!, x.item);
      expect(await label(x.org)).toBe("not_linked");
      expect((await audits(x.org))[0]!.after).toEqual({ status: "verified", domain_added: false });
    }
  });
  it("a first-time registration with a qualifying DETE row is refused as has_permit_history and nothing changes; 2018 and 0 permits do not count", async () => {
    const r = await registered();
    await withDete(r.org, 2024, 3);
    await claimedBy("reviewer", r.item);
    const before = await state(r);
    expect(await refusal(approveAccount(admin(), staff.reviewer!, r.item))).toBe("has_permit_history");
    expect(await state(r)).toBe(before);
    expect(await orgRow(r.org)).toMatchObject({ status: "pending_review", verified_at: null });
    expect(await itemRow(r.item)).toMatchObject({ status: "claimed" });
    expect(await audits(r.org)).toEqual([]);
    expect(await label(r.org)).toBe("not_linked");
    const old = await registered();
    await withDete(old.org, 2018, 9);
    await withDete(old.org, 2025, 0);
    await claimedBy("reviewer", old.item);
    await approveAccount(admin(), staff.reviewer!, old.item);
    expect(await label(old.org)).toBe("first_time");
  });
  it("through the real route the refusal is 409 has_permit_history, and an approve there sets the label", async () => {
    const bad = await registered();
    await withDete(bad.org, 2024, 3);
    await post("reviewer", { action: "claim", itemId: bad.item });
    expect(await post("reviewer", { action: "approve", itemId: bad.item })).toEqual({ status: 409, json: { error: "has_permit_history" } });
    expect(await label(bad.org)).toBe("not_linked");
    const ok = await registered();
    await post("reviewer", { action: "claim", itemId: ok.item });
    expect((await post("reviewer", { action: "approve", itemId: ok.item })).status).toBe(200);
    expect(await label(ok.org)).toBe("first_time");
  });
  it("security: the label is not set when approve is refused (no claim, not the claimer, wrong role, company not pending)", async () => {
    const a = await registered();
    expect(await refusal(approveAccount(admin(), staff.reviewer!, a.item))).toBe("not_claimed");
    await claimedBy("reviewer", a.item);
    expect(await refusal(approveAccount(admin(), staff.reviewer2!, a.item))).toBe("not_claimer");
    for (const who of ["adminonly", "fetchedonly", "norole", "disabled"]) expect(await refusal(approveAccount(admin(), staff[who]!, a.item)), who).toMatch(/^not_/);
    expect(await label(a.org)).toBe("not_linked");
    await su.query("update organisation set status = 'suspended' where id = $1", [a.org]);
    expect(await refusal(approveAccount(admin(), staff.reviewer!, a.item))).toBe("organisation_not_pending");
    expect(await label(a.org)).toBe("not_linked");
  });
});

describe("ask for more information", () => {
  it("moves the company to needs_info and puts the item back to open, unclaimed; the audit row holds the reason code and the real old status", async () => {
    const a = await claimed();
    await claimedBy("reviewer", a.item);
    expect(await askForMoreInfo(admin(), staff.reviewer!, a.item, "need_cro_proof")).toEqual({ organisationId: String(a.org), organisationStatus: "needs_info", domainAdded: null });
    expect(await orgRow(a.org)).toMatchObject({ status: "needs_info" });
    expect(await itemRow(a.item)).toMatchObject({ status: "open", claimed_by_staff_user_id: null, outcome: "needs_info" });
    expect(await members(a.org)).toEqual(["active"]); // the claimant keeps access so they can answer
    expect((await audits(a.org))[0]).toMatchObject({ action: "account_review.needs_info", reason_code: "need_cro_proof", before: { status: "pending_review" }, after: { status: "needs_info" } });
    // still the company's one open item
    await expect(su.query("insert into review_item(queue, organisation_id, reason) values ('account_review', $1, 'answered')", [a.org])).rejects.toThrow(/review_item_org_unique/);
  });
  it("afterwards the item is claimed again and the case can be approved (audit before is needs_info), rejected, or asked again", async () => {
    const a = await claimed();
    await claimedBy("reviewer", a.item);
    await askForMoreInfo(admin(), staff.reviewer!, a.item);
    expect(await refusal(approveAccount(admin(), staff.reviewer!, a.item))).toBe("not_claimed"); // needs a fresh claim, by anyone
    await claimedBy("reviewer2", a.item);
    expect(await refusal(approveAccount(admin(), staff.reviewer!, a.item))).toBe("not_claimer");
    await askForMoreInfo(admin(), staff.reviewer2!, a.item, "still_need_proof"); // needs_info again
    await claimedBy("reviewer", a.item);
    await approveAccount(admin(), staff.reviewer!, a.item, { addDomain: true });
    expect(await orgRow(a.org)).toMatchObject({ status: "verified" });
    expect(await itemRow(a.item)).toMatchObject({ status: "done", outcome: "approved", decided_by_staff_user_id: staff.reviewer });
    expect((await audits(a.org)).map((r) => [r.reason_code, r.before.status, r.after.status])).toEqual([
      ["needs_info", "pending_review", "needs_info"], ["still_need_proof", "needs_info", "needs_info"], ["approved", "needs_info", "verified"]]);

    const c = await claimed();
    await claimedBy("reviewer", c.item);
    await askForMoreInfo(admin(), staff.reviewer!, c.item);
    await claimedBy("reviewer", c.item);
    expect(await rejectAccount(admin(), staff.reviewer!, c.item, "no_proof")).toMatchObject({ organisationStatus: "unclaimed" });
    expect(await members(c.org)).toEqual(["removed"]);
    expect(await itemRow(c.item)).toMatchObject({ status: "done", outcome: "rejected" });
    expect((await audits(c.org)).at(-1)).toMatchObject({ before: { status: "needs_info" }, after: { status: "unclaimed" } });

    const r = await registered();
    await claimedBy("reviewer", r.item);
    await askForMoreInfo(admin(), staff.reviewer!, r.item);
    await claimedBy("reviewer", r.item);
    expect(await rejectAccount(admin(), staff.reviewer!, r.item, "no_proof")).toMatchObject({ organisationStatus: "rejected" });
    expect(await members(r.org)).toEqual(["removed"]);
  });
  it("retention rule 13 after 30 days: a claim goes back to unclaimed, a registration becomes rejected; members removed and the open item dropped", async () => {
    const age = async (org: number | string) => {
      await su.query("alter table organisation disable trigger organisation_guard");
      await su.query("update organisation set status_changed_at = now() - interval '400 days' where id = $1", [org]);
      await su.query("alter table organisation enable trigger organisation_guard");
    };
    const a = await claimed();
    const r = await registered();
    const fresh = await claimed(); // asked for more just now: the rule leaves it alone
    for (const x of [a, r, fresh]) { await claimedBy("reviewer", x.item); await askForMoreInfo(admin(), staff.reviewer!, x.item); }
    await claimedBy("reviewer", a.item); // claimed again when the rule runs: dropped all the same
    await age(a.org);
    await age(r.org);
    for (let i = 0; i < 30; i++) {
      const out = (await admin().query("select private.run_retention(1000) r")).rows[0].r;
      if (out.rule === "claim_needs_info" || out.rule === null) { expect(out.done).toBe(2); break; }
    }
    expect(await orgRow(a.org)).toMatchObject({ status: "unclaimed", signup_path: null });
    expect(await orgRow(r.org)).toMatchObject({ status: "rejected", signup_path: "first_time" });
    expect(await members(a.org)).toEqual(["removed"]);
    expect(await members(r.org)).toEqual(["removed"]);
    for (const x of [a, r]) expect(await itemRow(x.item)).toMatchObject({ status: "dropped", outcome: "needs_info_expired" });
    expect(await orgRow(fresh.org)).toMatchObject({ status: "needs_info" });
    expect(await itemRow(fresh.item)).toMatchObject({ status: "open" });
    // the real company can claim the page again; the rejected registration holds no number
    const real = await F.portal({ email: `${id("real")}@real.example.test` });
    expect((await portal().query("select private.claim_organisation($1, $2) r", [real, a.org])).rows[0].r.status).toBe("pending_review");
  });
  it("uses the code needs_info when no reason is given, and refuses free text", async () => {
    const a = await claimed();
    await claimedBy("reviewer", a.item);
    expect(await refusal(askForMoreInfo(admin(), staff.reviewer!, a.item, "Please send your CRO letter!"))).toBe("bad_reason");
    expect((await orgRow(a.org)).status).toBe("pending_review");
    await askForMoreInfo(admin(), staff.reviewer!, a.item);
    expect((await audits(a.org))[0]).toMatchObject({ reason_code: "needs_info" });
  });
});

describe("reject", () => {
  it("a rejected claim of an existing sponsor returns the company to unclaimed (claimable by the right person) and removes the claimant", async () => {
    const a = await claimed();
    await claimedBy("reviewer", a.item);
    expect(await rejectAccount(admin(), staff.reviewer!, a.item, "not_the_company")).toMatchObject({ organisationStatus: "unclaimed" });
    expect(await orgRow(a.org)).toMatchObject({ status: "unclaimed", claimed_at: null, verified_at: null, signup_path: null });
    expect(await members(a.org)).toEqual(["removed"]);
    expect(await itemRow(a.item)).toMatchObject({ status: "done", outcome: "rejected" });
    expect((await audits(a.org))[0]).toMatchObject({ action: "account_review.rejected", reason_code: "not_the_company", after: { status: "unclaimed" }, reason_text: null });
    // the right person can now claim it
    const other = await F.portal({ email: `${id("real")}@real.example.test` });
    expect((await portal().query("select private.claim_organisation($1, $2) r", [other, a.org])).rows[0].r.status).toBe("pending_review");
  });
  it("a rejected new registration becomes rejected and its members are removed", async () => {
    const r = await registered();
    await claimedBy("reviewer", r.item);
    expect(await rejectAccount(admin(), staff.reviewer!, r.item, "fake_company")).toMatchObject({ organisationStatus: "rejected" });
    expect(await orgRow(r.org)).toMatchObject({ status: "rejected" });
    expect(await members(r.org)).toEqual(["removed"]);
    expect((await audits(r.org))[0]).toMatchObject({ reason_code: "fake_company", after: { status: "rejected" } });
  });
  it("needs a reason that is a code, never free text", async () => {
    const a = await claimed();
    await claimedBy("reviewer", a.item);
    for (const bad of ["", "Not a real company", undefined, null, 5, "x".repeat(200), "a'; drop table organisation;--"])
      expect(await refusal(rejectAccount(admin(), staff.reviewer!, a.item, bad as never)), String(bad)).toBe("bad_reason");
    expect(await orgRow(a.org)).toMatchObject({ status: "pending_review" });
  });
});

// ===== who may act, from each role =====
describe("roles: only an active account_reviewer", () => {
  it("every function refuses staff with no role, with fetched_job_reviewer only, with administrator only, and a disabled reviewer, and changes nothing", async () => {
    const a = await claimed();
    await claimedBy("reviewer", a.item);
    const before = JSON.stringify([await orgRow(a.org), await itemRow(a.item), await su.query("select count(*)::int n from audit_event").then((r) => r.rows[0].n)]);
    const want: Record<string, string> = { norole: "not_reviewer", fetchedonly: "not_reviewer", adminonly: "not_reviewer", disabled: "not_active_staff" };
    for (const [who, why] of Object.entries(want)) {
      const s = staff[who]!;
      const results = await Promise.all([
        refusal(listAccountReviews(admin(), s)), refusal(getAccountReview(admin(), s, a.item)), refusal(claimReview(admin(), s, a.item)),
        refusal(releaseReview(admin(), s, a.item)), refusal(approveAccount(admin(), s, a.item, { addDomain: true })),
        refusal(askForMoreInfo(admin(), s, a.item)), refusal(rejectAccount(admin(), s, a.item, "nope")),
      ]);
      expect(results, who).toEqual(Array(7).fill(why));
    }
    for (const bad of ["", "nobody", "x".repeat(300), "1' or '1'='1", undefined as never])
      expect(await refusal(claimReview(admin(), bad, a.item)), String(bad)).toBe("not_active_staff");
    expect(JSON.stringify([await orgRow(a.org), await itemRow(a.item), await su.query("select count(*)::int n from audit_event").then((r) => r.rows[0].n)])).toBe(before);
  });
  it("a staff member who holds several roles including account_reviewer may act", async () => {
    await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, 'administrator', true)", [staff.reviewer2]);
    const a = await claimed();
    await claimedBy("reviewer2", a.item);
    expect((await itemRow(a.item)).claimed_by_staff_user_id).toBe(staff.reviewer2);
  });
  it("the other app logins cannot do the decision themselves (portal, candidate, fetcher)", async () => {
    const a = await claimed();
    for (const role of ["app_portal", "app_candidate", "app_fetcher"] as const) {
      await expect(db.query(role, "update organisation set status = 'verified' where id = $1", [a.org]), role).rejects.toThrow(/permission denied|new row|cannot/i);
      await expect(db.query(role, "insert into organisation_domain(organisation_id, domain, source) values ($1, 'x.example.test', 'admin')", [a.org]), role).rejects.toThrow(/permission denied/i);
    }
    expect(await orgRow(a.org)).toMatchObject({ status: "pending_review" });
  });
});

// ===== the real route handlers =====
const ORIGIN = "http://localhost:3002";
const call = (method: "GET" | "POST", who: string | null, o: { path?: string; body?: unknown; raw?: string; origin?: string | null; cookie?: string } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const c = o.cookie ?? (who ? cookies[who] : undefined);
  if (c) headers.cookie = c;
  if (method === "POST" && o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  const init: RequestInit = { method, headers, ...(method === "POST" ? { body: o.raw ?? JSON.stringify(o.body) } : {}) };
  return (method === "GET" ? GET : POST)(new Request(`${ORIGIN}/api/account-review${o.path ?? ""}`, init));
};
const post = async (who: string | null, body: unknown, o: Parameters<typeof call>[2] = {}) => {
  const res = await call("POST", who, { ...o, body });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const get = async (who: string | null, path = "", o: Parameters<typeof call>[2] = {}) => {
  const res = await call("GET", who, { ...o, path });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

describe("route: the whole path to a Verified company", () => {
  it("list, look, claim, approve with the domain, through a real staff session", async () => {
    const a = await claimed({ name: "Route Sponsor Ltd" });
    const ids: string[] = [];
    for (let after = ""; ; ) {
      const list = await get("reviewer", after ? `?after=${after}` : "");
      expect(list.status).toBe(200);
      ids.push(...(list.json.items as { id: string }[]).map((i) => i.id));
      if (list.json.next === null) break;
      after = list.json.next as string;
    }
    expect(ids).toContain(a.item);
    const one = await get("reviewer", `?id=${a.item}`);
    expect(one.status).toBe(200);
    expect(one.json.item).toMatchObject({ id: a.item, displayName: "Route Sponsor Ltd", claimantEmail: a.email, emailDomain: a.domain, signupPath: "dete_claim" });
    expect(await post("reviewer", { action: "claim", itemId: a.item })).toEqual({ status: 200, json: { ok: true } });
    const done = await post("reviewer", { action: "approve", itemId: a.item, addDomain: true });
    expect(done).toEqual({ status: 200, json: { ok: true, organisationId: String(a.org), organisationStatus: "verified", domainAdded: a.domain } });
    expect(await orgRow(a.org)).toMatchObject({ status: "verified" });
    expect((await domains(a.org))[0]).toMatchObject({ domain: a.domain, added_by_staff_id: staff.reviewer });
    expect(await post("reviewer", { action: "approve", itemId: a.item })).toEqual({ status: 409, json: { error: "already_decided" } });
  });
  it("ask for more, reject a claim, reject a registration, release", async () => {
    const m = await claimed();
    await post("reviewer", { action: "claim", itemId: m.item });
    expect((await post("reviewer", { action: "ask_more", itemId: m.item, reason: "need_cro_proof" })).json).toMatchObject({ organisationStatus: "needs_info" });
    const c = await claimed();
    await post("reviewer", { action: "claim", itemId: c.item });
    expect((await post("reviewer", { action: "reject", itemId: c.item, reason: "not_the_company" })).json).toMatchObject({ organisationStatus: "unclaimed" });
    const r = await registered();
    await post("reviewer", { action: "claim", itemId: r.item });
    expect((await post("reviewer", { action: "reject", itemId: r.item, reason: "fake_company" })).json).toMatchObject({ organisationStatus: "rejected" });
    const x = await claimed();
    await post("reviewer", { action: "claim", itemId: x.item });
    expect((await post("reviewer", { action: "release", itemId: x.item })).status).toBe(200);
    expect(await post("reviewer", { action: "release", itemId: x.item })).toEqual({ status: 409, json: { error: "not_claimed" } });
  });
  it("refusals come back as short codes with 404 and 409, and a non-claimer cannot decide", async () => {
    const a = await claimed();
    expect(await post("reviewer", { action: "approve", itemId: a.item })).toEqual({ status: 409, json: { error: "not_claimed" } });
    await post("reviewer", { action: "claim", itemId: a.item });
    expect(await post("reviewer2", { action: "claim", itemId: a.item })).toEqual({ status: 409, json: { error: "claimed_by_other" } });
    expect(await post("reviewer2", { action: "reject", itemId: a.item, reason: "nope" })).toEqual({ status: 409, json: { error: "not_claimer" } });
    expect(await post("reviewer", { action: "claim", itemId: "999999999999" })).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await get("reviewer", "?id=999999999999")).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await get("reviewer", "?id=1%3B%20drop%20table")).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await get("reviewer", "?after=garbage")).toEqual({ status: 400, json: { error: "bad_cursor" } });
    const g = await claimed({ domain: "gmail.com" });
    await post("reviewer", { action: "claim", itemId: g.item });
    expect(await post("reviewer", { action: "approve", itemId: g.item, addDomain: true })).toEqual({ status: 409, json: { error: "free_email_domain" } });
    // a malformed claimant domain is bad_domain with the same 400 as on /api/companies/domains
    const p = await claimed({ domain: "xn--fake.example.test" });
    await post("reviewer", { action: "claim", itemId: p.item });
    expect(await post("reviewer", { action: "approve", itemId: p.item, addDomain: true })).toEqual({ status: 400, json: { error: "bad_domain" } });
  });
  it("hostile ids and query strings: 0, leading zeros and too long are bad_item_id; unknown or repeated keys are bad_query", async () => {
    const a = await claimed();
    for (const itemId of ["0", `0${a.item}`, "00", "9223372036854775808", "1".repeat(20), Number(a.item)])
      expect(await post("reviewer", { action: "claim", itemId }), String(itemId)).toEqual({ status: 400, json: { error: "bad_item_id" } });
    for (const q of ["?x=1", "?id=1&id=2", "?after=a&after=b", "?before=x", `?id=${a.item}&staff=me`]) expect(await get("reviewer", q), q).toEqual({ status: 400, json: { error: "bad_query" } });
    expect((await itemRow(a.item)).status).toBe("open");
  });
  it("an item of the fetched_job queue is not found by any action", async () => {
    const org = await F.org({ status: "unclaimed" });
    const wrong = (await su.query("insert into review_item(queue, organisation_id, reason) values ('agency_client_check', $1, 'x') returning id::text", [org])).rows[0].id;
    for (const action of ["claim", "release", "approve", "ask_more"]) expect(await post("reviewer", { action, itemId: wrong }), action).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await post("reviewer", { action: "reject", itemId: wrong, reason: "nope" })).toEqual({ status: 404, json: { error: "not_found" } });
    expect((await get("reviewer", `?id=${wrong}`)).status).toBe(404);
  });
});

describe("route: who may call it", () => {
  const item = async () => (await claimed()).item;
  it("no session, a made-up cookie, portal and candidate cookies: 401", async () => {
    const i = await item();
    for (const cookie of [undefined, "staff.session_token=made-up.value", "portal.session_token=abc.def", "candidate.session_token=abc.def", "portal.session_token=abc.def; candidate.session_token=abc.def"]) {
      expect(await get(null, "", { cookie }), String(cookie)).toEqual({ status: 401, json: { error: "no_session" } });
      expect(await post(null, { action: "claim", itemId: i }, { cookie }), String(cookie)).toEqual({ status: 401, json: { error: "no_session" } });
    }
    expect((await itemRow(i)).status).toBe("open");
  });
  it("a disabled staff member's open session: 401", async () => {
    const i = await item();
    expect(await get("disabled")).toEqual({ status: 401, json: { error: "not_active" } });
    expect(await post("disabled", { action: "claim", itemId: i })).toEqual({ status: 401, json: { error: "not_active" } });
  });
  it("staff with no role, fetched_job_reviewer only or administrator only: 403 on every call", async () => {
    const i = await item();
    for (const who of ["norole", "fetchedonly", "adminonly"]) {
      expect(await get(who), who).toEqual({ status: 403, json: { error: "not_reviewer" } });
      expect(await get(who, `?id=${i}`), who).toEqual({ status: 403, json: { error: "not_reviewer" } });
      for (const body of [{ action: "claim", itemId: i }, { action: "release", itemId: i }, { action: "approve", itemId: i, addDomain: true }, { action: "ask_more", itemId: i }, { action: "reject", itemId: i, reason: "nope" }])
        expect(await post(who, body), `${who} ${body.action}`).toEqual({ status: 403, json: { error: "not_reviewer" } });
    }
    expect((await itemRow(i)).status).toBe("open");
  });
  it("a POST with a missing or foreign Origin is refused with 403 before anything else, even from a reviewer", async () => {
    const i = await item();
    for (const origin of [null, "", "null", "https://evil.example.test", "http://localhost:3000", "http://localhost:3002.evil.test", "http://localhost:3002/"]) {
      const res = await call("POST", "reviewer", { body: { action: "claim", itemId: i }, origin });
      expect({ origin, status: res.status, json: await res.json() }).toEqual({ origin, status: 403, json: { error: "bad_origin" } });
    }
    expect((await itemRow(i)).status).toBe("open");
  });
});

describe("route: odd bodies", () => {
  it("a content-length over the limit is refused with 400 before the body is read", async () => {
    let read = false;
    const req = { method: "POST", headers: new Headers({ origin: ORIGIN, "content-length": "99999999", cookie: cookies.reviewer! }), text: async () => { read = true; return "{}"; } } as unknown as Request;
    const res = await POST(req);
    expect([res.status, await res.json(), read]).toEqual([400, { error: "bad_body" }, false]);
  });
  it("wrong types, extra fields, nested values, huge text and SQL-looking ids are refused with 400 and change nothing", async () => {
    const i = (await claimed()).item;
    await post("reviewer", { action: "claim", itemId: i });
    const bad: [string, unknown][] = [
      ["bad_body", "claim"], ["bad_body", null], ["bad_body", []], ["bad_body", 7], ["bad_body", { action: "claim", itemId: i, staffId: staff.reviewer }],
      ["bad_action", {}], ["bad_action", { itemId: i }], ["bad_action", { action: ["claim"], itemId: i }], ["bad_action", { action: { $ne: 1 }, itemId: i }], ["bad_action", { action: "drop", itemId: i }],
      ["bad_item_id", { action: "claim" }], ["bad_item_id", { action: "claim", itemId: Number(i) }], ["bad_item_id", { action: "claim", itemId: `${i}; drop table review_item` }],
      ["bad_item_id", { action: "claim", itemId: `${i}' or '1'='1` }], ["bad_item_id", { action: "claim", itemId: [i] }], ["bad_item_id", { action: "claim", itemId: { id: i } }], ["bad_item_id", { action: "claim", itemId: "-1" }],
      ["bad_body", { action: "approve", itemId: i, addDomain: "true" }], ["bad_body", { action: "approve", itemId: i, addDomain: { a: { b: 1 } } }], ["bad_body", { action: "approve", itemId: i, reason: "fine" }],
      ["bad_reason", { action: "reject", itemId: i }], ["bad_reason", { action: "reject", itemId: i, reason: "Not a real company" }], ["bad_reason", { action: "reject", itemId: i, reason: "x".repeat(200) }],
      ["bad_reason", { action: "reject", itemId: i, reason: "a'; drop table organisation;--" }], ["bad_reason", { action: "ask_more", itemId: i, reason: "Send us your CRO letter" }],
      ["bad_body", { action: "claim", itemId: i, pad: "x".repeat(5000) }],
    ];
    for (const [why, body] of bad) expect(await post("reviewer", body), JSON.stringify(body).slice(0, 80)).toEqual({ status: 400, json: { error: why } });
    for (const raw of ["", "{", "{'action':'claim'}", "x".repeat(100_000), '{"action":"claim","itemId":"1","__proto__":{"a":1}}']) {
      const res = await call("POST", "reviewer", { raw });
      expect({ raw: raw.slice(0, 20), status: res.status, json: await res.json() }).toEqual({ raw: raw.slice(0, 20), status: 400, json: { error: "bad_body" } });
    }
    expect(await itemRow(i)).toMatchObject({ status: "claimed", outcome: null });
  });
  it("a failure that is not a known refusal answers a plain 500 with no detail", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const saved = process.env.STAFF_AUTH_URL;
    delete process.env.STAFF_AUTH_URL; // the origin test cannot read its setting: fails closed
    try {
      const res = await call("POST", "reviewer", { body: { action: "claim", itemId: "1" } });
      expect({ status: res.status, json: await res.json() }).toEqual({ status: 500, json: { error: "server_error" } });
      expect(logged).toHaveBeenCalled();
    } finally {
      process.env.STAFF_AUTH_URL = saved;
      logged.mockRestore();
    }
  });
});

// ===== performance: statements and time =====
async function counted<T>(fn: () => Promise<T>): Promise<[T, number, number]> {
  const pgmod = await import("pg");
  const q = pgmod.default.Client.prototype.query;
  let n = 0;
  pgmod.default.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  const t0 = performance.now();
  try {
    const out = await fn();
    return [out, n, performance.now() - t0];
  } finally {
    pgmod.default.Client.prototype.query = q;
  }
}
describe("performance budgets", () => {
  it("function level: statement counts and median time (of 9) for list, one item, claim and approve (with and without the domain)", async () => {
    for (let i = 0; i < 25; i++) await registered();
    const out: Record<string, [number, number]> = {};
    // each state-changing call needs its own item, so 9 are made up front; the statements are counted on the first call, the time is the median of the 9
    const measure = async <T>(fn: (n: number) => Promise<T>): Promise<[number, number]> => {
      const ms: number[] = [];
      let statements = 0;
      for (let n = 0; n < 9; n++) {
        const [, sent, took] = await counted(() => fn(n));
        if (n === 0) statements = sent;
        ms.push(took);
      }
      return [statements, ms.sort((x, y) => x - y)[4]!];
    };
    const items = async () => { const l: Awaited<ReturnType<typeof claimed>>[] = []; for (let n = 0; n < 9; n++) l.push(await claimed()); return l; };
    const forClaim = await items(), plain = await items(), withDomain = await items();
    const firstTime: { item: string }[] = [];
    for (let n = 0; n < 9; n++) firstTime.push(await registered());
    for (const x of [...plain, ...withDomain, ...firstTime]) await claimedBy("reviewer", x.item);
    await listAccountReviews(admin(), staff.reviewer!); // warm the pool
    out.list = await measure(() => listAccountReviews(admin(), staff.reviewer!));
    out.item = await measure(() => getAccountReview(admin(), staff.reviewer!, plain[0]!.item));
    out.claim = await measure((n) => claimReview(admin(), staff.reviewer!, forClaim[n]!.item));
    out.approve = await measure((n) => approveAccount(admin(), staff.reviewer!, plain[n]!.item));
    out.approveFirstTime = await measure((n) => approveAccount(admin(), staff.reviewer!, firstTime[n]!.item));
    out.approveDomain = await measure((n) => approveAccount(admin(), staff.reviewer!, withDomain[n]!.item, { addDomain: true }));
    console.log("account review (statements, median ms):", JSON.stringify(out));
    expect(out.list![0]).toBeLessThanOrEqual(BUDGET.list);
    expect(out.item![0]).toBeLessThanOrEqual(BUDGET.item);
    expect(out.claim![0]).toBeLessThanOrEqual(BUDGET.claim);
    expect(out.approve![0]).toBeLessThanOrEqual(BUDGET.approve);
    expect(out.approveFirstTime![0]).toBeLessThanOrEqual(BUDGET.approveFirstTime);
    expect(out.approveDomain![0]).toBeLessThanOrEqual(BUDGET.approveDomain);
    for (const [k, v] of Object.entries(out)) expect(v[1], `${k} median ${v[1]} ms`).toBeLessThanOrEqual(BUDGET.ms);
  });
  it("route level: the same plus requireStaff's 2 statements, median time of 9", async () => {
    const made: Awaited<ReturnType<typeof claimed>>[] = [];
    for (let n = 0; n < 9; n++) made.push(await claimed());
    await get("reviewer"); // warm
    const median = (xs: number[]) => xs.sort((x, y) => x - y)[4]!;
    const lists: number[] = [], approves: number[] = [];
    let listSent = 0, approveSent = 0;
    for (let n = 0; n < 9; n++) {
      const l = await counted(() => call("GET", "reviewer"));
      expect(l[0].status).toBe(200);
      if (n === 0) listSent = l[1];
      lists.push(l[2]);
      await post("reviewer", { action: "claim", itemId: made[n]!.item });
      const p = await counted(() => call("POST", "reviewer", { body: { action: "approve", itemId: made[n]!.item, addDomain: true } }));
      expect(p[0].status).toBe(200);
      if (n === 0) approveSent = p[1];
      approves.push(p[2]);
    }
    console.log("account review route (statements, median ms):", JSON.stringify({ list: [listSent, median(lists)], approve: [approveSent, median(approves)] }));
    expect(listSent, `list sent ${listSent}`).toBeLessThanOrEqual(BUDGET.list + BUDGET.routeExtra);
    expect(approveSent, `approve sent ${approveSent}`).toBeLessThanOrEqual(BUDGET.approveDomain + BUDGET.routeExtra);
    expect(median(lists)).toBeLessThanOrEqual(BUDGET.routeMs);
    expect(median(approves)).toBeLessThanOrEqual(BUDGET.routeMs);
  });
});

// ===== N4: the owner is told of each decision, in the decision's own statement =====
describe("decision notices (N4)", () => {
  const notices = async (user: string) => (await su.query("select category, template_key, params from notification where portal_user_id = $1 order by id", [user])).rows;
  const emails = async (user: string) => (await su.query("select template, params, status from email_outbox where portal_user_id = $1 order by id", [user])).rows;
  it("approve, ask for more (with the question, through the route) and reject each write exactly one notice and one pending email to the owner", async () => {
    const a = await registered();
    await claimedBy("reviewer", a.item);
    await approveAccount(admin(), staff.reviewer!, a.item);
    const ap = { organisationId: a.org };
    expect(await notices(a.user)).toEqual([{ category: "account", template_key: "account_approved", params: ap }]);
    expect(await emails(a.user)).toEqual([{ template: "account_approved", params: ap, status: "pending" }]);

    const m = await claimed();
    await claimedBy("reviewer", m.item);
    const question = "Please send a letter from the CRO showing you are a director.";
    expect((await post("reviewer", { action: "ask_more", itemId: m.item, reason: "need_cro_proof", question })).status).toBe(200);
    const mp = { organisationId: String(m.org), reason: "need_cro_proof", question };
    expect(await notices(m.user)).toEqual([{ category: "account", template_key: "account_needs_info", params: mp }]);
    expect(await emails(m.user)).toEqual([{ template: "account_needs_info", params: mp, status: "pending" }]);
    expect(JSON.stringify(await audits(m.org))).not.toContain("CRO showing"); // the question is never in the audit log (#182)
    expect((await post("reviewer", { action: "ask_more", itemId: m.item, question: "a‮b" })).json).toEqual({ error: "bad_question" });
    // asked again later: a second notice, not a duplicate-key failure
    await claimedBy("reviewer", m.item);
    await askForMoreInfo(admin(), staff.reviewer!, m.item, "still_need_proof");
    expect((await notices(m.user)).map((n) => n.params.reason)).toEqual(["need_cro_proof", "still_need_proof"]);

    for (const [x, status] of [[await claimed(), "unclaimed"], [await registered(), "rejected"]] as const) {
      await claimedBy("reviewer", x.item);
      expect((await rejectAccount(admin(), staff.reviewer!, x.item, "fake_company")).organisationStatus).toBe(status);
      const rp = { organisationId: String(x.org), reason: "fake_company" }; // the reason code only: no staff note, no free text
      expect(await notices(x.user)).toEqual([{ category: "account", template_key: "account_rejected", params: rp }]);
      expect(await emails(x.user)).toEqual([{ template: "account_rejected", params: rp, status: "pending" }]);
    }
  });
  it("a refused decision writes neither; a failure in the statement rolls back the decision, the audit row, the notice and the email together", async () => {
    const a = await claimed();
    await claimedBy("reviewer", a.item);
    expect(await refusal(approveAccount(admin(), staff.reviewer2!, a.item))).toBe("not_claimer");
    expect(await notices(a.user)).toEqual([]);
    await su.query("create function public.n4_boom() returns trigger language plpgsql as $$ begin if new.params->>'reason' = 'boom_test' then raise exception 'boom'; end if; return new; end $$");
    await su.query("create trigger n4_boom after insert on email_outbox for each row execute function public.n4_boom()");
    try {
      expect(await refusal(rejectAccount(admin(), staff.reviewer!, a.item, "boom_test"))).toMatch(/boom/);
    } finally {
      await su.query("drop trigger n4_boom on email_outbox");
      await su.query("drop function public.n4_boom()");
    }
    expect(await orgRow(a.org)).toMatchObject({ status: "pending_review" });
    expect(await itemRow(a.item)).toMatchObject({ status: "claimed", outcome: null });
    expect(await audits(a.org)).toEqual([]);
    expect(await notices(a.user)).toEqual([]);
    expect(await emails(a.user)).toEqual([]);
  });
  it("the fake sender sends the queued email to the owner's address (its own draft wording, E1); nothing reaches Brevo", async () => {
    const { sendPending } = await import("../src/outbox-cli.ts");
    const a = await registered();
    await claimedBy("reviewer", a.item);
    await approveAccount(admin(), staff.reviewer!, a.item);
    const email = (await su.query("select email from portal_user where id = $1", [a.user])).rows[0].email as string;
    const sent: { to: string; subject: string; text: string }[] = [];
    await sendPending(admin(), async (to, subject, text) => void sent.push({ to, subject, text }), 200);
    expect(sent.filter((s) => s.to === email)).toEqual([{ to: email, subject: "Your company account is approved", text: expect.stringContaining("approved it") }]);
    expect(sent.find((s) => s.to === email)!.text).not.toContain("account_approved");
    expect(await emails(a.user)).toMatchObject([{ template: "account_approved", status: "sent" }]);
  });
});

// ===== P10: lookalike domain and shared mailbox, extra review reasons only =====
describe("review flags (P10)", () => {
  // a stem no other test's domain is near (theirs are like co-12-xyz.example.test)
  const stem = `zephyrquill${Date.now().toString(36).replace(/[01]/g, "x")}`;
  let saved: number;
  const flagsOf = async (item: string) => { const i = (await getAccountReview(admin(), staff.reviewer!, item))!; return { flags: i.flags, lookalikeOf: i.lookalikeOf }; };
  beforeAll(async () => {
    saved = await F.org({ name: "Real Zephyr Ltd" });
    await su.query("insert into organisation_domain(organisation_id, domain, source) values ($1, $2, 'seed'), ($1, $3, 'seed')", [saved, `${stem}.ie`, "goodlogo-p10.ie"]);
  });
  it("one or two edits from a saved domain, or a 0/o 1/l swap, is lookalike_domain naming the saved domain; three edits, an unrelated or a saved domain is not", async () => {
    const cases: [string, string | null][] = [
      [`${stem.slice(0, -1)}.ie`, `${stem}.ie`], // one letter dropped
      [`${stem}x.ie`, `${stem}.ie`], // one added
      [`${stem.slice(0, 3)}yy${stem.slice(5)}.ie`, `${stem}.ie`], // two changed
      ["g00d1ogo-p10.ie", "goodlogo-p10.ie"], // three digit swaps, zero edits after them
      [`${stem}xyz.ie`, null], // three edits
      ["completely-other-p10.ie", null],
    ];
    for (const [domain, near] of cases) {
      const c = await claimed({ domain });
      expect(c.status, domain).toBe("pending_review"); // a reason to look, never a refusal
      expect(await flagsOf(c.item), domain).toEqual({ flags: near ? ["lookalike_domain"] : [], lookalikeOf: near });
    }
    // the saved domain itself, claimed for ANOTHER company: still review (the existing rule), but not a lookalike
    const own = await claimed({ domain: `${stem}.ie` });
    expect(await flagsOf(own.item)).toEqual({ flags: [], lookalikeOf: null });
  });
  it("a shared mailbox (hr@, jobs@, careers@, info@, admin@, recruitment@, office@) is shared_mailbox; both flags together; a new registration too", async () => {
    for (const box of ["hr", "Jobs", "careers", "info", "admin", "recruitment", "office"]) {
      const org = await F.org({ status: "unclaimed" });
      const user = await F.portal({ email: `${box}@${id("box")}.example.test` });
      await portal().query("select private.claim_organisation($1, $2)", [user, org]);
      const item = (await su.query("select id::text from review_item where queue = 'account_review' and organisation_id = $1", [org])).rows[0].id;
      expect((await flagsOf(item)).flags, box).toEqual(["shared_mailbox"]);
    }
    const user = await F.portal({ email: `hr@${stem.slice(0, -1)}.ie` });
    const r = (await portal().query("select private.register_organisation($1, 'employer', 'Hr Lookalike Ltd', $2, null) r", [user, id("cro")])).rows[0].r;
    const item = (await su.query("select id::text from review_item where queue = 'account_review' and organisation_id = $1", [r.organisation_id])).rows[0].id;
    expect(await flagsOf(item)).toEqual({ flags: ["shared_mailbox", "lookalike_domain"], lookalikeOf: `${stem}.ie` });
    expect((await flagsOf((await claimed()).item)).flags).toEqual([]); // a person's own mailbox on an unsaved domain
  });
  it("the list and the real route carry the flags; a flagged claim can still be approved", async () => {
    const c = await claimed({ domain: `${stem}q.ie` });
    const page = await listAccountReviews(admin(), staff.reviewer!);
    const all = [...page.items];
    for (let next = page.next; next; ) { const p = await listAccountReviews(admin(), staff.reviewer!, { after: next }); all.push(...p.items); next = p.next; }
    expect(all.find((i) => i.id === c.item)).toMatchObject({ flags: ["lookalike_domain"], lookalikeOf: `${stem}.ie` });
    expect((await get("reviewer", `?id=${c.item}`)).json.item).toMatchObject({ flags: ["lookalike_domain"], lookalikeOf: `${stem}.ie` });
    for (const who of [null, "adminonly", "fetchedonly", "norole"]) expect((await get(who, `?id=${c.item}`)).status, String(who)).toBeGreaterThanOrEqual(401);
    await claimedBy("reviewer", c.item);
    expect((await approveAccount(admin(), staff.reviewer!, c.item)).organisationStatus).toBe("verified");
  });
  it("hostile emails: a domain over 255 bytes, odd characters and no @ do not break the list (no levenshtein error) and are not flagged", async () => {
    const odd = [`jane@${"a".repeat(300)}.ie`, "jane@", "no-at-sign", "jane@xn--zphyr-9ra.ie", "jane@%'; drop table job;--.ie"];
    const items: string[] = [];
    for (const email of odd) {
      const org = await F.org({ status: "unclaimed" });
      const user = await F.portal({ email });
      await portal().query("select private.claim_organisation($1, $2)", [user, org]);
      items.push((await su.query("select id::text from review_item where queue = 'account_review' and organisation_id = $1", [org])).rows[0].id);
    }
    for (const [n, item] of items.entries()) expect(await flagsOf(item), odd[n]!.slice(0, 30)).toEqual({ flags: [], lookalikeOf: null });
    expect((await get("reviewer")).status).toBe(200);
  });
  it("performance: the list stays 2 statements, and its page read stays in budget with 3,000 saved domains", async () => {
    await su.query("insert into organisation_domain(organisation_id, domain, source) select $1, 'perf-' || substr(md5(g::text), 1, 2 + g % 25) || '.ie', 'seed' from generate_series(1, 3000) g on conflict do nothing", [saved]);
    await su.query("analyze organisation_domain");
    const [, n, ms] = await counted(() => listAccountReviews(admin(), staff.reviewer!));
    const client = await admin().connect();
    try {
      const costs = await measurePages(client, [REVIEW_FIRST]);
      console.log(`account review list with flags: ${n} statements, ${ms.toFixed(1)} ms, ${costs[0]!.pages} pages ${costs[0]!.ms} ms`);
      expect(n).toBe(BUDGET.list);
      assertPageBudget("account review list with the lookalike read", costs, BUDGET.listPages);
      expect(costs[0]!.ms).toBeLessThanOrEqual(BUDGET.listFlagMs);
    } finally { client.release(); }
  });
});
