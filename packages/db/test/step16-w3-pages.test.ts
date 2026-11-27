// Step 16 slices P9 and P10 (company page, occupation page, guides, guide, updates, eligibility checker, help, help page, the five legal pages, report): the pages' server code on the real
// test database as app_candidate. Each page is called as Next calls it (`await Page({ params, searchParams })` gives the element, rendered to HTML here), through the real data layer
// (apps/candidate/lib/data.ts), the real routes for every write and the real candidate login. Only Next's request context is stood in (next/headers gives the headers a test sets;
// server-only is empty); no network. Fake data only.
// Budgets (measured 24 Nov 2026, see the printed line; statements are warm renders, the median is of 15 warm renders): checks 4 (integration), 5 (performance) and 6 (security) of the six.
import pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers(), noHeaders: false } }));
vi.mock("server-only", () => ({}));
// Stage 3 step 5: noHeaders makes headers() throw, as `dynamic = "error"` would: a cached page must render without the request
vi.mock("next/headers", () => ({ headers: async () => { if (state.noHeaders) throw new Error("headers() read by a cached page"); return state.headers; } }));

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
type Element = Parameters<typeof renderToStaticMarkup>[0];
type Sp = Record<string, string | string[] | undefined>;
type PageFn = (p: { params?: Promise<Record<string, string>>; searchParams?: Promise<Sp> }) => Promise<Element> | Element;
type MetaFn = (p: { params?: Promise<Record<string, string>>; searchParams?: Promise<Sp> }) => Promise<Record<string, unknown>> | Record<string, unknown>;
let db: TestDb, su: pg.Pool, admin: pg.Pool;
let AUTH: Handler, REPORT: Handler, SAVED: Handler;
const P: Record<string, { page: PageFn; meta: MetaFn }> = {};
const ids: Record<string, string> = {};
// statements of one warm render, and the median of 15 warm renders 
const BUDGET = { company: 10, companyDb: 10, occupation: 8, guides: 8, guide: 5, updates: 5, checker: 6, help: 5, legal: 5, report: 1, medianMs: 60 };
// Measured 24 Nov 2026 (visitor, warm): company 8 statements 9.0 ms; occupation 6, 7.5 ms; guides 6, 2.2 ms; guide 3, 1.4 ms; updates 3, 3.9 ms; checker 4, 4.9 ms; help 3, 2.0 ms; legal 3, 1.2 ms; report 0, 0.5 ms. Budget: measured plus two statements, and 60 ms.

const PAGES: Record<string, string> = {
  company: "../../../apps/candidate/app/companies/[slug]/page", occupation: "../../../apps/candidate/app/occupations/[slug]/page", guides: "../../../apps/candidate/app/guides/page",
  guide: "../../../apps/candidate/app/guides/[slug]/page", updates: "../../../apps/candidate/app/updates/page", checker: "../../../apps/candidate/app/eligibility-checker/page",
  help: "../../../apps/candidate/app/help/page", helpPage: "../../../apps/candidate/app/help/[slug]/page", privacy: "../../../apps/candidate/app/privacy/page",
  terms: "../../../apps/candidate/app/terms/page", cookies: "../../../apps/candidate/app/cookies/page", acceptable: "../../../apps/candidate/app/employer-acceptable-use/page",
  retention: "../../../apps/candidate/app/data-retention/page", report: "../../../apps/candidate/app/report/page",
};

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  admin = db.pool("app_admin");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  const route = async (p: string) => (await import(p)) as Record<string, Handler>;
  AUTH = (await route("../../../apps/candidate/app/api/auth/candidate/[...all]/route")).POST!;
  REPORT = (await route("../../../apps/candidate/app/api/report/route")).POST!;
  SAVED = (await route("../../../apps/candidate/app/api/candidate/saved/route")).POST!;
  for (const [k, p] of Object.entries(PAGES)) {
    const m = await import(p);
    P[k] = { page: m.default as PageFn, meta: (m.generateMetadata ?? (() => ({}))) as MetaFn };
  }
  await seed();
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

