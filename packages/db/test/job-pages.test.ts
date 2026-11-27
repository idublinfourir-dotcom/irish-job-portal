// Step 16 slices P7 and P8: the search page and the job page's server code on the real test database as app_candidate. The pages are called as Next calls
// them (`await Page({ searchParams })` gives the element, rendered to HTML here), through the real data layer (apps/candidate/lib/data.ts), the real
// routes for every write and the real candidate login. Only Next's request context is stood in (next/headers gives the headers a test sets; server-only
// is empty); no network. Fake data only.
// Budget (measured 23 and 24 November 2026, see the printed line): statements and median time of each page render, warm. The visitor search runs one more gated read (the minimums for the Permit rules card: its session lookup, two rate counts and the rules): 6 became 9. PERF-3 (27 Nov 2026): one statement for both windows; in Next one count a render (React cache), here one per read (cache is a pass-through outside a server render).
import pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
type Element = Parameters<typeof renderToStaticMarkup>[0];
type SearchPage = (p: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<Element>;
type JobPageFn = (p: { params: Promise<{ job: string }> }) => Promise<Element>;
let db: TestDb, su: pg.Pool;
let AUTH: Handler, SAVED: Handler, CLICK: Handler, ANSWER: Handler, TRACKER: Handler, PROFILE: Handler;
type Meta = { title: string; description?: string; alternates?: { canonical?: string }; robots?: { index: boolean; follow: boolean } };
let Search: SearchPage, SearchMeta: (p: { searchParams: Promise<Record<string, string | string[]>> }) => Promise<Meta>;
let JobP: JobPageFn, JobMeta: (p: { params: Promise<{ job: string }> }) => Promise<Meta>;
let paths: { jobPath: (j: { id: string; title: string; county: string | null }) => string };
const ids: Record<string, string> = {};
const BUDGET = { searchVisitor: 9, searchSignedIn: 11, jobVisitor: 9, jobSignedIn: 20, medianMs: 120 };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  const route = async (p: string) => (await import(p)) as Record<string, Handler>;
  AUTH = (await route("../../../apps/candidate/app/api/auth/candidate/[...all]/route")).POST!;
  const saved = await route("../../../apps/candidate/app/api/candidate/saved/route");
  SAVED = saved.POST!;
  CLICK = (await route("../../../apps/candidate/app/api/candidate/apply-click/route")).POST!;
  ANSWER = (await route("../../../apps/candidate/app/api/candidate/did-you-apply/route")).POST!;
  TRACKER = (await route("../../../apps/candidate/app/api/candidate/tracker/route")).POST!;
  PROFILE = (await route("../../../apps/candidate/app/api/candidate/profile/route")).PUT!;
  // the paths sit in variables so this package (no JSX) does not type-check the pages themselves; the app does
  const pages: string[] = ["../../../apps/candidate/app/jobs/page", "../../../apps/candidate/app/jobs/[job]/page"];
  const sp = await import(pages[0]!);
  Search = sp.default as unknown as SearchPage;
  SearchMeta = sp.generateMetadata as never;
  const jp = await import(pages[1]!);
  JobP = jp.default as unknown as JobPageFn;
  JobMeta = jp.generateMetadata as never;
  paths = await import("../../../apps/candidate/lib/paths");

  const org = (await su.query("insert into organisation(slug, display_name, kind, status) values ('pages-org', 'Pages Org', 'employer', 'verified') returning id")).rows[0];
  const src = (await su.query("insert into job_source(kind, board) values ('portal', 'pages-board') returning id")).rows[0].id;
  // The sponsor_confirmed job needs a signed statement (a deferred check); the fixture switches the triggers off for that one insert, as fill.ts does.
  const quiet = async (sql: string, params: unknown[]) => {
    const c = await su.connect();
    try { await c.query("set session_replication_role = replica"); return (await c.query(sql, params)).rows[0] as { id: string }; } finally { c.release(); }
  };
  const add = async (key: string, o: { title?: string; county?: string; status?: string; badge?: string | null; salary?: number | null; text?: string; permit?: string; source?: string } = {}) => {
    const status = o.status ?? "live";
    const live = status === "live" || status === "under_review";
    const extra = live ? ", search_vector" : status === "hidden" ? ", hidden_reason" : status === "closed" ? ", close_reason" : "";
    const vals = live ? ", to_tsvector('english','cook')" : status === "hidden" ? ", 'report'" : status === "closed" ? ", 'closed'" : "";
    const run = o.badge === "sponsor_confirmed" || o.source ? quiet : async (sql: string, params: unknown[]) => (await su.query(sql, params)).rows[0] as { id: string };
    ids[key] = (await run(
      `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, badge, salary_low, salary_high, quota_full, status, closes_at, own_page_url${extra})
       values ($1, '${o.source ?? "admin_manual"}', $2, $3, 'Pages Org', $4, 'IT', '1122', $5, $6, $7, $7, false, '${status}', now() + interval '20 days', 'https://example.test/apply'${vals}) returning id::text`,
      [org.id, src, o.title ?? `Page Cook ${key}`, o.county ?? "Cork", o.permit ?? "critical_skills", o.badge === undefined ? "critical_skills_eligible" : o.badge, o.salary === undefined ? 50000 : o.salary])).id;
    if (o.text !== undefined) await su.query("insert into job_text(job_id, advert_text) values ($1, $2)", [ids[key], o.text]);
  };
  // The same advert on every source (SEO1: markup only on the employer's own); the oldest jobs, so the first page of a search is the others
  for (const source of ["employer", "agency", "fetched", "admin_manual"]) await add(`ld-${source}`, { title: `Meath ${source.replace("_", " ")} Role`, county: "Meath", source, text: "Made-up advert.\nSecond line & </script><script>alert(1)</script>" });
  await add("ld-no-text", { title: "Meath Textless Role", county: "Meath", source: "employer" });
  for (let i = 0; i < 8; i++) await add(`c${i}`, { county: i < 5 ? "Cork" : "Dublin" });
  for (let i = 0; i < 14; i++) await add(`f${i}`, { county: "Sligo", title: `Filler Role ${i}` });
  await add("sponsor", { title: "Sponsor Chef", county: "Galway", badge: "sponsor_confirmed", permit: "general", text: "Made-up advert.\n<b>not html</b>" });
  await add("draft", { status: "draft", title: "Secret Draft Role" });
  await add("closed", { status: "closed", title: "Closed Role" });
  await add("s20", { title: "Watched Role" });
  await add("report", { title: "Reported Role" });
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const freshIp = () => `203.0.113.${(++n % 240) + 10}.${n}`;
async function login() {
  const email = `fake.pages${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake Reader", ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), email };
}
const as = <T>(cookie: string | undefined, fn: () => Promise<T>, ip = freshIp()): Promise<T> => {
  state.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": ip });
  return fn();
};
const write = (route: Handler, cookie: string, body: unknown, path = "/api/x") =>
  route(new Request(`${BASE}${path}`, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify(body) }));
const search = async (q: Record<string, string | string[]>, cookie?: string, ip?: string) => renderToStaticMarkup(await as(cookie, () => Search({ searchParams: Promise.resolve(q) }), ip));
const jobPage = async (seg: string, cookie?: string, ip?: string) => renderToStaticMarkup(await as(cookie, () => JobP({ params: Promise.resolve({ job: seg }) }), ip));
const addressOf = (key: string, title: string, county: string | null) => paths.jobPath({ id: ids[key]!, title, county }).slice("/jobs/".length);
const views = async (id: string) => Number((await su.query("select coalesce(sum(views), 0) v from job_daily_stat where job_id = $1", [id])).rows[0].v);
const digestOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { digest?: string }).digest ?? String(e); } };
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
const cards = (h: string) => (h.match(/data-job-card="/g) ?? []).length;

describe("P7: /jobs", () => {
  it("shows a visitor the first 6 jobs and the sign-in box, no paging, no save, no report", async () => {
    const h = await search({});
    expect(cards(h)).toBe(6);
    expect(h).toContain("Want to see more jobs?");
    expect(h).toContain("You can see 6 of 30");
    expect(h).toContain("30 jobs");
    expect(h).not.toContain('aria-label="Pagination"');
    expect(h).not.toMatch(/Report Page Cook|Save Page Cook/);
    expect(h).toContain("Sign in to create an alert");
    // frame N02: the big count, the pills, the rail with the rules read from the database (never typed), no signed-in-only part
    expect(h).toMatch(/data-count-big[^>]*><span[^>]*>30<\/span>/);
    expect(h).toContain("<summary");
    expect(h).toMatch(/Permit rules.*Checked \d{1,2} [A-Z][a-z]{2} \d{4}.*€[\d,]+ is the minimum salary for a Critical Skills permit.*at least \d+ years?/);
    expect(h).not.toMatch(/\d{4}-\d{2}-\d{2}/); // a date on the page is written out
    expect((await search({}, (await login()).cookie))).not.toContain("data-rules-rail");
  });
  it("refuses a visitor a later page in words (the read answers 401 SIGN_IN_FOR_MORE)", async () => {
    expect(await search({ after: "abc" })).toContain("Log in to see more jobs");
  });
  it("pages a signed-in candidate with Previous and Next (20 a page), marks saved jobs and offers save, report and the alert builder", async () => {
    const { cookie } = await login();
    expect((await write(SAVED, cookie, { jobId: ids.c0 })).status).toBe(200);
    const first = await search({}, cookie);
    expect(cards(first)).toBe(20);
    expect(first).toContain(">Next<");
    expect(first).toContain("Create alert");
    expect(first).toContain("Report Page Cook");
    expect(first).not.toContain("Want to see more jobs?");
    expect(await search({ county: "Cork" }, cookie)).toContain("Saved: Page Cook c0");
    const next = /href="(\/jobs\?after=[^"]+)"/.exec(first)![1]!.replaceAll("&amp;", "&");
    const second = await search(Object.fromEntries(new URL(next, BASE).searchParams), cookie);
    expect(cards(second)).toBe(10);
    expect(second).toContain('rel="prev"');
  });
  it("filters by county and says the count; an unmatched search is the empty state with the newest sponsor jobs", async () => {
    const h = await search({ county: "Dublin" });
    expect(cards(h)).toBe(3);
    expect(h).toContain("3 jobs");
    expect(h).toMatch(/>Jobs<\/span> in <span[^>]*>Dublin<\/span>/); // the heading words sit in highlights (frame N02)
    const none = await search({ q: "zzznomatch" });
    expect(none).toContain("No jobs match");
    expect(none).toContain("that search");
    expect(none).toContain("Newest jobs with a confirmed sponsor");
    expect(none).toContain("Sponsor Chef");
  });
  it("takes the badge filter and the decided default sort (sponsors first)", async () => {
    expect(cards(await search({ badge: "sponsor_confirmed" }))).toBe(1);
    expect(await search({})).toMatch(/aria-current="true"[^>]*>Sponsors first</);
  });
  it("words a bad filter and never throws on hostile input", async () => {
    const bad: Record<string, string>[] = [{ sector: "Narnia" }, { badge: "junk" }, { q: "x".repeat(5000) }, { salaryMin: "-1" }, { postedWithin: "9" }, { county: "Cork'; drop table job;--" }];
    for (const q of bad) {
      const h = await search(q);
      expect(h, JSON.stringify(q).slice(0, 60)).toContain("We could not use that search");
      expect(h).not.toContain("drop table");
    }
    const { cookie } = await login();
    expect(await search({ after: "garbage" }, cookie)).toContain("We could not use that search");
    expect(cards(await search({ county: ["Dublin", "Cork"], evil: "1" }))).toBe(3); // the first value of a repeated key, unknown keys dropped
  });
  it("words the rate limit (429) instead of failing", async () => {
    const ip = freshIp();
    let h = "";
    for (let i = 0; i < 62; i++) h = await search({}, undefined, ip); // one gated read a render; a visitor's limit is 60 a minute
    expect(h).toContain("Too many searches");
  });
  it("sets a title and a description inside the SEO limits", async () => {
    const m = await as(undefined, () => SearchMeta({ searchParams: Promise.resolve({ county: "Cork" }) }));
    expect(m.title.endsWith(" | Irish Work Permit")).toBe(true);
    expect(m.title.length - " | Irish Work Permit".length).toBeLessThanOrEqual(60);
    expect(m.description!.length).toBeGreaterThanOrEqual(120);
    expect(m.description!.length).toBeLessThanOrEqual(160);
  });
  it("shows no job that is not live and no field a visitor must not see", async () => {
    const all = (await search({})) + (await search({ q: "Secret" })) + (await search({ county: "Sligo" }));
    for (const t of ["Secret Draft Role", "Closed Role", "search_vector", "hidden_reason", "close_reason", "weekly_hours"]) expect(all).not.toContain(t);
  });
});

describe("P8: /jobs/[job]", () => {
  it("shows a visitor the job with its apply link, degree box, permit notes, standing line, and counts one view", async () => {
    const before = await views(ids.c0!);
    const h = await jobPage(addressOf("c0", "Page Cook c0", "Cork"));
    for (const t of ["Page Cook c0", "Critical Skills eligible", "Your degree", "Critical Skills permit needs a job offer of at least 2 years.", "Our check is guidance, not a permit decision", 'href="https://example.test/apply"', "Log in to report this job", "Log in first if you want us to track it."]) expect(h).toContain(t);
    expect(h).not.toMatch(/Mark applied|Did you apply/);
    expect(await views(ids.c0!)).toBe(before + 1);
    const m = await as(undefined, () => JobMeta({ params: Promise.resolve({ job: addressOf("c0", "Page Cook c0", "Cork") }) }));
    expect(m.title).toContain("Page Cook c0 at Pages Org");
    expect(m.description!.length).toBeGreaterThanOrEqual(120);
    expect(await views(ids.c0!)).toBe(before + 1); // metadata counts nothing
  });
  it("prints a General job without the degree box and an advert as text only", async () => {
    const h = await jobPage(addressOf("sponsor", "Sponsor Chef", "Galway"));
    expect(h).toContain("Sponsor confirmed");
    expect(h).toContain("&lt;b&gt;not html&lt;/b&gt;");
    expect(h).not.toContain("<b>not html");
    expect(h).not.toContain("Your degree");
    expect(h).not.toContain("Permit notes");
  });
  it("redirects an old or wrong slug permanently to the current address and 404s what is not a job", async () => {
    const good = addressOf("c1", "Page Cook c1", "Cork");
    expect(await digestOf(jobPage("an-old-title-dublin-" + ids.c1))).toBe(`NEXT_REDIRECT;replace;/jobs/${good};308;`);
    expect(await digestOf(jobPage(good))).toBeNull();
    expect(await digestOf(jobPage("-" + ids.c1))).toBe(`NEXT_REDIRECT;replace;/jobs/${good};308;`); // anything that ends in the id is that job
    const notFound = "NEXT_HTTP_ERROR_FALLBACK;404";
    for (const seg of ["abc", "page-cook-draft", "9".repeat(40), "1; drop table job", "a".repeat(5000), ids.draft!, "99999999", "..%2F" + ids.c1])
      expect(await digestOf(jobPage(seg)), seg.slice(0, 40)).toBe(notFound);
  });
  it("shows a closed or expired job to anyone with the link (closed-job read B27), and a 404 for a removed one", async () => {
    const seg = addressOf("closed", "Closed Role", "Cork");
    for (const cookie of [undefined, (await login()).cookie]) {
      const h = await jobPage(seg, cookie);
      for (const t of ["This job has closed", "Closed Role", "Pages Org", "like this</span>"]) expect(h, String(cookie)).toContain(t);
      expect(h.match(/<h1\b/g)).toHaveLength(1);
      expect(h).not.toMatch(/close_reason|search_vector|hidden_reason|staff note/);
    }
    expect(await jobPage(seg)).toContain("Create a"); // the visitor's join band; a signed-in candidate has none
    expect(await jobPage(seg, (await login()).cookie)).not.toContain("Create a");
    expect((await as(undefined, () => JobMeta({ params: Promise.resolve({ job: seg }) }))).title).toBe("This job has closed");
    await su.query("update job set close_reason = 'expired' where id = $1", [ids.closed]);
    expect(await jobPage(seg)).toContain("This job has closed");
    for (const reason of ["removed", "under_review_expired", "abandoned"]) {
      await su.query("update job set close_reason = $2 where id = $1", [ids.closed, reason]);
      expect(await digestOf(jobPage(seg)), reason).toBe("NEXT_HTTP_ERROR_FALLBACK;404"); // staff took it down, or it closed under review: never shown
    }
    await su.query("update job set close_reason = 'closed' where id = $1", [ids.closed]);
  });
  it("gives a signed-in candidate Mark applied and Save, the Applied state after the route wrote it, and the profile's degree answer", async () => {
    const { cookie } = await login();
    const seg = addressOf("c2", "Page Cook c2", "Cork");
    let h = await jobPage(seg, cookie);
    for (const t of ["Mark applied", "Save Page Cook c2", "Report this job", "When you come back we ask if you applied"]) expect(h).toContain(t);
    expect(h).toContain('checked="" value="relevant"');
    expect((await write(SAVED, cookie, { jobId: ids.c2 })).status).toBe(200);
    expect((await write(TRACKER, cookie, { jobId: ids.c2 })).status).toBe(200);
    h = await jobPage(seg, cookie);
    expect(h).toContain("Saved: Page Cook c2");
    expect(h).toContain("Applied");
    expect(h).not.toContain(">Mark applied<");
    // a profile without a relevant degree pre-selects that answer and the page says what that means for this 50,000 job
    expect((await PROFILE(new Request(`${BASE}/api/candidate/profile`, { method: "PUT", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ hasRelevantDegree: false }) }))).status).toBe(200);
    h = await jobPage(seg, cookie);
    expect(h).toContain('checked="" value="none"');
    expect(h).toContain("This job is below that minimum.");
  });
  it("asks Did you apply only the candidate who clicked, and stops once it is answered", async () => {
    const [a, b] = [await login(), await login()];
    const seg = addressOf("c3", "Page Cook c3", "Cork");
    expect((await write(CLICK, a.cookie, { jobId: ids.c3 })).status).toBe(200);
    expect(await jobPage(seg, a.cookie)).toContain("Did you apply?");
    expect(await jobPage(seg, b.cookie)).not.toContain("Did you apply?");
    expect(await jobPage(seg)).not.toContain("Did you apply?");
    const clickId = (await su.query("select id::text from apply_click where job_id = $1", [ids.c3])).rows[0].id;
    expect((await write(ANSWER, b.cookie, { clickId, answer: "yes" })).status).toBe(404); // another candidate's click
    expect((await write(ANSWER, a.cookie, { clickId, answer: "no" })).status).toBe(200);
    expect(await jobPage(seg, a.cookie)).not.toContain("Did you apply?");
  });
  it("shows the S20 state, with similar jobs, to the candidate who saved a job that is no longer shown, and a 404 to everyone else", async () => {
    const [a, b] = [await login(), await login()];
    for (const key of ["s20", "report"]) expect((await write(SAVED, a.cookie, { jobId: ids[key] })).status).toBe(200);
    const states: [string, string, string][] = [
      ["s20", "under_review", "Under review"],
      ["report", "hidden", "Hidden for now"],
      ["s20", "closed", "This job has closed"],
    ];
    for (const [key, status, words] of states) {
      if (status === "hidden") {
        const rep = (await su.query("insert into report(target_kind, target_job_id, reason) values ('job', $1, 'other') returning id", [ids[key]])).rows[0].id;
        await su.query("update job set status = 'hidden', hidden_reason = 'report', hidden_report_id = $2, search_vector = null where id = $1", [ids[key], rep]);
      } else await su.query(status === "closed" ? "update job set status = 'closed', close_reason = 'closed', under_review_reason = null where id = $1" : "update job set status = 'under_review', under_review_reason = 'pay_check' where id = $1", [ids[key]]);
      const seg = "x-" + ids[key];
      const h = await jobPage(seg, a.cookie);
      expect(h, status).toContain(words);
      expect(h).toContain("like this</span>");
      expect(h).not.toMatch(/staff note|reporter|hidden_reason|under_review_reason/);
      // a job its employer closed is shown to anyone; a hidden or under-review one only to the candidate who saved it
      const stays = status === "closed" ? null : "NEXT_HTTP_ERROR_FALLBACK;404";
      expect(await digestOf(jobPage(seg, b.cookie))).toBe(stays);
      expect(await digestOf(jobPage(seg))).toBe(stays);
    }
  });
  it("words the rate limit (429)", async () => {
    const ip = freshIp();
    let h = "";
    const seg = addressOf("c4", "Page Cook c4", "Cork");
    for (let i = 0; i < 62; i++) h = await jobPage(seg, undefined, ip); // one count a render in Next (PERF-3: React cache shares it); more here, where cache is a pass-through
    expect(h).toContain("Too many requests");
  });
  it("shows no field a visitor must not see", async () => {
    const h = await jobPage(addressOf("c5", "Page Cook c5", "Dublin"));
    for (const t of ["search_vector", "hidden_reason", "close_reason", "weekly_hours", "claims_removed", "organisation_id", "Secret Draft Role", "@example.test"]) expect(h).not.toContain(t);
  });
});

describe("SEO1: canonical, noindex and markup of the search and the job page", () => {
  const blocks = (h: string) => [...h.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
  const ofType = (h: string, t: string) => blocks(h).filter((b) => b["@type"] === t);
  const launched = async <T>(fn: () => Promise<T>) => { process.env.SITE_INDEXABLE = "1"; try { return await fn(); } finally { delete process.env.SITE_INDEXABLE; } };
  const jobMeta = (seg: string, ip?: string) => as(undefined, () => JobMeta({ params: Promise.resolve({ job: seg }) }), ip);
  const searchMeta = (q: Record<string, string | string[]>) => as(undefined, () => SearchMeta({ searchParams: Promise.resolve(q) }));
  const segOf = (key: string) => addressOf(key, `Meath ${key.slice(3).replace("_", " ")} Role`, "Meath");

  it("/jobs has one canonical address; our own filter, sort or page is noindex, a key we do not know is the same page", async () => {
    await launched(async () => {
      for (const q of [{}, { utm_source: "x" }, { evil: "1" }, { county: "" }] as Record<string, string>[]) {
        const m = await searchMeta(q);
        expect([m.robots, m.alternates?.canonical], JSON.stringify(q)).toEqual([{ index: true, follow: true }, `${BASE}/jobs`]);
      }
      for (const q of [{ county: "Cork" }, { q: "cook" }, { sort: "newest" }, { after: "abc" }, { before: "abc" }, { county: ["Cork", "Dublin"] }, { sector: "Narnia" }] as Record<string, string | string[]>[]) {
        const m = await searchMeta(q);
        expect([m.robots, m.alternates], JSON.stringify(q)).toEqual([{ index: false, follow: false }, undefined]);
      }
    });
    expect((await searchMeta({})).robots).toEqual({ index: false, follow: false }); // before launch
    expect(ofType(await search({}), "BreadcrumbList")).toHaveLength(1);
    expect(ofType(await search({}), "JobPosting")).toEqual([]); // never on a list (Google's rule)
  });
  it("a job's canonical is its current address, whatever slug it was opened on and whatever host was asked for", async () => {
    await launched(async () => {
      const want = `${BASE}/jobs/${segOf("ld-fetched")}`;
      for (const seg of [segOf("ld-fetched"), `an-old-title-${ids["ld-fetched"]}`]) expect((await jobMeta(seg)).alternates?.canonical, seg).toBe(want);
      state.headers = new Headers({ host: "evil.test", "x-forwarded-host": "evil.test", "x-vercel-forwarded-for": freshIp() });
      expect((await JobMeta({ params: Promise.resolve({ job: segOf("ld-fetched") }) })).alternates?.canonical).toBe(want);
      expect((await jobMeta(segOf("ld-fetched"))).robots).toEqual({ index: true, follow: true });
    });
  });
  it("job markup only on the employer's own job (#92), with what Google requires; the same advert on every other source has none", async () => {
    const h = await jobPage(segOf("ld-employer"));
    const [ld, ...more] = ofType(h, "JobPosting");
    expect(more).toEqual([]);
    expect(ld).toMatchObject({
      title: "Meath employer Role", url: `${BASE}/jobs/${segOf("ld-employer")}`, hiringOrganization: { "@type": "Organization", name: "Pages Org" },
      description: "Made-up advert.\nSecond line &amp; &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
      jobLocation: { "@type": "Place", address: { addressRegion: "Meath", addressCountry: "IE" } }, baseSalary: { currency: "EUR", value: { value: 50000, unitText: "YEAR" } },
    });
    for (const k of ["datePosted", "validThrough"]) expect(new Date(ld![k] as string).toISOString(), k).toBe(ld![k]);
    expect(h).not.toContain("<script>alert(1)"); // the advert can neither close the script nor open one
    for (const source of ["agency", "fetched", "admin_manual"]) {
      const page = await jobPage(segOf(`ld-${source}`));
      expect(ofType(page, "JobPosting"), source).toEqual([]);
      expect(page, source).not.toContain("JobPosting");
      expect(ofType(page, "BreadcrumbList").map((b) => (b.itemListElement as { name: string; item?: string }[]).map((x) => [x.name, x.item])), source)
        .toEqual([[["Find a job", `${BASE}/jobs`], [`Meath ${source.replace("_", " ")} Role`, undefined]]]); // the sector crumb is a filtered search
    }
    expect(ofType(await jobPage(addressOf("ld-no-text", "Meath Textless Role", "Meath")), "JobPosting")).toEqual([]); // the description is required
  });
  it("a job that has closed loses its markup and is noindex, a 404 is noindex, and the read limit is not", async () => {
    await launched(async () => {
      const seg = addressOf("closed", "Closed Role", "Cork");
      expect((await jobMeta(seg)).robots).toEqual({ index: false, follow: false });
      expect(await jobPage(seg)).not.toContain("ld+json");
      for (const s of ["abc", "99999999", `x-${ids.draft}`]) expect((await jobMeta(s)).robots, s).toEqual({ index: false, follow: false });
      await su.query("update job set status = 'closed', close_reason = 'closed' where id = $1", [ids["ld-employer"]]);
      expect(await jobPage(segOf("ld-employer"))).not.toContain("JobPosting");
      const ip = freshIp();
      for (let i = 0; i < 62; i++) await jobMeta(segOf("ld-fetched"), ip);
      expect(await jobMeta(segOf("ld-fetched"), ip)).toEqual({ title: "Job" }); // a crawler told to slow down does not drop the job
    });
  });
});

describe("performance: statements and time of each page render, warm", () => {
  it("stays inside its budgets", async () => {
    const { cookie } = await login();
    const seg = addressOf("c6", "Page Cook c6", "Dublin");
    await search({}); await jobPage(seg); // warm: the rules are kept 5 minutes
    const out: Record<string, [number, number]> = {};
    const cases: [string, number, () => Promise<unknown>][] = [
      ["searchVisitor", BUDGET.searchVisitor, () => search({ county: "Cork" })],
      ["searchSignedIn", BUDGET.searchSignedIn, () => search({ county: "Cork" }, cookie)],
      ["jobVisitor", BUDGET.jobVisitor, () => jobPage(seg)],
      ["jobSignedIn", BUDGET.jobSignedIn, () => jobPage(seg, cookie)],
    ];
    for (const [name, budget, fn] of cases) {
      const [, stmts] = await counted(fn);
      const ms = await median(fn);
      out[name] = [stmts, ms];
      expect(stmts, `${name} statements`).toBeLessThanOrEqual(budget);
      expect(ms, `${name} median ms`).toBeLessThan(BUDGET.medianMs);
    }
    process.stderr.write("page renders (statements, median ms): " + Object.entries(out).map(([k, [s, m]]) => `${k} ${s} ${m.toFixed(1)}`).join(", ") + "\n");
  });
});
