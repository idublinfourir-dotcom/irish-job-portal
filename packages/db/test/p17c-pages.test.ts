// P17c integration: the permit case pages and the two emailed-link pages run end to end on the real test database: the page file, then apps/candidate/lib/data.ts, then
// the real route handlers and the real session as app_candidate. Only Next's request pieces (headers, redirect, notFound) are stood in; the network guard stays on.
// The emailed links are taken from the real email builders and opened on the page. Fake people only. Performance budget at the end (measured 25 Nov 2026, warm).
import pg from "pg";
import { renderToStaticMarkup as html } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { counted, median } from "./staff-routes-harness";
import { buildAlertEmail } from "../src/job-alert-email";
import { confirmEmail } from "../src/outbox-cli";
import { tokenHash } from "../src/data-request-confirm";

const cur = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => cur.headers }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }), redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); }, notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("next/server", () => ({ connection: async () => {}, after: () => {} }));

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BUDGET = { caseStatements: 14, caseMs: 60, listStatements: 8, listMs: 40 }; // measured 25 Nov 2026: case page 14 statements (5 reads, each with its 2 session statements) and 11 ms; list 7 and 5 ms
const secret = "trial-only-secret-trial-only-secret-32", BASE = "http://localhost:3000";
let db: TestDb, su: pg.Pool, AUTH: (r: Request) => Promise<Response>;
let F: { text(p?: string): Promise<string>; staff(): Promise<string> };
type El = { props: Record<string, unknown> };
let ListPage: (p: unknown) => Promise<El>, CasePage: (p: unknown) => Promise<El>, UnsubPage: (p: unknown) => Promise<El>, DrPage: (p: unknown) => Promise<El>, PortalDrPage: (p: unknown) => Promise<El>;
let UnsubRoute: { POST: (r: Request) => Promise<Response> }, DrRoute: { POST: (r: Request) => Promise<Response> };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret,
    PORTAL_AUTH_URL: "http://localhost:3001", PORTAL_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  const app = "../../../apps/candidate/app";
  ListPage = (await import(`${app}/account/cases/page`)).default;
  CasePage = (await import(`${app}/account/cases/[id]/page`)).default;
  UnsubPage = (await import(`${app}/unsubscribe/page`)).default;
  DrPage = (await import(`${app}/data-request/page`)).default;
  const portal = "../../../apps/portal/app"; // a variable path: these pages are .tsx, which this package's typecheck does not compile
  PortalDrPage = (await import(`${portal}/data-request/page`)).default;
  UnsubRoute = await import(`${app}/api/alerts/unsubscribe/route`);
  DrRoute = await import(`${app}/api/data-request/route`);
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
async function login() {
  const email = `fake.${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified = true where email = $1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), id: (await su.query("select id from candidate_user where email = $1", [email])).rows[0].id as string };
}
const as = (cookie: string | null, ip = "203.0.113.7") => { cur.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": ip }); };
const q = (p: Record<string, string | string[]>) => ({ searchParams: Promise.resolve(p) });
const id = (v: string) => ({ params: Promise.resolve({ id: v }) });
const lands = async (run: () => Promise<unknown>) => { try { await run(); } catch (e) { return String((e as Error).message); } return null; };
async function caseOf(cand: string) {
  const k = (await su.query("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [cand, await F.text("services_request")])).rows[0].id;
  const c = String((await su.query("insert into services_case(candidate_user_id, consent_record_id) values ($1, $2) returning id", [cand, k])).rows[0].id);
  await su.query("insert into case_event(case_id, kind, status, candidate_user_id) values ($1, 'received', 'received', $2)", [c, cand]);
  return c;
}
const jobRow = { id: "10", title: "Cook", employer_name: "Acme", county: "Cork", salary_low: 40000, salary_high: 50000, pay_grade: null, badge: null };

describe("the case pages on the real database", () => {
  it("the list shows only this candidate's cases; signed out goes to log in; an empty list is the empty state", async () => {
    const me = await login(), other = await login(), fresh = await login();
    const mine = await caseOf(me.id), theirs = await caseOf(other.id);
    as(me.cookie);
    const el = await ListPage(q({}));
    expect((el.props.cases as { id: string }[]).map((c) => c.id)).toEqual([mine]);
    const h = html(el as never);
    expect(h).toContain(`href="/account/cases/${mine}"`);
    expect(h).not.toContain(`/account/cases/${theirs}"`);
    as(fresh.cookie);
    expect(html((await ListPage(q({}))) as never)).toContain("You have no permit requests");
    as(null);
    expect(await lands(() => ListPage(q({})))).toBe("NEXT_REDIRECT /login?next=%2Faccount%2Fcases");
    as(me.cookie);
    expect((await ListPage(q({ after: "forged-token" }))).props.error).toMatch(/could not read that address/); // a forged paging token is 400 BAD_REQUEST
  });

  it("one case: the owner sees the steps, what we asked for, the copies and the updates; no staff id, name or note reaches the HTML; another candidate, a missing case and a bad id are the same 404; signed out goes to log in", async () => {
    const me = await login(), other = await login();
    const c = await caseOf(me.id), staff = await F.staff();
    await su.query("insert into case_event(case_id, kind, status, staff_user_id, detail) values ($1, 'assigned', 'received', $2, $3), ($1, 'documents_needed', 'documents_needed', $2, $4)",
      [c, staff, JSON.stringify({ assignedStaffUserId: staff }), JSON.stringify({ documentsNeeded: ["offer_letter", "degree"] })]);
    await su.query("update services_case set status = 'documents_needed', documents_needed = $2 where id = $1", [c, ["offer_letter", "degree"]]);
    await su.query("insert into case_note(services_case_id, author_staff_user_id, body) values ($1, $2, 'Secret staff note')", [c, staff]);
    await su.query("insert into candidate_case_document(services_case_id, storage_key, file_name, content_type, byte_size, candidate_user_id) values ($1, 'case/k1', 'offer.pdf', 'pdf', 1000, $2)", [c, me.id]);
    await su.query("insert into case_document(services_case_id, storage_key, file_name, content_type, byte_size, candidate_user_id, copy_deleted_at) values ($1, null, null, 'png', 500, $2, now())", [c, me.id]);
    as(me.cookie);
    const h = html((await CasePage(id(c))) as never);
    for (const w of ["Documents needed", "Job offer letter", "Degree or qualification", "offer.pdf", "Removed copy", "Copy removed", "We asked you for: Job offer letter, Degree or qualification", "Request received"]) expect(h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain(w);
    expect(h).toMatch(/href="\/api\/candidate\/cases\/\d+\/documents\/\d+"/);
    for (const bad of [staff, "Fake Staff", "Secret", "assignedStaffUserId", "case/k1"]) expect(h).not.toContain(bad);
    as(other.cookie);
    expect(await lands(() => CasePage(id(c)))).toBe("NEXT_NOT_FOUND");
    expect(await lands(() => CasePage(id("999999999")))).toBe("NEXT_NOT_FOUND");
    for (const bad of ["abc", "1 or 1=1", "%00", "1".repeat(30), "-1"]) expect(await lands(() => CasePage(id(bad))), bad).toBe("NEXT_NOT_FOUND");
    as(null);
    expect(await lands(() => CasePage(id(c)))).toBe(`NEXT_REDIRECT /login?next=%2Faccount%2Fcases%2F${c}`);
  });

  it("an ended case shows its end state; the withdraw node is only for an open case", async () => {
    const me = await login();
    const c = await caseOf(me.id);
    as(me.cookie);
    expect((await CasePage(id(c))).props.withdraw).not.toBeNull();
    await su.query("update services_case set status = 'closed', closed_at = now(), close_reason = 'withdrawn' where id = $1", [c]);
    await su.query("insert into case_event(case_id, kind, status, candidate_user_id) values ($1, 'withdrawn', 'closed', $2)", [c, me.id]);
    const el = await CasePage(id(c));
    expect(el.props.withdraw).toBeNull();
    expect(html(el as never)).toContain("Request withdrawn");
  });
});

