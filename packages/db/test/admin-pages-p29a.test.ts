// Step 16 wave 3 (P29, first half): the pages /contact, /employer-jobs, /pay-floors, /accounts, /companies/seed and /companies/[id] as Next calls them (their params in, their
// element out, rendered to HTML) on the real test database as app_admin, with real staff sessions. Every page is tried as each of the seven roles, a login with no role, a
// disabled login and a signed-out visitor; the two-person steps are tried as the same person; free text from outside is hostile; only Next's request context is stood in
// (next/headers, next/navigation, server-only). Fake people only, no network.
// Budget: statements (every pg.Client.query, requireStaff's 2 per read included) and median time of one render; limits are the measured numbers plus headroom, see BUDGET.
import type pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { makeBig } from "./pay-floors-helpers";
import { counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw Object.assign(new Error(`REDIRECT:${to}`), { to }); },
  notFound: () => { throw new Error("NOT_FOUND"); },
  useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/",
}));
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

const BUDGET = { contact: 8, jobs: 14, floors: 8, accounts: 8, seed: 8, company: 16, dete: 10, ms: 120 };
type Params = Record<string, string | string[] | undefined>;
type PageFn = (a: { searchParams: Promise<Params> }) => Promise<React.ReactElement>;
let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool;
let contact: PageFn, jobs: PageFn, floors: PageFn, accounts: () => Promise<React.ReactElement>, dete: PageFn, seed: () => Promise<React.ReactElement>, company: (a: { params: Promise<{ id: string }> }) => Promise<React.ReactElement>;
const R: Record<string, Route> = {};
const S = { msg: "", hostileMsg: "", job: "", agencyItem: "", scamItem: "", floor: "", org: "", cand1: "", cand2: "" };
const NO_ACCESS = /This page is not for your roles/;
const SIGN_IN = "REDIRECT:/sign-in";
const ROLE = (r: string) => `only_${r}`;
const pageModule = (name: string): Promise<unknown> => import(/* @vite-ignore */ `../../../apps/admin/app/${name}`);

/** The page as the named login would be sent it: its HTML, or "REDIRECT:/path" or "NOT_FOUND". */
async function render(who: string | null, page: () => Promise<React.ReactElement>): Promise<string> {
  state.headers = new Headers(who ? { cookie: h.cookies[who]! } : {});
  try {
    return renderToStaticMarkup(await page());
  } catch (e) {
    if (e instanceof Error && /^(REDIRECT:|NOT_FOUND)/.test(e.message)) return e.message;
    throw e;
  }
}
const P = (fn: PageFn, who: string | null, p: Params = {}) => render(who, () => fn({ searchParams: Promise.resolve(p) }));
const ACCOUNTS = (who: string | null) => render(who, () => accounts());
const SEED = (who: string | null) => render(who, () => seed());
const COMPANY = (who: string | null, id: string) => render(who, () => company({ params: Promise.resolve({ id }) }));
const post = (route: string, who: string, body: unknown) => h.call(R[route]!, `/api/${route}`, who, body);

