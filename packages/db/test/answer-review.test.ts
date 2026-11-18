// Step 8 slice 8.4 (#197, #203, migration 0016): the employer's answer to "ask for more" and the 24 hour cool-down after a rejected claim, end to end on
// the test database through the real /api/portal/claim and /api/portal/review-answer handlers (real portal sessions, connected as app_portal) and the
// real staff functions (as app_admin). No test calls the real network (the sign-up emails go to the fake sender). Fake people only.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { approveAccount, askForMoreInfo, claimReview, getAccountReview, listAccountReviews, rejectAccount } from "../src/account-review";
import { seedStaff } from "../src/staff-seed-cli";

// Statements counted on every pg.Client.query call, measured on 12 November 2026: an answer 5 (requirePortal 3, rate count 1, the function 1); a claim
// with the new cool-down check 5 (the same). Times, median of 9 calls, measured warm on the laptop (while two other test runs shared it): answer 8.4 ms, claim 7.8 ms alone, 35 to 38 ms when ten test files ran at once on a busy machine. The statement counts are the tight guard; the time limit (80 ms) only catches a change of kind.
// Raise these only on purpose.
const BUDGET = { answer: 5, claim: 5, answerMs: 80, claimMs: 80 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let authPOST: Handler, claimPOST: Handler, answerPOST: Handler;
let authGET: Handler;
let mail: () => { to: string; kind: string; link: string }[];
let F: { org(o?: object): Promise<number>; member(org: number | string, user: string | null, o?: object): Promise<number> };
let reviewer = "";

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST: authPOST, GET: authGET } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ POST: claimPOST } = await import("../../../apps/portal/app/api/portal/claim/route"));
  ({ POST: answerPOST } = await import("../../../apps/portal/app/api/portal/review-answer/route"));
  ({ portalMail: mail } = await import("../../../apps/portal/lib/portal"));
  const c = await su.connect();
  try { reviewer = await seedStaff(c, { email: "rev@example.test", name: "Fake Reviewer", roles: ["account_reviewer"] }, "Fake-reviewer-password-1"); } finally { c.release(); }
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
beforeEach(async () => { await su.query("delete from portal_rate_limit where key like 'answer:%' or key like 'company:%'"); });