describe("the job alert email's Stop link opens /unsubscribe", () => {
  it("the link in the real email builder's output asks, the Confirm POST to the API stops it, and the page then says so; unknown and hostile tokens are the bad-link state", async () => {
    const me = await login();
    const token = `tok${"a".repeat(40)}`;
    const a = (await su.query("insert into alert(candidate_user_id, frequency, county, unsubscribe_token) values ($1, 'weekly', 'Dublin', $2) returning id::text", [me.id, token])).rows[0].id as string;
    const m = buildAlertEmail(me.id, [{ alertId: a, jobIds: ["10"] }], new Map([[a, { id: a, candidate_user_id: me.id, occupation_code: null, sector: null, county: "Dublin", salary_min: null, badge: null, frequency: "weekly", unsubscribe_token: token }]]), new Map([["10", jobRow]]), "https://www.example.test")!;
    const links = [...m.text.matchAll(/(?:Stop this alert|Stop all your job alerts): (\S+)/g)].map((x) => new URL(x[1]!));
    expect(links.map((u) => u.pathname)).toEqual(["/unsubscribe", "/unsubscribe"]);
    expect(m.headers["List-Unsubscribe"]).toContain("/api/alerts/unsubscribe?"); // the one-click header still names the API
    as(null);
    const [one, all] = links.map((u) => Object.fromEntries(u.searchParams));
    const asked = await UnsubPage(q(one!));
    expect(asked.props).toMatchObject({ scope: "one", alert: { filters: ["County: Dublin"], frequency: "weekly", status: "active" } });
    expect((await su.query("select status from alert where id = $1", [a])).rows[0].status).not.toBe("unsubscribed"); // opening the page changed nothing
    expect((await UnsubPage(q(all!))).props.scope).toBe("all");
    const post = await UnsubRoute.POST(new Request(`${BASE}/api/alerts/unsubscribe?${new URLSearchParams(one!)}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-vercel-forwarded-for": "203.0.113.9" }, body: "List-Unsubscribe=One-Click" }));
    expect(post.status).toBe(200);
    expect((await UnsubPage(q(one!))).props.view).toBe("already");
    for (const t of ["z".repeat(40), "<script>".padEnd(40, "a"), `${token}/../x`, "a".repeat(65)]) expect((await UnsubPage(q({ token: t, scope: "one" }))).props.view, t).toBe("bad");
    expect(html((await UnsubPage(q(one!))) as never)).not.toContain(me.id);
  });
});

describe("the data request email's button opens /data-request", () => {
  // A data request as staff would have sent it: the visitor's message (the 0002 trigger makes its review item), then the confirm hash and end that outbox-cli.ts sets.
  async function request(me: { id: string }, purpose: "export" | "erase", expires = "now() + interval '7 days'") {
    const token = Buffer.from(`${Date.now()}${Math.random()}`.padEnd(32, "x")).toString("base64url").slice(0, 43).padEnd(43, "q");
    const email = (await su.query("select email from candidate_user where id = $1", [me.id])).rows[0].email;
    const msg = (await su.query("insert into contact_message(surface, candidate_user_id, from_name, from_email, topic, body) values ('candidate_site', $1, 'Fake Sender', $2, 'data_request', 'Please act on my data') returning id", [me.id, email])).rows[0].id;
    await su.query(`update review_item set detail = jsonb_build_object('purpose', $2::text, 'kind', 'candidate', 'userId', $3::text, 'confirmHash', $4::text, 'expiresAt', ${expires}) where contact_message_id = $1`, [msg, purpose, me.id, tokenHash(token)]);
    return token;
  }
  it("the link in the real email asks with its purpose and end; unknown, expired and malformed links are different states; opening it changes nothing", async () => {
    const me = await login();
    const token = await request(me, "export");
    const href = /href="([^"]+)"/.exec(confirmEmail("https://www.example.test", token).html)![1]!;
    expect(new URL(href).pathname).toBe("/data-request");
    as(null, "203.0.113.21");
    const el = await DrPage(q(Object.fromEntries(new URL(href).searchParams)));
    expect(el.props).toMatchObject({ token, purpose: "export", expiresAt: expect.any(String) });
    expect(html(el as never)).not.toContain(me.id);
    expect((await su.query("select detail->>'confirmedAt' c from review_item where detail->>'confirmHash' = $1", [tokenHash(token)])).rows[0].c).toBeNull();
    const erase = await request(await login(), "erase"); // one open request per candidate, so each link has its own login
    expect((await DrPage(q({ token: erase }))).props.purpose).toBe("erase");
    expect((await DrPage(q({ token: "u".repeat(43) }))).props.view).toBe("invalid");
    expect((await DrPage(q({ token: await request(await login(), "export", "now() - interval '1 second'") }))).props.view).toBe("invalid");
    for (const t of ["short", `${token}x`, "../".repeat(15)]) expect((await DrPage(q({ token: t }))).props.view, t).toBe("bad");
    // The pool here is the candidate login, so the portal's rate table refuses the read: a failed read is the bad-link state, never a crash (the portal route's own live
    // answers are in data-requests.test.ts; the page's states are in apps/portal/app/data-request/data-request.test.tsx).
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await PortalDrPage(q({ token }))).props.view).toBe("bad");
    expect((await PortalDrPage(q({ token: "bad" }))).props.view).toBe("bad");
  });
  it("Confirm from the page: an erase answers ok and the link is then used; an export answers the owner's own file; an ended link is refused, and no other candidate's link works for another", async () => {
    const me = await login(), other = await login();
    const post = (token: string) => DrRoute.POST(new Request(`${BASE}/api/data-request?token=${token}`, { method: "POST", headers: { origin: BASE, "x-vercel-forwarded-for": "203.0.113.33" } }));
    const erase = await request(me, "erase");
    as(null, "203.0.113.34");
    expect((await DrPage(q({ token: erase }))).props.purpose).toBe("erase");
    const r = await post(erase);
    expect([r.status, await r.json()]).toEqual([200, { ok: true, purpose: "erase" }]);
    expect((await DrPage(q({ token: erase }))).props.view).toBe("invalid"); // used
    expect((await post(erase)).status).toBe(404);
    const exp = await request(other, "export");
    const f = await post(exp);
    expect(f.status).toBe(200);
    expect(f.headers.get("content-disposition")).toMatch(/^attachment; filename="my-data-\d{4}-\d\d-\d\d\.json"$/);
    expect((await f.json()).account).toBeTruthy();
    const ended = await request(me, "export", "now() - interval '1 second'");
    expect((await post(ended)).status).toBe(404);
    const wrongOrigin = await DrRoute.POST(new Request(`${BASE}/api/data-request?token=${await request(await login(), "export")}`, { method: "POST", headers: { origin: "https://evil.example" } }));
    expect(wrongOrigin.status).toBe(403);
  });
});

describe("performance", () => {
  it("the case page and the list stay within their statement and time budgets", async () => {
    const me = await login();
    const c = await caseOf(me.id);
    as(me.cookie);
    await CasePage(id(c));
    const [, caseN] = await counted(() => CasePage(id(c)));
    const caseMs = await median(() => CasePage(id(c)));
    await ListPage(q({}));
    const [, listN] = await counted(() => ListPage(q({})));
    const listMs = await median(() => ListPage(q({})));
    process.stdout.write(`p17c case page: ${caseN} statements, ${caseMs.toFixed(1)} ms; list: ${listN} statements, ${listMs.toFixed(1)} ms\n`);
    expect(caseN).toBeLessThanOrEqual(BUDGET.caseStatements);
    expect(caseMs).toBeLessThanOrEqual(BUDGET.caseMs);
    expect(listN).toBeLessThanOrEqual(BUDGET.listStatements);
    expect(listMs).toBeLessThanOrEqual(BUDGET.listMs);
  });
});