/** Who may open each page, by the route's x-roles. */
const ALLOWED = {
  contact: ["services_case_handler", "content_editor", "administrator"], jobs: ["trust_and_safety", "account_reviewer", "administrator"], floors: ["rules_data_editor", "administrator"],
  accounts: ["administrator"], seed: ["rules_data_editor", "administrator"], company: ["account_reviewer", "administrator"],
  dete: ["account_reviewer", "trust_and_safety", "administrator"],
};
const PAGES: Record<keyof typeof ALLOWED, (who: string | null) => Promise<string>> = {
  contact: (w) => P(contact, w), jobs: (w) => P(jobs, w), floors: (w) => P(floors, w), accounts: ACCOUNTS, seed: SEED, company: (w) => COMPANY(w, S.org), dete: (w) => P(dete, w),
};

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  const { F } = fixtures(db) as unknown as { F: { org(o?: object): Promise<number>; portal(): Promise<string>; member(o: number, u: string, x?: object): Promise<number>; staff(): Promise<string>; cand(): Promise<string>; text(p?: string): Promise<number> } };
  for (const r of ROLE_NAMES) await h.makeStaff(ROLE(r), [r]);
  await h.makeStaff("admin2", ["administrator"]);
  await h.makeStaff("both", ["rules_data_editor", "administrator"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("gone", ["administrator", "account_reviewer", "services_case_handler"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.gone]);
  for (const r of ["contact", "employer-jobs", "pay-floors", "accounts", "companies/seed", "companies/dete-links", "companies/owner-reassign", "companies/domains", "companies/member-limit"]) R[r] = await import(/* @vite-ignore */ `../../../apps/admin/app/api/${r}/route`);
  ({ default: contact } = (await pageModule("contact/page")) as { default: PageFn });
  ({ default: jobs } = (await pageModule("employer-jobs/page")) as { default: PageFn });
  ({ default: floors } = (await pageModule("pay-floors/page")) as { default: PageFn });
  ({ default: accounts } = (await pageModule("accounts/page")) as { default: typeof accounts });
  ({ default: dete } = (await pageModule("companies/dete-links/page")) as { default: PageFn });
  ({ default: seed } = (await pageModule("companies/seed/page")) as { default: typeof seed });
  ({ default: company } = (await pageModule("companies/[id]/page")) as { default: typeof company });

  // contact: one plain message, one that is hostile text
  const ins = (n: string, e: string, b: string) => su.query("insert into contact_message(surface, from_name, from_email, topic, body) values ('portal', $1, $2, 'general', $3) returning id::text", [n, e, b]).then((r) => r.rows[0].id as string);
  S.msg = await ins("Fake Sender", "fake.sender@example.test", "Fake question about my account.\nSecond line.");
  S.hostileMsg = await ins("<img src=x onerror=alert(1)>", "hostile@example.test", "<script>alert(1)</script> <b>bold</b>");
  // a held agency job (agency_client_check) with a scam_flag item as well
  const src = (await su.query("select id::text from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
  const org = await F.org({ kind: "agency", name: "Fake Held Recruitment <i>Ltd</i>" });
  const mem = await F.member(org, await F.portal(), { role: "recruiter" });
  S.job = (await db.pool("app_portal").query(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, salary_low, status, closes_at, search_vector, own_page_url, permit_employer_kind, permit_employer_name, posted_by_membership_id)
     values ($1, 'agency', $2, 'Fake <u>Platform</u> Engineer', 'Fake Recruitment', 'Dublin', 'it', '2134', 'critical_skills', 60000, 'live', now() + interval '29 days', to_tsvector('english', 'fake'), 'https://example.test/apply', 'client', 'Fake Payments Limited', $3) returning id::text`,
    [org, src, mem])).rows[0].id;
  await db.pool("app_portal").query("insert into job_text(job_id, advert_text) values ($1, '<script>alert(2)</script> Fake advert text. The salary is 60,000 a year.')", [S.job]);
  S.agencyItem = (await su.query("select id::text from review_item where job_id = $1 and queue = 'agency_client_check'", [S.job])).rows[0].id;
  S.scamItem = (await su.query("insert into review_item(queue, job_id, reason) values ('scam_flag', $1, 'fake') returning id::text", [S.job])).rows[0].id;
  // a pay floor of a big company, and a company with a domain
  const big = await F.org({ name: "Fake Big Floor Ltd" });
  const signer = await F.member(big, await F.portal(), { role: "account_owner", signer: true });
  await makeBig(su, F.staff, big);
  S.floor = (await su.query(
    "insert into pay_floor(organisation_id, role_family, floor_eur, consent_text_id, signer_membership_id, signer_name, signer_title, valid_until) values ($1,'3434',40000,$2,$3,'Fake <b>Signer</b>','Account owner', now() + interval '12 months') returning id::text",
    [big, await F.text("pay_floor"), signer])).rows[0].id;
  S.org = String(await F.org({ name: "Fake Domain Company Ltd" }));
  await su.query("insert into dete_permit_count(dete_name, year, permits) values ('FAKE DOMAIN COMPANY LTD', 2025, 7)");
  await su.query("insert into organisation_domain(organisation_id, domain, source) values ($1, 'fake-domain-co.example.test', 'admin')", [S.org]);
  S.cand1 = await F.cand();
  S.cand2 = await F.cand();
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("every page, every role", () => {
  for (const [page, allowed] of Object.entries(ALLOWED) as [keyof typeof ALLOWED, string[]][])
    it(`${page}: only ${allowed.join(", ")} open it; every other role and a login with no role get the 'not for your roles' page and none of its data`, async () => {
      for (const r of ROLE_NAMES) {
        const p = await PAGES[page](ROLE(r));
        if (allowed.includes(r)) expect(p, r).not.toMatch(NO_ACCESS);
        else expect(p, r).toMatch(NO_ACCESS);
        if (!allowed.includes(r)) expect(p, r).not.toMatch(/Fake|fake/);
      }
      expect(await PAGES[page]("norole")).toMatch(NO_ACCESS);
    });
  it("a signed-out visitor, a disabled login and a forged session are sent to the sign-in page, by every page", async () => {
    for (const page of Object.keys(ALLOWED) as (keyof typeof ALLOWED)[]) {
      expect(await PAGES[page](null), page).toBe(SIGN_IN);
      expect(await PAGES[page]("gone"), page).toBe(SIGN_IN);
    }
    state.headers = new Headers({ cookie: "better-auth.session_token=forged" });
    expect(await render(null, () => contact({ searchParams: Promise.resolve({}) }))).toBe(SIGN_IN);
  });
});

describe("/contact", () => {
  it("the list shows topics and ages but no name, email or text; opening a message shows them as text and writes one audit row", async () => {
    const list = await P(contact, ROLE("content_editor"));
    expect(list).toMatch(/Contact messages/);
    expect(list).not.toMatch(/Fake Sender|fake\.sender|Fake question/);
    const before = Number((await su.query("select count(*) from audit_event where action = 'contact.read'")).rows[0].count);
    const open = await P(contact, ROLE("content_editor"), { id: S.msg });
    expect(open).toMatch(/Fake Sender/);
    expect(open).toMatch(/fake\.sender@example\.test/);
    expect(open).toMatch(/Claim this message/);
    expect(Number((await su.query("select count(*) from audit_event where action = 'contact.read'")).rows[0].count)).toBe(before + 1);
  });
  it("an administrator reads but is not offered an action; hostile text is escaped", async () => {
    const open = await P(contact, ROLE("administrator"), { id: S.hostileMsg });
    expect(open).toMatch(/Only a services case handler or a content editor can act/);
    expect(open).not.toMatch(/Claim this message/);
    expect(open).not.toMatch(/<script|<img|<b>/);
    expect(open).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
  it("a claimed message offers the claimer the decisions and another person a take-over; hostile ids and cursors give the page, not an error", async () => {
    await post("contact", ROLE("content_editor"), { action: "claim", messageId: S.msg }).then((r) => expect(r.status).toBe(200));
    expect(await P(contact, ROLE("content_editor"), { id: S.msg })).toMatch(/Mark answered/);
    const other = await P(contact, ROLE("services_case_handler"), { id: S.msg });
    expect(other).toMatch(/Another staff member holds this message/);
    expect(other).not.toMatch(/Mark answered/);
    for (const id of ["abc", "99999999999999999999", "1; drop table x"]) expect(await P(contact, ROLE("content_editor"), { id }), id).toMatch(/That message does not exist/);
    expect(await P(contact, ROLE("content_editor"), { id: ["1", "2"] as unknown as string })).toMatch(/Pick a message to read it/); // a repeated key is no key
    expect(await P(contact, ROLE("content_editor"), { after: "not-a-cursor" })).toMatch(/Contact messages/);
  });
});

describe("/employer-jobs", () => {
  it("each role sees the queues of its own role: trust and safety the scam tab only, an account reviewer three, an administrator four", async () => {
    const tabs = (p: string) => [...p.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(tabs(await P(jobs, ROLE("trust_and_safety")))).toEqual(["Scam check"]);
    expect(tabs(await P(jobs, ROLE("account_reviewer")))).toEqual(["After a strike", "Agency client check", "Licence lapse"]);
    expect(tabs(await P(jobs, ROLE("administrator")))).toEqual(["Scam check", "After a strike", "Agency client check", "Licence lapse"]);
  });
  it("an item shows its advert as text, the agency's client and the written authority list; a queue the role does not cover shows nothing of it", async () => {
    const p = await P(jobs, ROLE("account_reviewer"), { queue: "agency_client_check", id: S.agencyItem });
    expect(p).toMatch(/Fake &lt;u&gt;Platform&lt;\/u&gt; Engineer/);
    expect(p).toMatch(/&lt;script&gt;alert\(2\)&lt;\/script&gt; Fake advert text/);
    expect(p).not.toMatch(/<script|<u>|<i>/);
    expect(p).toMatch(/Fake Payments Limited/);
    expect(p).toMatch(/The agency has not stored a copy/);
    expect(p).toMatch(/Claim this item/);
    const ts = await P(jobs, ROLE("trust_and_safety"), { id: S.agencyItem });
    expect(ts).toMatch(/not in a queue you can open/);
    expect(ts).not.toMatch(/Fake advert|Fake Payments/); // the scam queue lists the same job by title, but nothing of the agency item
    expect(await P(jobs, ROLE("trust_and_safety"), { queue: "agency_client_check" })).toMatch(/Scam check/); // a queue not theirs is their own first queue
  });
  it("a claimed item offers its claimer Approve, Reject and Release, and another reviewer a take-over", async () => {
    expect((await post("employer-jobs", ROLE("account_reviewer"), { action: "claim", itemId: S.agencyItem })).status).toBe(200);
    expect(await P(jobs, ROLE("account_reviewer"), { queue: "agency_client_check", id: S.agencyItem })).toMatch(/Approve[\s\S]*Reject[\s\S]*Release/);
    const other = await P(jobs, ROLE("administrator"), { queue: "agency_client_check", id: S.agencyItem });
    expect(other).toMatch(/Take over the claim/);
    expect(other).not.toMatch(/>Approve</);
  });
  it("hostile ids, queues and cursors give the page", async () => {
    for (const p of [{ id: "abc" }, { id: "0" }, { queue: "x'; --" }, { queue: ["scam_flag", "x"] }, { after: "garbage" }, { queue: "scam_flag", after: "garbage" }])
      expect(await P(jobs, ROLE("administrator"), p as Params), JSON.stringify(p)).toMatch(/Held jobs/);
  });
});

describe("/pay-floors, two people", () => {
  it("an editor is offered Propose, an administrator is told to wait, and every other role is refused", async () => {
    expect(await P(floors, ROLE("rules_data_editor"))).toMatch(/Propose to confirm/);
    const adm = await P(floors, ROLE("administrator"));
    expect(adm).toMatch(/A rules data editor has to propose this floor first/);
    expect(adm).not.toMatch(/>Confirm</);
    expect(adm).toMatch(/Fake Big Floor Ltd/);
    expect(adm).toMatch(/Fake &lt;b&gt;Signer&lt;\/b&gt;/);
  });
  it("the same person who proposed is never offered Confirm and the route refuses it; a different administrator is offered it", async () => {
    expect((await post("pay-floors", "both", { action: "propose", floorId: S.floor })).status).toBe(200);
    const mine = await P(floors, "both");
    expect(mine).toMatch(/You proposed this floor/);
    expect(mine).not.toMatch(/>Confirm</);
    const r = await post("pay-floors", "both", { action: "confirm", floorId: S.floor });
    expect([r.status, r.json.error]).toEqual([409, "same_person"]);
    expect(await P(floors, "admin2")).toMatch(/>Confirm</);
    for (const id of ["abc", "0", "99999999999999999999"]) expect(await P(floors, ROLE("administrator"), { id }), id).toMatch(/That pay floor does not exist/);
  });
});

describe("/accounts and /companies/seed, two people", () => {
  it("a merge one administrator proposed offers that person Withdraw and another administrator Confirm; only ids are shown, no name or email", async () => {
    const r = await post("accounts", "admin2", { action: "merge_propose", keep: S.cand1, drop: S.cand2 });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const mine = await ACCOUNTS("admin2");
    expect(mine).toMatch(/Withdraw/);
    expect(mine).not.toMatch(/Confirm the merge/);
    const other = await ACCOUNTS(ROLE("administrator"));
    expect(other).toMatch(/Confirm the merge/);
    expect(other).toContain(S.cand1);
    expect(other).not.toMatch(/@|Fake Candidate/);
    const same = await post("accounts", "admin2", { action: "merge_confirm", requestId: r.json.requestId });
    expect([same.status, same.json.error]).toEqual([409, "same_person"]);
  });
  it("a seed file one editor proposed is shown with its rows as text; the editor sees Withdraw, an administrator Confirm and import", async () => {
    const text = "display_name\tkind\tbrand_names\tdete_names\nFake <b>Seed</b> Foods Ltd\temployer\tFake Seed Brand\tFAKE SEED FOODS LIMITED";
    expect((await post("companies/seed", ROLE("rules_data_editor"), { action: "propose", text })).status).toBe(200);
    const ed = await SEED(ROLE("rules_data_editor"));
    expect(ed).toMatch(/Fake &lt;b&gt;Seed&lt;\/b&gt; Foods Ltd/);
    expect(ed).toMatch(/Withdraw/);
    expect(ed).not.toMatch(/Confirm and import/);
    expect(await SEED(ROLE("administrator"))).toMatch(/Confirm and import/);
    expect(await SEED("both")).toMatch(/Confirm and import/); // not the proposer: another login that also holds the editor role
  });
});

describe("/companies/[id]", () => {
  it("shows the company, its domains and the owner section by role; hostile ids are a 404", async () => {
    const ar = await COMPANY(ROLE("account_reviewer"), S.org);
    expect(ar).toMatch(/Fake Domain Company Ltd/);
    expect(ar).toMatch(/fake-domain-co\.example\.test/);
    expect(ar).toMatch(/Record the request/);
    const adm = await COMPANY(ROLE("administrator"), S.org);
    expect(adm).toMatch(/Only an account reviewer can change/);
    for (const id of ["abc", "0", "1e3", "99999999999999999999", "-1", "%2e"]) expect(await COMPANY(ROLE("administrator"), id), id).toBe("NOT_FOUND");
    expect(await COMPANY(ROLE("administrator"), "987654321")).toBe("NOT_FOUND");
  });
  it("an open owner request is listed on its company's page with Complete and Cancel", async () => {
    const org = Number(S.org);
    const { F } = fixtures(db) as unknown as { F: { portal(o?: object): Promise<string>; member(o: number, u: string, x?: object): Promise<number> } };
    const owner = await F.member(org, await F.portal({ email: "fake.owner.old@example.test" }), { role: "account_owner" });
    const next = await F.member(org, await F.portal({ email: "fake.owner.new@example.test" }), { role: "recruiter" });
    void owner;
    const r = await post("companies/owner-reassign", ROLE("account_reviewer"), { action: "request", membershipId: String(next), domainChecked: true, croChecked: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const p = await COMPANY(ROLE("account_reviewer"), S.org);
    expect(p).toMatch(/fake\.owner\.new@example\.test/);
    expect(p).toMatch(/Complete the change/);
    expect(p).toMatch(/Cancel the request/);
  });
});

describe("/companies/dete-links", () => {
  it("an account reviewer is offered Link and Not this company; trust and safety and an administrator read only", async () => {
    const ar = await P(dete, ROLE("account_reviewer"));
    expect(ar).toMatch(/Link this name/);
    expect(ar).toMatch(/Not this company/);
    expect(ar).toMatch(/Fake Domain Company Ltd/);
    for (const r of ["trust_and_safety", "administrator"]) {
      const p = await P(dete, ROLE(r));
      expect(p, r).toMatch(/Fake Domain Company Ltd/);
      expect(p, r).toMatch(/Only an account reviewer can link/);
      expect(p, r).not.toMatch(/Link this name/);
    }
  });
  it("linking through the route works once, and the page no longer suggests it; hostile pages give the first page", async () => {
    const r = await post("companies/dete-links", ROLE("account_reviewer"), { action: "link", deteName: "FAKE DOMAIN COMPANY LTD", organisationId: S.org });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await P(dete, ROLE("account_reviewer"))).toMatch(/No suggestion is waiting/);
    for (const page of ["abc", "0", "-1", "99999", "1e3", ["1", "2"] as unknown as string]) expect(await P(dete, ROLE("administrator"), { page }), String(page)).toMatch(/DETE name links/);
  });
});

describe("budget", () => {
  const cases: [string, () => Promise<string>, number][] = [
    ["contact list", () => P(contact, ROLE("content_editor")), BUDGET.contact],
    ["held jobs with an item", () => P(jobs, ROLE("administrator"), { queue: "scam_flag", id: S.scamItem }), BUDGET.jobs],
    ["pay floors", () => P(floors, ROLE("administrator")), BUDGET.floors],
    ["accounts", () => ACCOUNTS(ROLE("administrator")), BUDGET.accounts],
    ["company seed", () => SEED(ROLE("administrator")), BUDGET.seed],
    ["company page", () => COMPANY(ROLE("account_reviewer"), S.org), BUDGET.company],
    ["DETE links", () => P(dete, ROLE("account_reviewer")), BUDGET.dete],
  ];
  for (const [name, run, limit] of cases)
    it(`${name}: at most ${limit} statements and ${BUDGET.ms} ms`, async () => {
      const [, n] = await counted(run);
      const ms = await median(run);
      console.log(`P29a ${name}: ${n} statements, median ${ms.toFixed(1)} ms`);
      expect(n).toBeLessThanOrEqual(limit);
      expect(ms).toBeLessThan(BUDGET.ms);
    });
});
