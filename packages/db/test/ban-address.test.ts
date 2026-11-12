// Integration: banning one exact email address (migration 0015, #215), on the real test database. Fake people only; no network.
// Real ban rows the real way: two staff with trust_and_safety, a strike case, a ban request proposed by one and confirmed by the other,
// then in ONE transaction the strike moves to outcome 'ban' (this applies the request) and the ban row is inserted, as app_admin.
// Then the sign-up functions (as app_portal) must refuse the banned address, and the report grants must stay on the reporter's own columns.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, rule, tx, type TestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Time budget (performance check): the claim with the new address check, median of 9 calls (as account-review.test.ts does).
// Medians measured on 12 November 2026, three runs on the laptop: 2.3, 3.0 and 2.9 ms. The limit is about 4 times the slowest median (rounded up to 15 ms). Raise only on purpose.
const BUDGET_MS = 15;

let db: TestDb;
let su: pg.Pool;
let id: (p: string) => string;
let F: {
  org: (o?: { status?: string; name?: string; cro?: string | null }) => Promise<number>;
  portal: (o?: { email?: string }) => Promise<string>;
  staff: () => Promise<string>;
  cand: () => Promise<string>;
};
let ins: (pool: string, table: string, obj: Record<string, unknown>, ret?: string) => Promise<unknown>;
let A = "";
let B = "";

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ id, F, ins } = fixtures(db) as unknown as { id: typeof id; F: typeof F; ins: typeof ins });
  A = await F.staff();
  B = await F.staff();
  await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,'trust_and_safety',true),($2,'trust_and_safety',true)", [A, B]);
});
afterAll(async () => {
  await db.drop();
});

const portal = () => db.pool("app_portal");
let croN = 800000 + Math.floor(Math.random() * 90000);

// A company with a strike case open, and the members it had. `joined` is when each member joined, in days from now (negative = before the case opened).
async function caseOrg(members: { email: string; joined: number }[], o: { domain?: string } = {}) {
  const cro = String(++croN);
  const org = await F.org({ cro, status: "verified" });
  const roles = ["account_owner", "recruiter", "recruiter", "recruiter"];
  for (const [i, m] of members.entries()) {
    const user = await F.portal({ email: m.email });
    await su.query(
      "insert into membership(organisation_id, portal_user_id, role, status, joined_at) values ($1,$2,$3,'active', now() + make_interval(days => $4))",
      [org, user, roles[i], m.joined],
    );
  }
  // the domain was the company's before the case opened (#137 a)
  if (o.domain) await su.query("insert into organisation_domain(organisation_id, domain, source, created_at) values ($1,$2,'seed', now() - interval '3 days')", [org, o.domain]);
  return { org, cro };
}

// One strike case on the company (opened now), with its ban request proposed by A and confirmed by B.
async function banCase(org: number) {
  const strike = await tx(db.pool("app_admin"), async (c) => {
    await c.query("select set_config('app.staff_user_id', $1, true)", [A]);
    return (
      await c.query(
        "insert into strike(organisation_id, case_kind, reason_code, stage, appeal_due_at) values ($1,'false_claim','false_sponsorship','decided', now() + interval '6 days') returning id",
        [org],
      )
    ).rows[0].id as string;
  });
  const req = await tx(db.pool("app_admin"), async (c) => {
    await c.query("select set_config('app.staff_user_id', $1, true)", [A]);
    return (await c.query("insert into approval_request(kind, target_table, target_id) values ('ban','strike',$1) returning id", [strike])).rows[0].id as string;
  });
  await tx(db.pool("app_admin"), async (c) => {
    await c.query("select set_config('app.staff_user_id', $1, true)", [B]);
    await c.query("update approval_request set status = 'confirmed' where id = $1", [req]);
  });
  return { strike, req };
}

// The ban applied: strike to outcome 'ban' (applies the request) and the ban row, in one transaction, as app_admin acting as A.
const applyBan = (k: { strike: string; req: string }, cols: { cro_number?: string; email_domain?: string; email_address?: string }) =>
  tx(db.pool("app_admin"), async (c) => {
    await c.query("select set_config('app.staff_user_id', $1, true)", [A]);
    await c.query("update strike set outcome = 'ban', approval_request_id = $2 where id = $1", [k.strike, k.req]);
    const names = Object.keys(cols);
    const r = await c.query(
      `insert into ban(${[...names, "reason_code", "strike_id", "approval_request_id"].join(",")}) values (${[...names.map((_, i) => `$${i + 1}`), "'fake_company'", `$${names.length + 1}`, `$${names.length + 2}`].join(",")}) returning id`,
      [...names.map((n) => (cols as Record<string, string>)[n]), k.strike, k.req],
    );
    return r.rows[0].id as string;
  });