const admin = () => db.pool("app_admin");
const portal = () => db.pool("app_portal");
let ipn = 0;
const freshIp = () => `10.8.${Math.floor(ipn / 250)}.${ipn++ % 250}`;
type Reply = { status: number; json: Record<string, any> | null; cookie: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function reply(res: Response): Promise<Reply> {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
const authCall = async (path: string, body: unknown) => reply(await authPOST(new Request(`${BASE}/api/auth/portal/${path}`, {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": freshIp() } })));
async function post(h: Handler, url: string, cookie: string | undefined, body: unknown, o: { origin?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(cookie ? { cookie } : {}) };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  return reply(await h(new Request(`${BASE}${url}`, { method: "POST", body: o.raw ?? JSON.stringify(body), headers })));
}
const answer = (cookie: string | undefined, body: unknown, o = {}) => post(answerPOST, "/api/portal/review-answer", cookie, body, o);
const claim = (cookie: string, org: string) => post(claimPOST, "/api/portal/claim", cookie, { organisationId: org });
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];

let n = 0;
type Login = { email: string; cookie: string; id: string };
// A confirmed, signed-in portal login with a fresh email on an address no company owns (so a claim always goes to review).
async function login(): Promise<Login> {
  const p = { email: `fake.a${++n}@nobody${n}.example.test`, password: `Fake-a${n}-password-1`, name: `Fake A${n}`, ...portalAnswers };
  expect((await authCall("sign-up/email", p)).status).toBe(200);
  await authGET(new Request(mail().filter((m) => m.to === p.email && m.kind === "verify").at(-1)!.link, { headers: { "x-vercel-forwarded-for": freshIp() }, redirect: "manual" }));
  const r = await authCall("sign-in/email", { email: p.email, password: p.password });
  expect(r.status).toBe(200);
  return { email: p.email, cookie: r.cookie, id: (await one("select id from portal_user where email=$1", [p.email])).id };
}
const orgOf = async (org: string) => (await one("select status from organisation where id=$1", [org])).status as string;
const item = async (org: string) => (await one("select id::text, status, detail, outcome from review_item where queue='account_review' and organisation_id=$1 order by id desc limit 1", [org]));
const answerAudits = (org: string) => su.query("select * from audit_event where action='organisation.answer_review' and object_id=$1", [String(org)]).then((r) => r.rows);

// An owner who claimed an existing sponsor through the real route, asked for more by the reviewer: needs_info with its item open.
async function askedCompany() {
  const owner = await login();
  const org = String(await F.org({ status: "unclaimed" }));
  expect((await claim(owner.cookie, org)).json).toMatchObject({ status: "pending_review" });
  const it = (await item(org)).id as string;
  await claimReview(admin(), reviewer, it);
  await askForMoreInfo(admin(), reviewer, it, "need_proof");
  expect(await orgOf(org)).toBe("needs_info");
  return { owner, org, it };
}

describe("the answer, end to end", () => {
  it("is stored with the open item, not in the audit log; the company goes back to pending_review; staff see it in the item and the list; then approve", async () => {
    const { owner, org, it } = await askedCompany();
    const note = "We are Fake Sponsor Ltd, CRO 123456. Our director is Jane Fake; her work email is jane@fakesponsor.example.test.";
    const r = await answer(owner.cookie, { note: `  ${note}  ` });
    expect(r).toMatchObject({ status: 200, json: { organisationId: org, status: "pending_review" } });
    expect(await orgOf(org)).toBe("pending_review");
    const row = await item(org);
    expect(row).toMatchObject({ id: it, status: "open", outcome: "needs_info" });
    expect(row.detail).toMatchObject({ answer: note });
    expect(typeof row.detail.answered_at).toBe("string");
    const a = await answerAudits(org);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: "security", actor_portal_user_id: owner.id, before: { status: "needs_info" }, after: { status: "pending_review" }, reason_text: null });
    expect(JSON.stringify(a[0])).not.toContain("Jane"); // codes only (#182)
    expect(await su.query("select 1 from audit_event where after::text like '%Jane%' or before::text like '%Jane%' or reason_text like '%Jane%'").then((x) => x.rowCount)).toBe(0);

    const shown = await getAccountReview(admin(), reviewer, it);
    expect(shown).toMatchObject({ answer: note, organisationStatus: "pending_review" });
    expect(shown!.answeredAt).toMatch(/^\d{4}-\d\d-\d\d/);
    const listed = (await listAccountReviews(admin(), reviewer)).items.find((i) => i.id === it);
    expect(listed).toMatchObject({ answer: note });

    await claimReview(admin(), reviewer, it);
    await approveAccount(admin(), reviewer, it);
    expect(await orgOf(org)).toBe("verified");
  });
  it("a reviewer can reject after the answer, and a new question clears the old answer", async () => {
    const { owner, org, it } = await askedCompany();
    expect((await answer(owner.cookie, { note: "first answer" })).status).toBe(200);
    await claimReview(admin(), reviewer, it);
    await askForMoreInfo(admin(), reviewer, it, "more_proof");
    expect(await getAccountReview(admin(), reviewer, it)).toMatchObject({ answer: null, answeredAt: null, organisationStatus: "needs_info" });
    expect((await answer(owner.cookie, { note: "second answer" })).status).toBe(200);
    expect(await getAccountReview(admin(), reviewer, it)).toMatchObject({ answer: "second answer" });
    await claimReview(admin(), reviewer, it);
    await rejectAccount(admin(), reviewer, it, "not_convincing");
    expect(await orgOf(org)).toBe("unclaimed");
  });
  it("works while a reviewer already holds the item again, and keeps their claim", async () => {
    const { owner, org, it } = await askedCompany();
    await claimReview(admin(), reviewer, it); // claimed again while the company is needs_info
    expect((await answer(owner.cookie, { note: "answer while claimed" })).status).toBe(200);
    expect(await item(org)).toMatchObject({ status: "claimed" });
    await approveAccount(admin(), reviewer, it);
    expect(await orgOf(org)).toBe("verified");
  });
  it("takes the plain text as it is: quotes, HTML and SQL are stored as text, an emoji and accents are fine, exactly 1,000 characters pass", async () => {
    for (const note of ["Robert'); drop table organisation;--", "<script>alert(1)</script> & <b>bold</b>", "Ó Briain Teoranta, Baile Átha Cliath 😀", "x".repeat(1000), "a b"]) {
      const { owner, org } = await askedCompany();
      expect((await answer(owner.cookie, { note })).status, note.slice(0, 20)).toBe(200);
      expect((await item(org)).detail.answer).toBe(note);
    }
  });
});

describe("refusals", () => {
  it("another state: a company that is not needs_info gets NOT_WAITING_FOR_ANSWER and nothing changes", async () => {
    const owner = await login();
    const org = String(await F.org({ status: "unclaimed" }));
    await claim(owner.cookie, org); // pending_review
    const before = await item(org);
    expect(await answer(owner.cookie, { note: "hello" })).toMatchObject({ status: 409, json: { code: "NOT_WAITING_FOR_ANSWER" } });
    expect(await item(org)).toEqual(before);
    await su.query("update organisation set status = 'verified', verified_at = now() where id = $1", [org]);
    expect((await answer(owner.cookie, { note: "hello" })).json).toMatchObject({ code: "NOT_WAITING_FOR_ANSWER" });
    expect(await answerAudits(org)).toHaveLength(0);
  });
  it("a needs_info company with no open item (it was dropped) is NOT_WAITING too", async () => {
    const { owner, org, it } = await askedCompany();
    await su.query("update review_item set status = 'dropped' where id = $1", [it]);
    expect((await answer(owner.cookie, { note: "hello" })).json).toMatchObject({ code: "NOT_WAITING_FOR_ANSWER" });
    expect(await orgOf(org)).toBe("needs_info");
  });
  it("only the active account owner of that company: members, viewers, removed, invited, another company's owner and a login with no company get nothing", async () => {
    const { org } = await askedCompany();
    const before = await item(org);
    const others: [string, Login][] = [];
    for (const role of ["recruiter", "poster", "viewer"]) {
      const l = await login();
      await F.member(org, l.id, { role });
      others.push([role, l]);
    }
    const removed = await login();
    await F.member(org, removed.id, { role: "account_owner", status: "removed" });
    others.push(["removed", removed]);
    const invited = await login();
    await F.member(org, null, { role: "recruiter", status: "invited", email: invited.email });
    others.push(["invited", invited]);
    others.push(["no company", await login()]);
    const other = await login(); // the owner of another company that is verified
    await F.member(String(await F.org({ status: "verified" })), other.id, { role: "account_owner" });
    others.push(["other company's owner", other]);
    // another company that is also needs_info: its owner may answer only its own
    const o2 = await askedCompany();
    for (const [who, l] of others) {
      const r = await answer(l.cookie, { note: `I am ${who}` });
      expect([r.status, r.json?.code], who).toEqual(who === "other company's owner" ? [409, "NOT_WAITING_FOR_ANSWER"] : [403, "REFUSED"]);
    }
    expect(await item(org)).toEqual(before);
    expect(await orgOf(org)).toBe("needs_info");
    expect(await orgOf(o2.org)).toBe("needs_info");
    // the owner of company 2 answers company 2 only, whatever the body says
    expect((await answer(o2.owner.cookie, { note: "mine", organisationId: org })).status).toBe(400);
    expect((await answer(o2.owner.cookie, { note: "mine" })).status).toBe(200);
    expect(await item(org)).toEqual(before);
  });
  it("a blocked or deleted login, and a login with no session, are refused", async () => {
    const { owner, org } = await askedCompany();
    expect(await answer(undefined, { note: "x" })).toMatchObject({ status: 401, json: { code: "NO_SESSION" } });
    expect(await answer("better-auth.session_token=forged", { note: "x" })).toMatchObject({ status: 401 });
    await su.query("update portal_user set status = 'blocked' where id = $1", [owner.id]);
    expect(await answer(owner.cookie, { note: "x" })).toMatchObject({ status: 403, json: { code: "REFUSED" } });
    await expect(portal().query("select private.answer_review($1, 'x')", [owner.id])).rejects.toThrow(/REFUSED/); // and the function alone
    await su.query("update portal_user set status = 'active', deleted_at = now() where id = $1", [owner.id]);
    await expect(portal().query("select private.answer_review($1, 'x')", [owner.id])).rejects.toThrow(/REFUSED/);
    expect(await orgOf(org)).toBe("needs_info");
  });
  it("hostile requests: wrong or missing Origin, huge body, not JSON, extra fields, odd notes", async () => {
    const { owner, org } = await askedCompany();
    for (const origin of ["http://evil.example.test", "http://localhost:3002", "null", "http://localhost:3001.evil.test", "https://localhost:3001"])
      expect(await answer(owner.cookie, { note: "x" }, { origin }), origin).toMatchObject({ status: 403, json: { code: "BAD_ORIGIN" } });
    expect(await answer(owner.cookie, { note: "x" }, { origin: null })).toMatchObject({ status: 403, json: { code: "BAD_ORIGIN" } });
    expect(await answer(owner.cookie, null, { raw: JSON.stringify({ note: "x".repeat(3000) }) })).toMatchObject({ status: 413 });
    for (const raw of ["", "{", "not json", "[]", "null", '"note"', "42"]) expect((await answer(owner.cookie, null, { raw })).status, raw).toBe(400);
    for (const extra of [{ organisationId: org }, { portalUserId: owner.id }, { status: "verified" }, { portal_user_id: "x" }, JSON.parse('{"__proto__": {"x": 1}}')])
      expect((await answer(owner.cookie, { note: "ok", ...extra })).status, JSON.stringify(extra)).toBe(400);
    const bad: unknown[] = [undefined, null, "", " ", "\n", "x".repeat(1001), "line\nbreak", "tab\there", "nul\u0000l", "bell\u0007", "rtl\u202eoverride", "zero\u200bwidth", "word\u2060joiner",
      "bo\ufeffm", "soft\u00adhyphen", "sep\u2028arator", "iso\u2066late", "del\u007f", 42, true, ["a"], { note: "a" }];
    for (const note of bad) expect(await answer(owner.cookie, { note }), JSON.stringify(note)?.slice(0, 30)).toMatchObject({ status: 400, json: { code: "BAD_REQUEST" } });
    expect(await orgOf(org)).toBe("needs_info");
    expect((await item(org)).detail?.answer ?? null).toBeNull();
  });
  it("the database itself refuses a bad note and a direct write, whatever the route checks", async () => {
    const { owner, org } = await askedCompany();
    for (const note of [null, "", "   ", "x".repeat(1001), "a\nb", "a\u202eb", "a\u200bb", "a\u0085b"])
      await expect(portal().query("select private.answer_review($1, $2)", [owner.id, note]), JSON.stringify(note)?.slice(0, 20)).rejects.toThrow(/BAD_REQUEST/);
    expect(await orgOf(org)).toBe("needs_info");
    // the app role has no grant on the item or the company
    await expect(portal().query("update review_item set detail = '{\"answer\":\"x\"}' where organisation_id = $1", [org])).rejects.toThrow(/permission denied/);
    await expect(portal().query("update organisation set status = 'pending_review' where id = $1", [org])).rejects.toThrow(/permission denied/);
    await expect(portal().query("select detail from review_item")).rejects.toThrow(/permission denied/);
    // other roles cannot run the function
    await expect(db.pool("app_candidate").query("select private.answer_review($1, 'x')", [owner.id])).rejects.toThrow(/permission denied/);
    await expect(db.pool("app_fetcher").query("select private.answer_review($1, 'x')", [owner.id])).rejects.toThrow(/permission denied/);
  });
  it("the sixth answer in 10 minutes is 429", async () => {
    const { owner } = await askedCompany();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await answer(owner.cookie, { note: "again" })).status);
    expect(codes).toEqual([200, 409, 409, 409, 409, 429]);
  });
  it("an answer racing with a reviewer's rejection never leave a half state", async () => {
    const { owner, org, it } = await askedCompany();
    await claimReview(admin(), reviewer, it);
    const [a] = await Promise.allSettled([answer(owner.cookie, { note: "race" }), rejectAccount(admin(), reviewer, it, "no")]);
    expect(a.status).toBe("fulfilled");
    const s = await orgOf(org);
    const row = await item(org);
    // either the answer landed first (then the rejection saw pending_review and closed the item) or the rejection won (the owner then has no company and is refused)
    expect(["unclaimed", "needs_info"]).toContain(s);
    if (s === "unclaimed") expect(row.status).toBe("done");
  });
});

describe("the 24 hour cool-down after a rejected claim (#203)", () => {
  // The same login claims the same company; a reviewer rejects it. Returns what a test needs.
  async function rejected() {
    const owner = await login();
    const org = String(await F.org({ status: "unclaimed" }));
    expect((await claim(owner.cookie, org)).status).toBe(200);
    const it = (await item(org)).id as string;
    await claimReview(admin(), reviewer, it);
    await rejectAccount(admin(), reviewer, it, "not_theirs");
    expect(await orgOf(org)).toBe("unclaimed");
    return { owner, org, it };
  }
  // Moves the rejection back in time: the membership's removal and the item's decision together (they share one instant).
  const ago = (org: string, hours: number) => su.query(
    `with t as (select now() - make_interval(hours => $2) as at),
          m as (update membership set removed_at = (select at from t) where organisation_id = $1 and status = 'removed'),
          r as (update review_item set decided_at = (select at from t) where organisation_id = $1 and outcome = 'rejected') select 1`, [org, hours]);
  it("refuses the same login and company right after, at 23 hours, and allows it at 25 hours", async () => {
    const { owner, org } = await rejected();
    expect(await claim(owner.cookie, org)).toMatchObject({ status: 429, json: { code: "CLAIM_COOL_DOWN" } });
    await su.query("delete from portal_rate_limit");
    await ago(org, 23);
    expect(await claim(owner.cookie, org)).toMatchObject({ status: 429, json: { code: "CLAIM_COOL_DOWN" } });
    expect(await orgOf(org)).toBe("unclaimed");
    await ago(org, 25);
    expect(await claim(owner.cookie, org)).toMatchObject({ status: 200, json: { status: "pending_review" } });
    expect(await orgOf(org)).toBe("pending_review");
  });
  it("does not block another login on the same company, or the same login on another company", async () => {
    const { owner, org } = await rejected();
    const second = await login();
    expect((await claim(second.cookie, org)).status).toBe(200); // another login, straight away
    const elsewhere = String(await F.org({ status: "unclaimed" }));
    await su.query("update organisation set status = 'unclaimed' where id = $1", [org]); // (the second login's claim is undone for the next step)
    expect((await claim(owner.cookie, elsewhere)).status).toBe(200); // the rejected login, another company
    expect(await orgOf(elsewhere)).toBe("pending_review");
  });
  it("is not caused by a claim that lapsed unanswered, or by an approval later undone", async () => {
    const { owner, org, it } = await askedCompany();
    // the 30 day rule: item dropped (needs_info_expired), company back to unclaimed, membership removed
    await su.query("update review_item set status = 'dropped', outcome = 'needs_info_expired', decided_at = now() where id = $1", [it]);
    await su.query("update organisation set status = 'unclaimed' where id = $1", [org]);
    expect((await claim(owner.cookie, org)).status).toBe(200);
  });
  it("keeps the database function's refusal text for the route's code; the function alone refuses too", async () => {
    const { owner, org } = await rejected();
    await expect(portal().query("select private.claim_organisation($1, $2)", [owner.id, org])).rejects.toThrow(/COOL_DOWN/);
  });
});

describe("performance", () => {
  async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
    const q = pg.Client.prototype.query;
    let k = 0;
    pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { k++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
    try { return [await fn(), k]; } finally { pg.Client.prototype.query = q; }
  }
  const median = async (fn: () => Promise<unknown>, before: () => Promise<unknown>) => {
    const ms = [];
    for (let i = 0; i < 9; i++) { await before(); const t = performance.now(); await fn(); ms.push(performance.now() - t); }
    return ms.sort((a, b) => a - b)[4]!;
  };
  it("an answer is 5 statements and under its time budget", async () => {
    const { owner, org, it } = await askedCompany();
    const reset = async () => {
      await su.query("delete from portal_rate_limit");
      await su.query("update organisation set status = 'needs_info' where id = $1", [org]);
      await su.query("update review_item set detail = null, status = 'open' where id = $1", [it]);
    };
    await reset();
    await answer(owner.cookie, { note: "warm" });
    await reset();
    const [r, stmts] = await counted(() => answer(owner.cookie, { note: "measured" }));
    expect(r.status).toBe(200);
    expect(stmts).toBeLessThanOrEqual(BUDGET.answer);
    const ms = await median(() => answer(owner.cookie, { note: "timed" }), reset);
    console.log(`answer: ${stmts} statements, median ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(BUDGET.answerMs);
  });
  it("a claim with the cool-down check is 5 statements and under its time budget, with a rejection on record", async () => {
    const { owner } = await rejected2();
    const fresh = async () => {
      await su.query("delete from portal_rate_limit");
      await su.query("delete from review_item where organisation_id in (select organisation_id from membership where portal_user_id = $1 and status = 'active')", [owner.id]);
      await su.query("delete from membership where portal_user_id = $1 and status = 'active'", [owner.id]);
      target = String(await F.org({ status: "unclaimed" }));
    };
    let target = "";
    await fresh();
    await claim(owner.cookie, target);
    await fresh();
    const [r, stmts] = await counted(() => claim(owner.cookie, target));
    expect(r.status).toBe(200);
    expect(stmts).toBeLessThanOrEqual(BUDGET.claim);
    const ms = await median(() => claim(owner.cookie, target), fresh);
    console.log(`claim: ${stmts} statements, median ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(BUDGET.claimMs);
  });
  async function rejected2() {
    const owner = await login();
    const org = String(await F.org({ status: "unclaimed" }));
    await claim(owner.cookie, org);
    const it = (await item(org)).id as string;
    await claimReview(admin(), reviewer, it);
    await rejectAccount(admin(), reviewer, it, "not_theirs");
    return { owner, org };
  }
});