// ===== the fake data =====
const quiet = async (sql: string, params: unknown[]) => {
  const c = await su.connect();
  try { await c.query("set session_replication_role = replica"); return (await c.query(sql, params)).rows[0] as { id: string }; } finally { c.release(); }
};
async function org(slug: string, name: string, o: { status?: string; ph?: string; claimed?: boolean; claims?: boolean; web?: string | null; desc?: string | null } = {}) {
  ids[slug] = (await su.query(
    `insert into organisation(slug, display_name, kind, status, county, permit_history, claimed_at, claims_removed_at, website, short_description) values ($1,$2,'employer',$3,'Cork',$4,$5,$6,$7,$8) returning id::text`,
    [slug, name, o.status ?? "verified", o.ph ?? "has_history", o.claimed ? new Date() : null, o.claims ? new Date() : null, o.web === undefined ? null : o.web, o.desc ?? null])).rows[0].id;
  return ids[slug]!;
}
let src = "";
async function job(orgId: string, orgName: string, title: string, o: { code?: string; status?: string; badge?: string | null; salary?: number } = {}) {
  const status = o.status ?? "live";
  const live = status === "live";
  const extra = live ? ", search_vector" : status === "hidden" ? ", hidden_reason" : status === "closed" ? ", close_reason" : "";
  const vals = live ? ", to_tsvector('english','x')" : status === "hidden" ? ", 'admin'" : status === "closed" ? ", 'closed'" : "";
  const badge = o.badge === undefined ? "critical_skills_eligible" : o.badge;
  const run = badge === "sponsor_confirmed" ? quiet : async (sql: string, params: unknown[]) => (await su.query(sql, params)).rows[0] as { id: string };
  return (await run(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, badge, salary_low, salary_high, quota_full, status, closes_at, own_page_url${extra})
     values ($1,'admin_manual',$2,$3,$4,'Cork','health',$5,$6,$7,$8,$8,false,'${status}', now() + interval '20 days','https://example.test/apply'${vals}) returning id::text`,
    [orgId, src, title, orgName, o.code ?? "2231", badge === "sponsor_confirmed" ? "general" : "critical_skills", badge, o.salary ?? 45000])).id;
}
const page = (kind: string, slug: string, title: string, body: string, o: { status?: string; cat?: string | null; eff?: string | null; at?: string; checked?: string | null } = {}) =>
  su.query("insert into content_page(kind, slug, title, body, source_url, checked_on, status, published_at, category, effective_from) values ($1,$2,$3,$4,'https://enterprise.gov.ie/x',$5,$6,$7,$8,$9)",
    [kind, slug, title, body, o.checked === undefined ? "2026-11-12" : o.checked, o.status ?? "published", o.at ?? new Date().toISOString(), o.cat ?? null, o.eff ?? null]);

async function seed() {
  src = (await su.query("insert into job_source(kind, board) values ('portal','w3-board') returning id")).rows[0].id;
  // a company with DETE history (yearly files and monthly rows), names, six-plus jobs
  const h = await org("w3-hospital", "Wthree Hospital Group", { claimed: true, web: "https://www.w3-hospital.example/about", desc: "A made-up hospital group." });
  const n1 = (await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1,'Wthree Hospital Group DAC','wthree hospital group dac','legal','admin') returning id::text", [h])).rows[0].id;
  await su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1,'Wthree Hospital','wthree hospital','alias','admin')", [h]);
  for (const [y, p] of [[2019, 12], [2020, 18], [2024, 52], [2025, 61]]) await su.query("insert into dete_permit_count(dete_name, organisation_name_id, year, permits, source_file) values ('Wthree Hospital Group DAC',$1,$2,$3,'f')", [n1, y, p]);
  for (const m of [1, 2, 3]) await su.query("insert into dete_permit_count(dete_name, organisation_name_id, year, month, permits, source_file) values ('Wthree Hospital Group DAC',$1,2026,$2,$3,'f')", [n1, m, m]);
  for (let i = 0; i < 8; i++) await job(h, "Wthree Hospital Group", `W3 Nurse ${i}`, { salary: 40000 + i });
  await job(h, "Wthree Hospital Group", "W3 Draft Role", { status: "draft" });
  await job(h, "Wthree Hospital Group", "W3 Closed Role", { status: "closed" });
  await job(h, "Wthree Hospital Group", "W3 Hidden Role", { status: "hidden" });
  const big = await org("w3-big", "Wthree Big Employer");
  for (let i = 0; i < 25; i++) await job(big, "Wthree Big Employer", `W3 Big ${i}`);
  await org("w3-empty", "Wthree Empty Co");
  await org("w3-first", "Wthree First Time Ltd", { ph: "first_time" });
  await org("w3-unlinked", "Wthree Unlinked Ltd", { ph: "not_linked" });
  await org("w3-scam", "Wthree Scam Ltd", { ph: "not_linked", claims: true });
  await org("w3-rejected", "Wthree Rejected Ltd", { status: "rejected" });
  await org("w3-closed-co", "Wthree Closed Co", { status: "closed" });
  const nw = await org("w3-new", "Wthree New Name Ltd");
  const old = await org("w3-old", "Wthree Old Name Ltd");
  await su.query("update organisation set merged_into_id = $1 where id = $2", [nw, old]);
  // a second company with a nurse job and a sponsor job, so the occupation page has several employers
  const other = await org("w3-other", "Wthree Other Care");
  await job(other, "Wthree Other Care", "W3 Other Nurse", { code: "2231" });
  await job(other, "Wthree Other Care", "W3 Sponsor Chef", { code: "5434", badge: "sponsor_confirmed" });
  // content
  for (const [s, t] of [["w3-guide-a", "W3 Guide Alpha"], ["w3-guide-b", "W3 Guide Beta"]] as const) await page("guide", s, t, `Body of ${t}.\n\nSecond paragraph <b>bold</b>.`);
  await page("guide", "w3-guide-draft", "W3 Secret Draft Guide", "draft body", { status: "draft" });
  await page("guide", "w3-guide-gone", "W3 Withdrawn Guide", "gone body", { status: "withdrawn" });
  const cats = ["salary_minimums", "quotas", "occupation_lists", "processing"];
  for (let i = 0; i < 23; i++) await page("update", `w3-update-${i}`, `W3 Update ${i}`, `Update body ${i}.`, { cat: cats[i % 4]!, at: new Date(Date.now() - i * 3_600_000).toISOString(), eff: i === 0 ? "2027-01-01" : null });
  await page("update", "w3-update-draft", "W3 Secret Draft Update", "x", { status: "draft", cat: "quotas" });
  await page("help", "who-needs-a-permit", "Who needs an employment permit?", "Help body.\n\nSecond help paragraph.", { cat: "permit_services" });
  await page("help", "w3-help-account", "How do I close my account?", "Account help body.", { cat: "account" });
  await page("help", "w3-help-odd", "An uncategorised question", "Odd body.", { cat: null });
  await page("help", "w3-help-draft", "W3 Secret Draft Help", "x", { status: "draft" });
  await page("occupation", "2231", "Nurse team note", "A made-up team note for nurses.");
  const { publishLegal } = await import("./better-auth-helper");
  await publishLegal(su, admin, "privacy_notice", "placeholder-2026-11-19", "PLACEHOLDER privacy text.\n\nSecond privacy paragraph.");
  await publishLegal(su, admin, "cookie_policy", "placeholder-2026-11-19");
  await publishLegal(su, admin, "data_retention", "2026-12-01", "The real retention text.");
  await publishLegal(su, admin, "signup_terms", "placeholder-2026-11-12");
}

// ===== helpers =====
let n = 0;
const freshIp = () => `203.0.113.${(++n % 240) + 10}.${n}`;
async function login() {
  const email = `fake.w3${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake Reader", ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), email };
}
const as = <T>(cookie: string | undefined, fn: () => Promise<T> | T, ip = freshIp()): Promise<T> => {
  state.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": ip });
  return Promise.resolve(fn());
};
const render = async (k: string, o: { params?: Record<string, string>; sp?: Sp; cookie?: string; ip?: string } = {}) =>
  renderToStaticMarkup(await as(o.cookie, () => P[k]!.page({ params: Promise.resolve(o.params ?? {}), searchParams: Promise.resolve(o.sp ?? {}) }), o.ip));
const metaOf = (k: string, o: { params?: Record<string, string>; sp?: Sp } = {}) => as(undefined, () => P[k]!.meta({ params: Promise.resolve(o.params ?? {}), searchParams: Promise.resolve(o.sp ?? {}) })) as Promise<{ title?: string; description?: string; alternates?: { canonical?: string }; robots?: { index?: boolean } }>;
const digestOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { digest?: string }).digest ?? String(e); } };
const NOT_FOUND = /NEXT_(HTTP_ERROR_FALLBACK|NOT_FOUND)(;404)?/;
const ldOf = (h: string, t: string) => [...h.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>).filter((b) => b["@type"] === t);
const cards = (h: string) => (h.match(/data-job-card="/g) ?? []).length;
const write = (route: Handler, cookie: string, body: unknown, path = "/api/x") =>
  route(new Request(`${BASE}${path}`, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify(body) }));
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => {
  const t: number[] = [];
  for (let i = 0; i < 15; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); }
  return t.sort((a, b) => a - b)[7]!;
};
const rules = async () => {
  const { getPool, getRules } = await import("../src");
  return (await getRules(getPool())).minimums;
};
const eur = (n: number) => `€${new Intl.NumberFormat("en-IE").format(n)}`;