const claim = (user: string, org: number) => portal().query("select private.claim_organisation($1, $2) r", [user, org]);
const register = (user: string, cro: string | null) => portal().query("select private.register_organisation($1, 'employer', 'Fake Ban Test Ltd', $2, null) r", [user, cro]);
const userByEmail = async (email: string) => (await su.query("select id from portal_user where email = $1", [email])).rows[0].id as string;
const fakeGmail = (tag: string) => `${tag}.${id("fake")}@gmail.com`;

describe("ban_matches_case with an exact address", () => {
  it("accepts a ban with only email_address for a member who joined before the case opened", async () => {
    const addr = fakeGmail("early-member");
    const { org } = await caseOrg([{ email: addr, joined: -2 }]);
    const k = await banCase(org);
    const banId = await applyBan(k, { email_address: addr });
    expect((await su.query("select email_address, cro_number, email_domain from ban where id = $1", [banId])).rows[0]).toEqual({ email_address: addr, cro_number: null, email_domain: null });
  });

  it("refuses an address whose owner joined after the case opened, a stranger's address and a mixed-case spelling", async () => {
    const late = fakeGmail("late-member");
    const early = fakeGmail("Early-Mixed");
    const { org } = await caseOrg([{ email: early, joined: -2 }, { email: late, joined: 1 }]);
    const k = await banCase(org);
    const notMember = "email_address is not the email of a member";
    await rule({ refuse: () => applyBan(k, { email_address: late.toLowerCase() }), expect: notMember });
    await rule({ refuse: () => applyBan(k, { email_address: fakeGmail("stranger") }), expect: notMember });
    // the stored spelling is lower case: the mixed-case spelling is refused, the lower-case one is accepted for the same person
    expect(early).not.toBe(early.toLowerCase());
    await rule({ refuse: () => applyBan(k, { email_address: early }), expect: notMember });
    await rule({ ok: () => applyBan(k, { email_address: early.toLowerCase() }) });
  });

  it("refuses an address that belongs to a member of another company", async () => {
    const other = fakeGmail("other-company");
    await caseOrg([{ email: other, joined: -2 }]);
    const { org } = await caseOrg([{ email: fakeGmail("mine"), joined: -2 }]);
    await rule({ refuse: async () => applyBan(await banCase(org), { email_address: other }), expect: "email_address is not the email of a member" });
  });

  it("the unique index refuses a second ban of the same address", async () => {
    const addr = fakeGmail("twice");
    const { org } = await caseOrg([{ email: addr, joined: -2 }]);
    await applyBan(await banCase(org), { email_address: addr });
    await rule({ refuse: async () => applyBan(await banCase(org), { email_address: addr }), expect: "ban_address_unique" });
  });

  it("ban_check still refuses a ban with no CRO number, no domain and no address", async () => {
    const { org } = await caseOrg([{ email: fakeGmail("empty"), joined: -2 }]);
    await rule({ refuse: async () => applyBan(await banCase(org), {}), expect: "ban_check" });
  });
});

describe("a banned address at sign-up", () => {
  // The banned person: a member of a company that was banned, on a free provider. The spelling in the login is mixed case.
  async function bannedPerson() {
    const lower = fakeGmail("banned-person");
    const mixed = lower.replace(/^./, (c) => c.toUpperCase()).replace("gmail.com", "Gmail.com");
    const { org, cro } = await caseOrg([{ email: mixed, joined: -2 }]);
    await applyBan(await banCase(org), { email_address: lower });
    return { lower, mixed, user: await userByEmail(mixed), org, cro };
  }

  it("claim_organisation refuses the exact address, also when the login spells it in another case", async () => {
    const p = await bannedPerson();
    expect(p.mixed).not.toBe(p.lower);
    const target = await F.org({ status: "unclaimed" });
    await rule({ refuse: () => claim(p.user, target), expect: "email address is banned" });
    await su.query("update portal_user set email = $2 where id = $1", [p.user, p.lower]);
    await rule({ refuse: () => claim(p.user, target), expect: "email address is banned" });
    expect((await su.query("select status from organisation where id = $1", [target])).rows[0].status).toBe("unclaimed");
  });

  it("claim_organisation lets another address on the same free provider through (the provider is never banned)", async () => {
    await bannedPerson();
    const other = await F.portal({ email: fakeGmail("someone-else") });
    const target = await F.org({ status: "unclaimed" });
    const r = (await claim(other, target)).rows[0].r;
    expect(r).toMatchObject({ organisation_id: Number(target), status: "pending_review" });
    expect((await su.query("select count(*)::int n from ban where email_domain = 'gmail.com'")).rows[0].n).toBe(0);
  });

  it("register_organisation refuses the banned address and lets another address through", async () => {
    const p = await bannedPerson();
    await rule({ refuse: () => register(p.user, String(++croN)), expect: "email address is banned" });
    expect((await su.query("select count(*)::int n from organisation where display_name = 'Fake Ban Test Ltd'")).rows[0].n).toBe(0);
    const other = await F.portal({ email: fakeGmail("another-founder") });
    expect((await register(other, String(++croN))).rows[0].r).toMatchObject({ status: "pending_review" });
  });
});

