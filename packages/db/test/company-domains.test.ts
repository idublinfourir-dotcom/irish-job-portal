// Integration: a company's email domains (Q13, #186) through the real /api/companies/domains handlers with real staff sessions, and the real domain seed
// command, main(argv, env, log), on the real test database as app_admin. Then the claim effect (a seeded domain verifies a claim with no review), the ban
// guard (#137 a), every role, hostile input, and the statement and time budgets. Fake companies and people only. No network.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/domain-seed-cli";
import { mail, makeAuth, portalAnswers, answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, rule, tx, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Measured on 18 November 2026, three runs (three other test runs on the machine at the time), statements counted on every pg.Client.query call through the
// route (requireStaff is 2 of each): list = 2 + role check + list (4); add = 2 + begin, role check, lock company, domain lock, other owner, insert with audit,
// commit (9); remove = 2 + begin, role check, lock company, case check, delete with audit, commit (8); a 100-row seed with --apply = begin, companies, locks,
// existing, insert with audit, commit (6, whatever the size). Medians of 9 warm calls: list 2.2 to 3.6 ms, add 3.2 to 5.9, remove 3.2 to 4.9; the 100-row
// seed 16 to 20 ms (one load each run). Time limits are about 4 times the slowest. Never raise one to make a test pass.
const BUDGET = { list: 4, add: 9, remove: 8, seed: 6, listMs: 15, addMs: 24, removeMs: 20, seedMs: 80 };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, route: Route, su: pg.Pool;
let id: (p: string) => string;
let F: { org(o?: object): Promise<number>; portal(o?: { email?: string }): Promise<string>; staff(): Promise<string> };
const P = "/api/companies/domains";
const HEAD_SEED = "display_name\tdomain\tevidence_url\tevidence_quote";
const list = (who: string | null, org: unknown, o = {}) => h.call(route, P, who, undefined, { query: `?organisationId=${org}`, ...o });
const post = (who: string | null, action: string, org: unknown, domain: unknown, o = {}, reason: unknown = "company_website") =>
  h.call(route, P, who, { action, organisationId: String(org), domain, reason }, o);
const add = (who: string | null, org: unknown, domain: unknown, o = {}) => post(who, "add", org, domain, o);
const remove = (who: string | null, org: unknown, domain: unknown, o = {}) => post(who, "remove", org, domain, o);
const domainsOf = async (org: unknown) => (await su.query("select domain, source, added_by_staff_id from organisation_domain where organisation_id = $1 order by domain", [org])).rows;
const audits = async (org: unknown) =>
  (await su.query("select action, actor_staff_user_id, actor_system, before, after, reason_code, source from audit_event where object_type = 'organisation' and object_id = $1 and action like 'organisation_domain.%' order by id", [String(org)])).rows;
const dom = () => `${id("co")}.example.test`;

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  ({ id, F } = fixtures(db) as unknown as { id: typeof id; F: typeof F });
  route = await import("../../../apps/admin/app/api/companies/domains/route");
  for (const r of ROLE_NAMES) await h.makeStaff(`only_${r}`, [r]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["account_reviewer", "administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]); // after sign-in: the open session is refused too
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("the route", () => {
  it("an account reviewer adds, lists and removes a domain; each write is audited", async () => {
    const org = await F.org({ status: "unclaimed" });
    const d = dom();
    expect(await h.ok(add("only_account_reviewer", org, d))).toEqual({ ok: true, domain: d });
    expect(await domainsOf(org)).toEqual([{ domain: d, source: "admin", added_by_staff_id: h.staff.only_account_reviewer }]);
    const l = await h.ok(list("only_administrator", org));
    expect(l.domains).toEqual([{ id: expect.any(String), domain: d, source: "admin", addedBy: h.staff.only_account_reviewer, createdAt: expect.any(String) }]);
    await h.no(add("only_administrator", org, d), 409, "already_added");
    expect(await h.ok(remove("only_administrator", org, d))).toEqual({ ok: true, domain: d });
    expect(await domainsOf(org)).toEqual([]);
    await h.no(remove("only_administrator", org, d), 404, "domain_not_found");
    expect((await h.ok(list("only_account_reviewer", org))).domains).toEqual([]);
    const a = await audits(org);
    expect(a).toEqual([
      { action: "organisation_domain.add", actor_staff_user_id: h.staff.only_account_reviewer, actor_system: null, before: null, after: { domain: d, source: "admin" }, reason_code: "company_website", source: "panel" },
      { action: "organisation_domain.remove", actor_staff_user_id: h.staff.only_administrator, actor_system: null, before: { domain: d, source: "admin", created_at: expect.any(String) }, after: null, reason_code: "company_website", source: "panel" },
    ]);
    await h.no(list("only_account_reviewer", 999999999), 404, "not_found");
    await h.no(add("only_account_reviewer", 999999999, dom()), 404, "not_found");
  });

  it("refuses a domain another company has, and names that company", async () => {
    const a = await F.org({ name: "Fake Holder Ltd" }), b = await F.org();
    const d = dom();
    await h.ok(add("only_account_reviewer", a, d));
    const r = await add("only_administrator", b, d);
    expect([r.status, r.json]).toEqual([409, { error: "domain_owned_by_other", owner: { organisationId: String(a), displayName: "Fake Holder Ltd" } }]);
    expect(await domainsOf(b)).toEqual([]);
  });

  it("refuses a free email provider, a merged-away company and every malformed or hostile domain", async () => {
    const org = await F.org();
    await h.no(add("only_account_reviewer", org, "gmail.com"), 409, "free_email_domain");
    const gone = await F.org({ status: "unclaimed" });
    await su.query("update organisation set merged_into_id = $2 where id = $1", [gone, org]);
    await h.no(add("only_account_reviewer", gone, dom()), 409, "company_merged");
    for (const d of ["<script>alert(1)</script>.ie", "https://fake.ie", "fake.ie/jobs", "fake.ie:443", "FAKE.ie", "127.0.0.1", "ie", "xn--fke-qla.ie", "аpple.com",
      "fаke.ie", "fake​.ie", "a".repeat(254), `${"a".repeat(64)}.ie`, 42, null, ["fake.ie"]])
      await h.no(add("only_account_reviewer", org, d), 400, "bad_domain");
    await h.no(remove("only_account_reviewer", org, "a".repeat(254)), 400, "bad_domain");
    expect(await domainsOf(org)).toEqual([]);
    await h.no(post("only_account_reviewer", "add", org, dom(), {}, "Free text reason"), 400, "bad_reason");
    await h.no(h.call(route, P, "only_account_reviewer", { action: "add", organisationId: String(org), domain: dom() }), 400, "bad_reason");
    await h.no(post("only_account_reviewer", "remove", org, dom(), {}, "<b>"), 400, "bad_reason");
    await h.no(post("only_account_reviewer", "add", "01", dom()), 400, "bad_organisation_id");
    await h.no(post("only_account_reviewer", "add", "1; drop table organisation", dom()), 400, "bad_organisation_id");
    await h.no(list("only_account_reviewer", "abc"), 400, "bad_organisation_id");
    await h.no(list("only_account_reviewer", org, { query: `?organisationId=${org}&organisationId=${org}` }), 400, "bad_query");
    await h.no(list("only_account_reviewer", org, { query: `?organisationId=${org}&x=1` }), 400, "bad_query");
    await h.no(post("only_account_reviewer", "rename", org, dom()), 400, "bad_action");
  });

  it("refuses a wrong or missing Origin, a big or odd body and unknown fields", async () => {
    const org = await F.org();
    await h.no(add("only_account_reviewer", org, dom(), { origin: "https://evil.example" }), 403, "bad_origin");
    await h.no(add("only_account_reviewer", org, dom(), { origin: null }), 403, "bad_origin");
    await h.no(add("only_account_reviewer", org, dom(), { length: "100000" }), 400, "bad_body");
    const big = JSON.stringify({ action: "add", organisationId: String(org), domain: dom(), reason: "x", pad: "a".repeat(2000) });
    await h.no(h.call(route, P, "only_account_reviewer", undefined, { raw: big }), 400, "bad_body");
    for (const raw of ["not json", "[]", "null", '"add"', JSON.stringify({ action: "add", organisationId: String(org), domain: dom(), reason: "x", extra: 1 })])
      await h.no(h.call(route, P, "only_account_reviewer", undefined, { raw }), 400, "bad_body");
    expect(await domainsOf(org)).toEqual([]);
  });

  it("only account reviewers and administrators; a disabled login, no login and a portal or candidate login are refused", async () => {
    const org = await F.org();
    for (const r of ROLE_NAMES.filter((x) => x !== "account_reviewer" && x !== "administrator")) {
      await h.no(list(`only_${r}`, org), 403, "not_domain_staff");
      await h.no(add(`only_${r}`, org, dom()), 403, "not_domain_staff");
      await h.no(remove(`only_${r}`, org, dom()), 403, "not_domain_staff");
    }
    await h.no(add("norole", org, dom()), 403, "not_domain_staff");
    await h.no(add("disabled", org, dom()), 401, "not_active");
    await h.no(list("disabled", org), 401, "not_active");
    await h.no(add(null, org, dom()), 401, "no_session");
    await h.no(list(null, org), 401, "no_session");
    // real candidate and portal sessions, also renamed to the staff cookie: no staff session
    await seedSignupTerms(su);
    await seedSignupTerms(su, "portal_signup_terms");
    for (const [pool, role] of [["candidate", "app_candidate"], ["portal", "app_portal"]] as const) {
      const auth = makeAuth(pool, db.pool(role));
      const go = async (path: string, body?: unknown) => {
        const res = await auth.handler(new Request(`http://localhost:3000/api/auth/${pool}/${path}`, {
          method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
          headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-vercel-forwarded-for": `203.0.113.${pool.length}` } }));
        return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      };
      const email = `fake.domains.${pool}@example.test`, password = `Fake-${pool}-password-1`;
      await go("sign-up/email", { email, password, name: "Fake", ...(pool === "candidate" ? answers : portalAnswers) });
      await go(`verify-email?${new URL(mail.filter((m) => m.pool === pool && m.email === email).at(-1)!.url).searchParams}`);
      const cookie = await go("sign-in/email", { email, password });
      expect(cookie, pool).toMatch(new RegExp(`^${pool}\\.session_token=`));
      for (const c of [cookie, cookie.replace(`${pool}.session_token`, "staff.session_token")]) {
        await h.no(add(null, org, dom(), { cookie: c }), 401, "no_session");
        await h.no(list(null, org, { cookie: c }), 401, "no_session");
      }
    }
    expect(await domainsOf(org)).toEqual([]);
  });

  it("the portal and candidate logins cannot write organisation_domain", async () => {
    const org = await F.org();
    for (const role of ["app_portal", "app_candidate"] as const) {
      await rule({ refuse: () => db.query(role, "insert into organisation_domain(organisation_id, domain, source) values ($1, $2, 'admin')", [org, dom()]), expect: "permission denied" });
      await rule({ refuse: () => db.query(role, "delete from organisation_domain where organisation_id = $1", [org]), expect: "permission denied" });
      await rule({ refuse: () => db.query(role, "update organisation_domain set domain = 'x.ie' where organisation_id = $1", [org]), expect: "permission denied" });
    }
  });
});

describe("the ban guard (#137 a)", () => {
  let A = "", B = "";
  beforeAll(async () => {
    A = await F.staff();
    B = await F.staff();
    await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,'trust_and_safety',true),($2,'trust_and_safety',true)", [A, B]);
  });
  const openCase = (org: number) => tx(db.pool("app_admin"), async (c) => {
    await c.query("select set_config('app.staff_user_id', $1, true)", [A]);
    return (await c.query("insert into strike(organisation_id, case_kind, reason_code) values ($1,'instant_ban','fake_company') returning id", [org])).rows[0].id as string;
  });
  const ban = async (strike: string, domain: string) => {
    const req = await tx(db.pool("app_admin"), async (c) => {
      await c.query("select set_config('app.staff_user_id', $1, true)", [A]);
      return (await c.query("insert into approval_request(kind, target_table, target_id) values ('ban','strike',$1) returning id", [strike])).rows[0].id as string;
    });
    await tx(db.pool("app_admin"), async (c) => {
      await c.query("select set_config('app.staff_user_id', $1, true)", [B]);
      await c.query("update approval_request set status = 'confirmed' where id = $1", [req]);
    });
    return tx(db.pool("app_admin"), async (c) => {
      await c.query("select set_config('app.staff_user_id', $1, true)", [A]);
      await c.query("update strike set outcome = 'ban', approval_request_id = $2 where id = $1", [strike, req]);
      await c.query("insert into ban(email_domain, reason_code, strike_id, approval_request_id) values ($1, 'fake_company', $2, $3)", [domain, strike, req]);
    });
  };

  it("a domain the company had before an open case cannot be removed; one added after it can, and its ban is still refused", async () => {
    const org = await F.org();
    const old = dom(), late = dom();
    await su.query("insert into organisation_domain(organisation_id, domain, source, created_at) values ($1, $2, 'seed', now() - interval '3 days')", [org, old]);
    const strike = await openCase(org);
    await h.no(remove("only_account_reviewer", org, old), 409, "open_ban_case");
    await h.ok(add("only_account_reviewer", org, late));
    await rule({ refuse: () => ban(strike, late), expect: "email_domain is not one of the case organisation's domains from before the case opened" });
    await h.ok(remove("only_account_reviewer", org, late));
    await ban(strike, old); // the old one is still there, so the ban takes it
    expect((await su.query("select count(*)::int n from ban where email_domain = $1", [old])).rows[0].n).toBe(1);
    await h.ok(remove("only_administrator", org, old)); // the case is decided: removing no longer changes the ban, whose row stands
    expect((await su.query("select count(*)::int n from ban where email_domain = $1", [old])).rows[0].n).toBe(1);
  });
});

describe("the domain seed command", () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-seed-"));
  const write = (...rows: string[]) => {
    const f = join(dir, `${id("f")}.tsv`);
    writeFileSync(f, [HEAD_SEED, ...rows].join("\n") + "\n");
    return f;
  };
  const ENV = () => ({ DETE_ADMIN_DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable" });
  async function seed(...argv: string[]) {
    const out: string[] = [];
    const code = await main(argv, ENV(), (l) => out.push(l));
    return { code, out };
  }
  const snapshot = async () => (await su.query("select (select json_agg(d order by d.id) from organisation_domain d) as d, (select count(*) from audit_event) as a")).rows[0];
  const row = (name: string, d: string) => `${name}\t${d}\thttps://${d}/contact\tEmail us at jobs@${d}`;

  it("dry run writes nothing; --apply writes once with audit rows; a second run adds nothing; bad lines are refused, not guessed", async () => {
    const name = id("Seedco Ltd"), d = dom(), other = dom(), twin = id("Twin Ltd"), heldBy = id("Holder Ltd");
    const org = await F.org({ name, status: "unclaimed" });
    await F.org({ name: twin }); await F.org({ name: twin });
    const holder = await F.org({ name: heldBy });
    await su.query("insert into organisation_domain(organisation_id, domain, source) values ($1, $2, 'admin')", [holder, other]);
    const f = write(row(name, d), row(name, d), row(id("Nobody Ltd"), dom()), row(twin, dom()), row(name, other), row(name, "gmail.com"), row(name, "Bad.ie"));
    const before = await snapshot();
    const dry = await seed(f);
    expect(dry.code).toBe(0);
    expect(dry.out[0]).toBe("dry run, nothing written: 1 domains would be added, 1 skipped, 5 refused (add --apply to write)");
    expect(dry.out).toContain(`  would add: line 2 (${name} ${d})`);
    expect(dry.out).toContain(`  skipped: line 3 (${name} ${d}): the company has it already`);
    expect(dry.out.find((l) => l.includes("line 4"))).toMatch(/no company has this exact display name/);
    expect(dry.out.find((l) => l.includes("line 5"))).toMatch(/2 companies have this display name/);
    expect(dry.out.find((l) => l.includes("line 6"))).toBe(`  refused: line 6 (${name} ${other}): company ${holder} (${heldBy}) has this domain already`);
    expect(dry.out.find((l) => l.includes("line 7"))).toMatch(/free email provider/);
    expect(dry.out.find((l) => l.includes("line 8"))).toMatch(/not a plain lower-case host name/);
    expect(await snapshot()).toEqual(before);

    const first = await seed(f, "--apply");
    expect(first.out[0]).toBe("1 domains added, 1 skipped, 5 refused");
    expect(await domainsOf(org)).toEqual([{ domain: d, source: "seed", added_by_staff_id: null }]);
    expect(await audits(org)).toEqual([{ action: "organisation_domain.seed", actor_staff_user_id: null, actor_system: "domain_seed", before: null,
      after: { domain: d, source: "seed", evidence_url: `https://${d}/contact` }, reason_code: "seed", source: null }]);
    const after = await snapshot();
    const second = await seed("--apply", f);
    expect(second.out[0]).toBe("0 domains added, 2 skipped, 5 refused");
    expect(await snapshot()).toEqual(after);
  });

  it("a file with a bad header or a short line is refused whole; bad arguments and a missing login are refused", async () => {
    const name = id("Wholeco"), org = await F.org({ name });
    const f = join(dir, "bad.tsv");
    writeFileSync(f, "name\tdomain\n");
    expect((await seed(f, "--apply")).code).toBe(1);
    const short = write(row(name, dom()), `${name}\t${dom()}`);
    const r = await seed(short, "--apply");
    expect([r.code, r.out[0]]).toEqual([1, `${short} is refused, nothing was written:\nline 3: expected 4 columns, found 2`]);
    expect(await domainsOf(org)).toEqual([]);
    for (const argv of [[], [f, f], [f, "--apply", "--apply"], ["--dry"], [f, "--force"]]) expect(await main(argv, ENV(), () => {}), JSON.stringify(argv)).toBe(2);
    expect(await main([f], {}, () => {})).toBe(2);
  });

  it("after a seed, a confirmed login on that domain is verified by claim_organisation; another domain goes to review", async () => {
    const name = id("Claimco"), d = dom();
    const org = await F.org({ name, status: "unclaimed" });
    const other = await F.org({ name: id("Otherco"), status: "unclaimed" });
    await seed(write(row(name, d)), "--apply");
    const claim = (u: string, o: number) => db.query("app_portal", "select private.claim_organisation($1, $2) r", [u, o]);
    const on = await F.portal({ email: `hr@${d}` });
    expect((await claim(on, org)).rows[0].r.status).toBe("verified");
    const off = await F.portal({ email: `hr@${dom()}` });
    expect((await claim(off, other)).rows[0].r.status).toBe("pending_review");
  });
});

describe("budgets", () => {
  it("list, add and remove stay inside their statement and time budgets; a 100-row seed is 6 statements", async () => {
    const org = await F.org();
    const [, nList] = await counted(() => h.ok(list("only_account_reviewer", org)));
    const [, nAdd] = await counted(() => h.ok(add("only_account_reviewer", org, dom())));
    const d = dom();
    await h.ok(add("only_account_reviewer", org, d));
    const [, nRemove] = await counted(() => h.ok(remove("only_account_reviewer", org, d)));
    const ds = Array.from({ length: 9 }, () => dom());
    const listMs = await median(() => h.ok(list("only_account_reviewer", org)));
    const addMs = await median((i) => h.ok(add("only_account_reviewer", org, ds[i])));
    const removeMs = await median((i) => h.ok(remove("only_account_reviewer", org, ds[i])));

    const names = Array.from({ length: 100 }, () => id("Bulk Ltd"));
    await su.query("insert into organisation(slug, display_name, kind) select n, n, 'employer' from unnest($1::text[]) n", [names]);
    const { parseDomainSeed, seedDomains } = await import("../src/domain-seed");
    const rows = parseDomainSeed([HEAD_SEED, ...names.map((n) => `${n}\t${n.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example.test\thttps://x.example.test\tq`)].join("\n")).rows;
    expect(rows).toHaveLength(100);
    const pool = new pg.Pool({ connectionString: urlFor(db.name, "app_admin"), max: 1 });
    try {
      const t = performance.now();
      const [r, nSeed] = await counted(() => seedDomains(pool, rows, { apply: true }));
      const seedMs = performance.now() - t;
      process.stderr.write(`domain budgets ${JSON.stringify({ nList, nAdd, nRemove, nSeed, listMs, addMs, removeMs, seedMs })}\n`);
      expect(r.added).toHaveLength(100);
      expect(nSeed).toBeLessThanOrEqual(BUDGET.seed);
      expect(seedMs).toBeLessThan(BUDGET.seedMs);
    } finally {
      await pool.end();
    }
    expect(nList).toBeLessThanOrEqual(BUDGET.list);
    expect(nAdd).toBeLessThanOrEqual(BUDGET.add);
    expect(nRemove).toBeLessThanOrEqual(BUDGET.remove);
    expect(listMs).toBeLessThan(BUDGET.listMs);
    expect(addMs).toBeLessThan(BUDGET.addMs);
    expect(removeMs).toBeLessThan(BUDGET.removeMs);
  });
});