// ===== P9: the company page =====
describe("P9: /companies/<slug>", () => {
  it("shows a visitor the company, its DETE figures, its names and the first 6 live jobs with the sign-in box, no draft, closed or hidden job", async () => {
    const h = await render("company", { params: { slug: "w3-hospital" } });
    expect(h).toMatch(/<h1[^>]*>Wthree <span[^>]*>Hospital Group<\/span><\/h1>/);
    for (const t of ["Claimed", "w3-hospital.example", "A made-up hospital group.", "Wthree Hospital Group DAC", "Legal name", "Also known as", "8 live jobs"]) expect(h).toContain(t);
    expect(h).toMatch(/data-permit-total[^>]*>149</); // 12 + 18 + 52 + 61 + (1 + 2 + 3 monthly in 2026)
    expect(h).toContain("Peak year");
    expect(h).toContain("2025 had 61 permits");
    expect(h).toContain("Mar 2026");
    expect(h).toContain("2026 covers January to March.");
    expect(cards(h)).toBe(6);
    expect(h).toContain("You can see 6 of 8");
    expect(h).toContain("Log in to report this company");
    expect(h).not.toContain('aria-label="Pagination"');
    for (const t of ["W3 Draft Role", "W3 Closed Role", "W3 Hidden Role", "close_reason", "hidden_reason", "search_vector", "claims_removed_at", "CRO", "Get alerts"]) expect(h).not.toContain(t);
  });
  it("pages a signed-in candidate with Previous and Next (20 a page), forward and back through the trail, marks saved jobs and offers the report", async () => {
    const { cookie } = await login();
    const first = await render("company", { params: { slug: "w3-big" }, cookie });
    expect(cards(first)).toBe(20);
    expect(first).toContain("25 live jobs");
    expect(first).toContain("Report this company");
    expect(first).toContain(">Next<");
    expect(first).not.toContain("data-sign-in-for-more");
    const next = /href="(\/companies\/w3-big\?[^"]+)"/.exec(first)![1]!.replaceAll("&amp;", "&");
    const q = Object.fromEntries(new URL(next, BASE).searchParams);
    expect(q.back).toBeUndefined();
    const second = await render("company", { params: { slug: "w3-big" }, sp: q, cookie });
    expect(cards(second)).toBe(5);
    expect(second).toContain('rel="prev"');
    expect(second).toContain('href="/companies/w3-big"'); // Previous from the second page is the first
    expect(second).not.toContain(">Next</a>");
    const saved = await write(SAVED, cookie, { jobId: await job(ids["w3-hospital"]!, "Wthree Hospital Group", "W3 Saved Nurse") });
    expect(saved.status).toBe(200);
    expect(await render("company", { params: { slug: "w3-hospital" }, cookie })).toContain("Saved: W3 Saved Nurse");
  });
  it("a company with no live job still has its page; the three labels have their words", async () => {
    const e = await render("company", { params: { slug: "w3-empty" } });
    expect(e).toContain("0 live jobs");
    expect(e).toContain("This company has no live jobs right now.");
    expect(await render("company", { params: { slug: "w3-first" } })).toContain("We found no DETE permit history for this employer since 2019.");
    const unlinked = await render("company", { params: { slug: "w3-unlinked" } });
    expect(unlinked).toContain("We could not match this employer to DETE records");
    expect(unlinked).not.toContain("data-permit-chart");
    expect(await render("company", { params: { slug: "w3-scam" } })).toContain("confirmed false three times");
  });
  it("redirects a merged company to the company it moved to (308) and answers 404 for unknown, rejected and closed companies and for hostile slugs", async () => {
    const d = await digestOf(render("company", { params: { slug: "w3-old" } }));
    expect(d).toMatch(/NEXT_REDIRECT;(replace|push);\/companies\/w3-new;308/);
    for (const slug of ["w3-rejected", "w3-closed-co", "no-such-company", "", "UPPER", "a b", "x'--", "a".repeat(500), "../etc/passwd", "w3-hospital%00", "é", "w3-hospital/../x", "<script>"])
      expect(await digestOf(render("company", { params: { slug } })), slug.slice(0, 30)).toMatch(NOT_FOUND);
  });
  it("words a visitor's later page (401), a bad cursor (400) and the rate limit (429), and never throws", async () => {
    expect(await render("company", { params: { slug: "w3-big" }, sp: { after: "abc" } })).toContain("Log in to see more");
    const { cookie } = await login();
    for (const after of ["garbage", "a".repeat(250), "../x"]) {
      const h = await render("company", { params: { slug: "w3-big" }, sp: { after }, cookie });
      expect(h, after.slice(0, 10)).toMatch(/We could not use that company page|Log in to see more|class="mx-auto max-w-page/);
      expect(h).not.toContain("garbage</");
    }
    expect(await render("company", { params: { slug: "w3-big" }, sp: { after: "garbage" }, cookie })).toContain("We could not use that company page");
    const ip = freshIp();
    let h = "";
    for (let i = 0; i < 62; i++) h = await render("company", { params: { slug: "w3-empty" }, ip }); // one gated read a render; a visitor's limit is 60 a minute
    expect(h).toContain("Too many requests");
  });
  it("sets a title and description inside the SEO limits, a canonical address, and noindex on a later page", async () => {
    const m = await metaOf("company", { params: { slug: "w3-hospital" } });
    expect(m.title!.endsWith(" | Irish Work Permit")).toBe(true);
    expect(m.title!.length - " | Irish Work Permit".length).toBeLessThanOrEqual(60);
    expect(m.description!.length).toBeGreaterThanOrEqual(120);
    expect(m.description!.length).toBeLessThanOrEqual(160);
    expect(m.alternates!.canonical).toBe(`${BASE}/companies/w3-hospital`);
    expect(m.robots!.index).toBe(false); // the site-wide noindex holds until the SEO slice flips it
    expect((await metaOf("company", { params: { slug: "nope" } })).title).toBe("Company not found");
  });
  it("reports a company through the real route: once, then 'already reported'; a visitor cannot", async () => {
    const { cookie } = await login();
    const companyId = ids["w3-hospital"]!;
    expect((await write(REPORT, cookie, { companyId, reason: "fake_company", evidence: "made-up" }, "/api/report")).status).toBe(200);
    const again = await write(REPORT, cookie, { companyId, reason: "other" }, "/api/report");
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("ALREADY_REPORTED");
    expect((await REPORT(new Request(`${BASE}/api/report`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ companyId, reason: "other" }) }))).status).toBe(401);
    expect((await write(REPORT, cookie, { companyId: ids["w3-rejected"], reason: "other" }, "/api/report")).status).toBe(404);
    expect(await su.query("select count(*)::int c from report where target_kind = 'organisation' and target_organisation_id = $1", [companyId]).then((r) => r.rows[0].c)).toBe(1);
  });
});