describe("the older checks still refuse", () => {
  it("a banned email domain refuses a claim and a registration", async () => {
    const domain = `${id("banned")}.example.test`;
    const { org } = await caseOrg([{ email: `owner@${domain}`, joined: -2 }], { domain });
    await applyBan(await banCase(org), { email_domain: domain });
    const user = await F.portal({ email: `new-person@${domain}` });
    await rule({ refuse: async () => claim(user, await F.org({ status: "unclaimed" })), expect: "email domain is banned" });
    await rule({ refuse: () => register(user, String(++croN)), expect: "email domain is banned" });
  });

  it("a banned CRO number refuses a registration with that number", async () => {
    const { org, cro } = await caseOrg([{ email: `owner@${id("co")}.example.test`, joined: -2 }]);
    await applyBan(await banCase(org), { cro_number: cro });
    const user = await F.portal({ email: `founder@${id("co")}.example.test` });
    await rule({ refuse: () => register(user, cro), expect: "company number is banned" });
  });
});

describe("report grants (0015)", () => {
  let job: unknown;
  beforeAll(async () => {
    const org = await F.org({ status: "verified" });
    const src = await ins("postgres", "job_source", { kind: "portal", board: "portal" });
    job = await ins("postgres", "job", {
      organisation_id: org, source: "employer", job_source_id: src, title: "t", employer_name: "e", sector: "it", permit_type: "critical_skills",
      status: "live", closes_at: new Date(Date.now() + 864e5 * 29), own_page_url: "u", salary_low: 40000, search_vector: "'x':1",
    });
  });

  it("app_candidate inserts a report with only its own columns, and cannot name status or decided_by_staff_user_id", async () => {
    const c = await F.cand();
    const cols = "target_kind, target_job_id, reporter_candidate_user_id, reason, evidence_text, target_snapshot";
    const ok = await db.query("app_candidate", `insert into report(${cols}) values ('job',$1,$2,'other','looks wrong','{"title":"t"}') returning id`, [job, c]);
    expect(ok.rows).toHaveLength(1);
    const other = await F.cand();
    await rule({ refuse: () => db.query("app_candidate", "insert into report(target_kind,target_job_id,reporter_candidate_user_id,reason,status) values ('job',$1,$2,'other','cleared')", [job, other]), expect: "permission denied" });
    await rule({ refuse: () => db.query("app_candidate", "insert into report(target_kind,target_job_id,reporter_candidate_user_id,reason,decided_by_staff_user_id) values ('job',$1,$2,'other',$3)", [job, other, A]), expect: "permission denied" });
  });

  it("app_portal inserts a report with only its own columns, and cannot name status or decided_by_staff_user_id", async () => {
    const p = await F.portal();
    const cols = "target_kind, target_job_id, reporter_portal_user_id, reason, evidence_text, target_snapshot";
    const ok = await db.query("app_portal", `insert into report(${cols}) values ('job',$1,$2,'other','looks wrong','{"title":"t"}') returning id`, [job, p]);
    expect(ok.rows).toHaveLength(1);
    const other = await F.portal();
    await rule({ refuse: () => db.query("app_portal", "insert into report(target_kind,target_job_id,reporter_portal_user_id,reason,status) values ('job',$1,$2,'other','upheld')", [job, other]), expect: "permission denied" });
    await rule({ refuse: () => db.query("app_portal", "insert into report(target_kind,target_job_id,reporter_portal_user_id,reason,decided_by_staff_user_id) values ('job',$1,$2,'other',$3)", [job, other, A]), expect: "permission denied" });
  });
});

describe("time budget", () => {
  it("the claim with the new address check: median of 9 calls under the budget", async () => {
    const times: number[] = [];
    for (let i = 0; i < 9; i++) {
      const user = await F.portal({ email: fakeGmail("timing") });
      const target = await F.org({ status: "unclaimed" });
      const t0 = performance.now();
      await claim(user, target);
      times.push(performance.now() - t0);
    }
    const median = times.sort((a, b) => a - b)[4]!;
    console.log(`claim with address check: median of 9 = ${median.toFixed(1)} ms (budget ${BUDGET_MS} ms)`);
    expect(median).toBeLessThan(BUDGET_MS);
  });
});