// ===== P10: occupation page =====
describe("P10: /occupations/<name-slug>", () => {
  it("shows the minimums in force from the database (never typed), the quota, the registration steps, the team note and the visitor's first jobs", async () => {
    const m = await rules();
    const { occupationSlug } = await import("../../../apps/candidate/lib/occupations");
    const slug = occupationSlug("2231")!;
    const h = await render("occupation", { params: { slug } });
    for (const t of [eur(m.criticalSkills), eur(m.graduate), m.nonListRoute ? eur(m.nonList) : "Not open", "SOC 2231", "Registration body", "NMBI", "Nurse team note", "A made-up team note for nurses.", "No quota applies"]) expect(h).toContain(t);
    expect(h.match(/<h1\b/g)).toHaveLength(1);
    expect(h).toContain("visa sponsorship");
    expect(h).toContain("/jobs?occupationCode=2231");
    expect(cards(h)).toBeGreaterThan(0);
    expect(cards(h)).toBeLessThanOrEqual(6);
    for (const t of ["Related occupations", "W3 Draft Role", "W3 Closed Role", "close_reason"]) expect(h).not.toContain(t);
  });
  it("carries the Occupation markup with the registration body, and its breadcrumb (frame 01); an unregulated code names no body", async () => {
    const { occupationSlug, occupationTitle } = await import("../../../apps/candidate/lib/occupations");
    const slug = occupationSlug("2231")!, h = await render("occupation", { params: { slug } });
    const ld = ldOf(h, "Occupation");
    expect(ld).toEqual([expect.objectContaining({ name: occupationTitle("2231"), occupationalCategory: "2231", url: `${BASE}/occupations/${slug}`, sameAs: expect.stringMatching(/^https:\/\//) })]);
    expect(ld[0]!.qualifications).toMatch(/NMBI|Nursing/);
    expect(ldOf(h, "BreadcrumbList")).toHaveLength(1);
    const other = ldOf(await render("occupation", { params: { slug: occupationSlug("1225")! } }), "Occupation");
    expect(other).toHaveLength(1);
    expect(other[0]).not.toHaveProperty("qualifications");
    expect((await metaOf("occupation", { params: { slug } })).alternates!.canonical).toBe(`${BASE}/occupations/${slug}`);
  });
  it("a company and the eligibility checker carry their breadcrumb, and no job list carries job markup", async () => {
    const c = await render("company", { params: { slug: "w3-hospital" } });
    expect(ldOf(c, "BreadcrumbList")).toHaveLength(1);
    expect(c).not.toContain("JobPosting");
    expect(ldOf(await render("checker"), "BreadcrumbList").map((b) => (b.itemListElement as { name: string }[]).map((x) => x.name))).toEqual([["Home", "Eligibility checker"]]);
  });
  it("an ineligible code has no minimums; a code on neither list, an unknown slug and hostile slugs are 404", async () => {
    const { occupationSlug } = await import("../../../apps/candidate/lib/occupations");
    const h = await render("occupation", { params: { slug: occupationSlug("1225")! } });
    expect(h).toContain("Ineligible Occupations List");
    expect(h).not.toContain("Salary minimums for this occupation");
    for (const slug of [occupationSlug("1115")!, "no-such-occupation", "", "NURSES", "x'--", "a".repeat(400), "../etc", "%00", "nurses/../x"]) expect(await digestOf(render("occupation", { params: { slug } })), slug.slice(0, 30)).toMatch(NOT_FOUND);
  });
  it("a code has a page exactly when the picker says it is on a list: what the links go by (OCC1)", async () => {
    const { getOccupationPage, getRules, occupationPicker } = await import("../src");
    const rules = await getRules(su);
    const wrong: string[] = [];
    for (const o of (await occupationPicker(su)).occupations) {
      const has = (await getOccupationPage(su, o.code, { rules, limit: 1 })) !== null;
      if (has === (o.listStatus === "other")) wrong.push(`${o.code} ${o.listStatus}`);
    }
    expect(wrong).toEqual([]);
  });
  it("every occupation link of the home page opens, and the one on neither list goes to its jobs (OCC1)", async () => {
    const path: string = "../../../apps/candidate/app/page"; // held in a variable, like PAGES: this package has no JSX setting
    const home = ((await import(path)) as { default: PageFn }).default;
    const h = renderToStaticMarkup(await as(undefined, () => home({ searchParams: Promise.resolve({}) })));
    const slugs = [...h.matchAll(/href="\/occupations\/([^"]+)"/g)].map((x) => x[1]!);
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) expect((await render("occupation", { params: { slug } })).match(/<h1\b/g), slug).toHaveLength(1);
    expect(h).toContain('href="/jobs?occupationCode=6145"');
  });
  it("the visitor sees at most 6 jobs and the sign-in box; metadata is inside the limits", async () => {
    const { occupationSlug } = await import("../../../apps/candidate/lib/occupations");
    const slug = occupationSlug("2231")!;
    const big = await render("occupation", { params: { slug } });
    expect(cards(big)).toBeLessThanOrEqual(6);
    const m = await metaOf("occupation", { params: { slug } });
    expect(m.title!.length - " | Irish Work Permit".length).toBeLessThanOrEqual(60);
    expect(m.description!.length).toBeGreaterThanOrEqual(120);
    expect(m.description!.length).toBeLessThanOrEqual(160);
  });
});

// ===== P10: guides, a guide, the updates feed =====
describe("P10: /guides, /guides/<slug>, /updates", () => {
  it("lists the published guides only, with the three newest updates", async () => {
    const h = await render("guides");
    for (const t of ["W3 Guide Alpha", "W3 Guide Beta", "Checked on 12 Nov 2026", "W3 Update 0", "W3 Update 1", "W3 Update 2"]) expect(h).toContain(t);
    for (const t of ["W3 Secret Draft Guide", "W3 Withdrawn Guide", "W3 Update 3<"]) expect(h).not.toContain(t);
  });
  it("an update's link on the home page lands on it in the feed (an update has no page of its own)", async () => {
    const path: string = "../../../apps/candidate/app/page";
    const home = ((await import(path)) as { default: PageFn }).default;
    const links = [...renderToStaticMarkup(await as(undefined, () => home({ searchParams: Promise.resolve({}) }))).matchAll(/href="\/updates#([^"]+)"/g)].map((x) => x[1]!);
    const feed = await render("updates");
    for (const id of links) expect(feed, id).toContain(`id="${id}"`);
    expect(feed).toContain('id="w3-update-0"');
  });
  it("shows a guide as plain paragraphs (markup in the text is text), 404 for a draft, a withdrawn, another kind's and a hostile slug", async () => {
    const h = await render("guide", { params: { slug: "w3-guide-a" } });
    expect(h).toContain("Body of W3 Guide Alpha.");
    expect(h).toContain("Second paragraph &lt;b&gt;bold&lt;/b&gt;.");
    expect(h).toContain("Source: enterprise.gov.ie");
    for (const slug of ["w3-guide-draft", "w3-guide-gone", "w3-update-1", "who-needs-a-permit", "no-such", "", "A", "x'; drop table content_page;--", "a".repeat(101), "../etc", "\u0000", "é"]) expect(await digestOf(render("guide", { params: { slug } })), slug.slice(0, 20)).toMatch(NOT_FOUND);
    const m = await metaOf("guide", { params: { slug: "w3-guide-a" } });
    expect(m.title).toBe("W3 Guide Alpha | Irish Work Permit");
    expect(m.description!.length).toBeGreaterThanOrEqual(120);
  });
  it("pages the feed 20 a page with Previous and Next through the trail, and filters by type", async () => {
    const first = await render("updates");
    expect((first.match(/data-update/g) ?? []).length).toBe(20);
    expect(first).toContain("Effective from 1 Jan 2027");
    expect(first).not.toContain("W3 Secret Draft Update");
    expect(first).not.toContain(">Previous</a>");
    const next = /href="(\/updates\?[^"]+)"/.exec(first.slice(first.indexOf('aria-label="Pagination"')))![1]!.replaceAll("&amp;", "&");
    const second = await render("updates", { sp: Object.fromEntries(new URL(next, BASE).searchParams) });
    expect((second.match(/data-update/g) ?? []).length).toBe(3);
    expect(second).toContain('rel="prev"');
    const q = await render("updates", { sp: { category: "quotas" } });
    expect((q.match(/data-update/g) ?? []).length).toBe(6); // i = 1, 5, 9, 13, 17, 21
    expect(q).toMatch(/aria-current="true"[^>]*>Quotas</);
  });
  it("ignores an unknown type, words a bad cursor, and never echoes either", async () => {
    const h = await render("updates", { sp: { category: "<script>alert(1)</script>" } });
    expect(h).not.toContain("<script>alert");
    expect(h).toMatch(/aria-current="true"[^>]*>All</);
    const bad = await render("updates", { sp: { after: "garbage" } });
    expect(bad).toContain("We could not use that updates");
    expect(await render("updates", { sp: { after: "x".repeat(300) } })).not.toContain("xxxxxxxxxx");
  });
});

// ===== P10: the checker =====
describe("P10: /eligibility-checker", () => {
  const ok = { occupation: "2231", pay: "60000", degree: "yes", months: "24" };
  it("answers from the rules in force: the minimum is the database's, the registration block is there for a nurse", async () => {
    const m = await rules();
    const h = await render("checker", { sp: ok });
    expect(h).toContain('data-result="qualifies"');
    expect(h).toContain(eur(m.criticalSkills));
    expect(h).toContain("Registration:");
    expect(h).toContain("/occupations/");
  });
  it("words each way it can say no, from the read's own sentence", async () => {
    expect(await render("checker", { sp: { ...ok, months: "6" } })).toContain("The contract is too short");
    expect(await render("checker", { sp: { ...ok, pay: "1000" } })).toContain('data-result="no"');
    expect(await render("checker", { sp: { ...ok, occupation: "1225" } })).toContain("not open for a Critical Skills permit");
    expect(await render("checker", { sp: { ...ok, occupation: "0000" } })).toContain("Choose an occupation");
  });
  it("makes no checker read for a bad answer, and never throws on hostile input", async () => {
    const [h, statements] = await counted(() => render("checker", { sp: { occupation: "", pay: "x", degree: "" } }));
    expect(h).toContain("Fix the answers marked on the left");
    expect(statements).toBeLessThanOrEqual(5); // the picker list and the session look-up only
    for (const sp of [{ occupation: "'; drop table job;--", pay: "1e9", degree: "yes" }, { occupation: ["2231", "x"], pay: ["1", "2"], degree: "yes", months: "99999" }, { ...ok, title: "x".repeat(9000) }, { ...ok, degreeMonth: "2026-99" }]) {
      const out = await render("checker", { sp });
      expect(out.replace(/<script type="application\/ld\+json">[^<]*<\/script>/g, "")).not.toContain("<script"); // only the page's own markup (jsonLd escapes every <)
      expect(out).toContain("Eligibility");
    }
  });
  it("is not counted against the read limit (PERF-3: the picker and the checker read no table)", async () => {
    const ip = freshIp();
    let h = "";
    for (let i = 0; i < 62; i++) h = await render("checker", { sp: ok, ip }); // more than a visitor's 60 a minute
    expect(h).not.toContain("Too many checks");
    expect((await su.query("select count(*)::int as n from candidate_rate_limit where key like $1", [`read:ip:${ip}:%`])).rows[0].n).toBe(0);
  });
});

// ===== P10: help, a help page, the five legal pages, report =====
describe("P10: /help, /help/<slug>, legal pages, /report", () => {
  it("lists the published help pages by group and links each to its page; no draft", async () => {
    const h = await render("help");
    for (const t of ["Your account", "How do I close my account?", "Who needs an employment permit?", "An uncategorised question", 'href="/help/w3-help-account"', 'aria-label="Contact us"', 'name="name"']) expect(h).toContain(t);
    expect(h).not.toContain("W3 Secret Draft Help");
    expect(await render("help", { cookie: (await login()).cookie })).toBe(h); // Stage 3 step 5: cached, the same HTML for everyone; the form follows the hint cookie in the browser
  });
  it("shows a help page, with 'Still not sure?' on the sign-up question only; 404 for a draft, another kind and hostile slugs", async () => {
    const who = await render("helpPage", { params: { slug: "who-needs-a-permit" } });
    expect(who).toContain("Still not sure?");
    expect(who).toContain("Help body.");
    const other = await render("helpPage", { params: { slug: "w3-help-account" } });
    expect(other).toContain("Account help body.");
    expect(other).not.toContain("Still not sure?");
    for (const slug of ["w3-help-draft", "w3-guide-a", "none", "", "A", "x'--", "a".repeat(101), "../x"]) expect(await digestOf(render("helpPage", { params: { slug } })), slug.slice(0, 20)).toMatch(NOT_FOUND);
  });
  it("shows each legal text, marks a placeholder as draft from its data and a real text not, and says so when none is published", async () => {
    const privacy = await render("privacy");
    expect(privacy).toContain("Draft text, not final");
    expect(privacy).toContain("Version placeholder-2026-11-19");
    expect(privacy).toContain("Second privacy paragraph.");
    expect(privacy).toMatch(/aria-current="page"[^>]*>Privacy notice</);
    const keep = await render("retention");
    expect(keep).toContain("The real retention text.");
    expect(keep).not.toContain("Draft text");
    expect(await render("terms")).toContain("Draft text, not final");
    expect(await render("cookies")).toContain("Draft text, not final");
    expect(await render("acceptable")).toContain("Not published yet"); // nothing published for the employer use text
    for (const k of ["privacy", "terms", "cookies", "acceptable", "retention"]) {
      const m = await metaOf(k);
      expect(m.title!.length - " | Irish Work Permit".length).toBeLessThanOrEqual(60);
      expect(m.description!.length).toBeGreaterThanOrEqual(120);
      expect(m.description!.length).toBeLessThanOrEqual(160);
    }
  });
  it("the report page says sign in to a visitor, and open the job to a signed-in candidate", async () => {
    expect(await render("report")).toContain("Sign in to report a job");
    expect(await render("report", { cookie: (await login()).cookie })).toContain("Open the job and use its Report button");
  });
  it("a forged or unknown session cookie is only a visitor on every page", async () => {
    const forged = "candidate.session_token=forged.value; better-auth.session_token=abc";
    for (const [k, params] of [["company", { slug: "w3-big" }], ["guides", {}], ["help", {}], ["privacy", {}]] as const) {
      const h = await render(k, { params, cookie: forged });
      expect(h, k).toContain("data-join");
      expect(h).not.toContain("Report this company");
      expect(h).not.toContain('aria-label="Notices"');
    }
  });
  it("the contact route answers what the form sends: a visitor needs a name and an email, a message is filed (real route, fake sender, no network)", async () => {
    const { POST } = (await import("../../../apps/candidate/app/api/contact/route")) as { POST: Handler };
    const send = (body: unknown, cookie?: string) => POST(new Request(`${BASE}/api/contact`, { method: "POST", headers: { origin: BASE, "content-type": "application/json", "x-vercel-forwarded-for": freshIp(), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
    expect((await send({ topic: "general", body: "A made-up question." })).status).toBe(400); // a visitor must give name and email
    expect((await send({ topic: "general", body: "A made-up question.", name: "Fake Visitor", email: "fake.visitor@example.test" })).status).toBe(200);
    expect((await send({ topic: "account", body: "Signed in." }, (await login()).cookie)).status).toBe(200);
    expect((await send({ topic: "appeal", body: "Signed in appeal." }, (await login()).cookie)).status).toBe(400); // an active candidate may not choose it: the form does not offer it
    const spec = loadSpec("candidate");
    const ok = await send({ topic: "other", body: "Spec check.", name: "Fake", email: "fake.spec@example.test" });
    expect(replyProblems(spec, "post", "/api/contact", ok.status, await ok.json())).toEqual([]);
  });
});

// ===== check 5: performance =====
describe("performance: statements and time of each page's reads", () => {
  it("each page stays inside its budget (visitor, warm)", async () => {
    const cases: [string, () => Promise<unknown>, number][] = [
      ["company", () => render("company", { params: { slug: "w3-hospital" } }), BUDGET.company],
      ["occupation", async () => render("occupation", { params: { slug: (await import("../../../apps/candidate/lib/occupations")).occupationSlug("2231")! } }), BUDGET.occupation],
      ["guides", () => render("guides"), BUDGET.guides],
      ["guide", () => render("guide", { params: { slug: "w3-guide-a" } }), BUDGET.guide],
      ["updates", () => render("updates"), BUDGET.updates],
      ["checker", () => render("checker", { sp: { occupation: "2231", pay: "60000", degree: "yes" } }), BUDGET.checker],
      ["help", () => render("help"), BUDGET.help],
      ["legal", () => render("privacy"), BUDGET.legal],
      ["report", () => render("report"), BUDGET.report],
    ];
    const line: string[] = [];
    for (const [name, fn, budget] of cases) {
      await fn(); // warm: rules kept, pool open
      const [, statements] = await counted(fn);
      const ms = await median(fn);
      line.push(`${name} ${statements} statements ${ms.toFixed(1)} ms`);
      expect(statements, `${name} statements`).toBeLessThanOrEqual(budget);
      expect(ms, `${name} median ms`).toBeLessThan(BUDGET.medianMs);
    }
    console.log("W3 page budgets:", line.join("; "));
  });
  it("the company page's own reads stay inside the read's page budget (company 500 pages, content.perf.ts): a page is one company read", async () => {
    const [, statements] = await counted(() => render("company", { params: { slug: "w3-big" } }));
    expect(statements).toBeLessThanOrEqual(BUDGET.companyDb);
  });
});

describe("Stage 3 step 5: the cached pages (legal, guides, help) are the same for every visitor and read nothing of the request", () => {
  const CACHED: [string, Record<string, string>?][] = [["privacy"], ["terms"], ["cookies"], ["acceptable"], ["retention"], ["guides"], ["guide", { slug: "w3-guide-a" }], ["help"], ["helpPage", { slug: "who-needs-a-permit" }],
    ["occupation", { slug: "nurses" }]]; // step 6: an occupation with live jobs (2231), checked below
  it("security: a candidate, portal, staff, forged and no cookie, and no request at all, give byte-equal HTML with no personal data", async () => {
    const { occupationSlug } = await import("../../../apps/candidate/lib/occupations");
    expect(occupationSlug("2231")).toBe(CACHED.at(-1)![1]!.slug);
    const { cookie, email } = await login();
    for (const [, p] of await su.query<{ id: string }>("select id::text from job where occupation_code = '2231' and status = 'live' limit 2").then((r) => r.rows.entries()))
      expect((await write(SAVED, cookie, { jobId: p.id })).status).toBe(200); // a candidate with saved jobs: the cached page still shows no mark
    expect(cards(await render("occupation", { params: CACHED.at(-1)![1] }))).toBeGreaterThan(0);
    for (const [k, params] of CACHED) {
      const visitor = await render(k, { params });
      for (const c of [cookie, "portal.session_token=abc", "staff.session_token=abc", "candidate.session_token=forged", `cand_in=1; ${cookie}`]) expect(await render(k, { params, cookie: c }), `${k} ${c.slice(0, 30)}`).toBe(visitor);
      state.noHeaders = true;
      try { expect(await render(k, { params }), `${k} without a request`).toBe(visitor); } finally { state.noHeaders = false; }
      expect(visitor, k).not.toContain(email);
      expect(visitor, k).not.toMatch(/Saved:|aria-pressed="true"|data-account-menu[^-]|Mark applied|session_token/);
      expect(cards(visitor), k).toBeLessThanOrEqual(6); // the visitor cap holds by construction
      expect(visitor, k).toContain("data-out-only"); // the Join band or the sign-in controls, hidden by the hint switch for a candidate
    }
  });
  it("each page module says how long it is kept, and a [slug] page renders nothing at build", async () => {
    const LIFETIME: Record<string, number> = { privacy: 86400, terms: 86400, cookies: 86400, acceptable: 86400, retention: 86400, guides: 3600, guide: 3600, help: 3600, helpPage: 3600, occupation: 300 };
    for (const [k] of CACHED) {
      const m = (await import(PAGES[k]!)) as { revalidate?: number; dynamic?: string; generateStaticParams?: () => Promise<unknown[]> };
      expect(m.revalidate, k).toBe(LIFETIME[k]);
      expect(m.dynamic, k).toBeUndefined(); // "force-dynamic" would undo the cache; the request-free render above is the guard
      if (k === "guide" || k === "helpPage" || k === "occupation") expect(await m.generateStaticParams!(), k).toEqual([]);
    }
  });
  it("a failed read throws (a regeneration keeps the last good copy), never a cached failure notice", async () => {
    const q = pg.Pool.prototype.query;
    pg.Pool.prototype.query = (async () => { throw new Error("fake pool failure"); }) as unknown as typeof q;
    try {
      for (const [k, params] of CACHED) expect(await digestOf(render(k, { params })), k).toContain("fake pool failure");
    } finally { pg.Pool.prototype.query = q; }
  });
  // measured 27 Nov 2026: 1 or 2 statements a content page, 4 the occupation page (its read, the jobs, the count, the text); the gated render was 6
  const REGEN: Record<string, number> = { occupation: 4 };
  it("performance: at most 3 statements a regeneration (the occupation page 4), none of them a session lookup or a read-limit count", async () => {
    const sql: string[] = [];
    const q = pg.Client.prototype.query;
    pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { sql.push(String((a[0] as { text?: string })?.text ?? a[0])); return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
    try {
      for (const [k, params] of CACHED) {
        sql.length = 0;
        await render(k, { params });
        expect(sql.length, `${k}: ${sql.join(" | ").slice(0, 200)}`).toBeLessThanOrEqual(REGEN[k] ?? 3);
        expect(sql.join(" "), k).not.toMatch(/rate_limit|_session/);
      }
    } finally { pg.Client.prototype.query = q; }
  });
});
