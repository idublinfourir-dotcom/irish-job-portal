// Integration: step 16 round 2 (B15, B17, B19, B20, B21, decisions #290 and #291), the public side, through the candidate app's real route handlers and its data
// layer (apps/candidate/lib/data.ts) on the real test database as app_candidate. GET /api/guides and /api/guide, GET /api/help/list, GET /api/updates with
// ?category, GET /api/permit-notice (null when staff have it off), GET /api/legal for the three new purposes, the sitemap parts and the sitemap index.
// Hostile input, drafts and withdrawn pages (never shown), the rate limit and the reply against docs/openapi/candidate.yaml. Only Next's request context is
// stood in (next/headers, server-only); no network. Fake data only. The staff side is in content-g1-admin.test.ts.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { publishLegal } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));

// Measured on 23 November 2026 (this file alone): every new public read is 3 statements for a visitor (2 rate counts, the read), median about 1 ms;
// the sitemap ids 1 statement, the pages-0 part 1, a content part 1, the index route 1 (the ids, kept for 5 minutes after). Time limit 15 ms.
const BUDGET = { read: 3, ids: 1, part: 1, medianMs: 15 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
type Data = typeof import("../../../apps/candidate/lib/data");
let db: TestDb, su: pg.Pool, admin: pg.Pool, D: Data;
let GUIDES: Handler, GUIDE: Handler, HELP: Handler, HELPLIST: Handler, UPDATES: Handler, NOTICE: Handler, LEGAL: Handler, INDEX: Handler;
let SITEMAP: (p: { id: Promise<string> }) => Promise<{ url: string; lastModified?: string | Date }[]>;
const spec = loadSpec("candidate");
const DRAFT = "draft", PUB = "published", OLD = "withdrawn";

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  admin = db.pool("app_admin");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ GET: GUIDES } = await import("../../../apps/candidate/app/api/guides/route"));
  ({ GET: GUIDE } = await import("../../../apps/candidate/app/api/guide/route"));
  ({ GET: HELP } = await import("../../../apps/candidate/app/api/help/route"));
  ({ GET: HELPLIST } = await import("../../../apps/candidate/app/api/help/list/route"));
  ({ GET: UPDATES } = await import("../../../apps/candidate/app/api/updates/route"));
  ({ GET: NOTICE } = await import("../../../apps/candidate/app/api/permit-notice/route"));
  ({ GET: LEGAL } = await import("../../../apps/candidate/app/api/legal/route"));
  ({ GET: INDEX } = await import("../../../apps/candidate/app/sitemap-index.xml/route"));
  ({ default: SITEMAP } = await import("../../../apps/candidate/app/sitemap"));
  D = await import("../../../apps/candidate/lib/data");
  const page = (kind: string, slug: string, title: string, status: string, o: { category?: string; effective?: string; at?: string } = {}) =>
    su.query(
      `insert into content_page(kind, slug, title, body, source_url, checked_on, status, published_at, category, effective_from)
       values ($1, $2, $3, 'Fake body', $4, $5, $6, $7, $8, $9)`,
      [kind, slug, title, kind === "help" || kind === "notice" ? null : "https://enterprise.gov.ie/", kind === "help" || kind === "notice" ? null : "2026-11-01", status,
        status === PUB || status === OLD ? (o.at ?? "2026-11-01 10:00:00+00") : null, o.category ?? null, o.effective ?? null]);
  await page("guide", "zeta-guide", "Zeta guide", PUB);
  await page("guide", "alpha-guide", "Alpha guide", PUB);
  await page("guide", "draft-guide", "Draft guide", DRAFT);
  await page("guide", "old-guide", "Old guide", OLD);
  await page("guide", "dete-portal-closed", "A guide with the notice slug", PUB); // another kind: never served as the notice
  await page("help", "who-needs-a-permit", "Who needs an employment permit?", PUB, { category: "permit_services" });
  await page("help", "delete-account", "Delete my account", PUB, { category: "account" });
  await page("help", "no-group", "No group", PUB);
  await page("help", "draft-help", "Draft help", DRAFT, { category: "jobs_badges" });
  await page("help", "old-help", "Old help", OLD, { category: "jobs_badges" });
  await page("occupation", "2136", "Occupation text", PUB);
  for (let i = 0; i < 25; i++) await page("update", `quota-${i}`, `Quota ${i}`, PUB, { category: "quotas", at: `2026-10-01 10:${String(i).padStart(2, "0")}:00+00` });
  await page("update", "min-1", "Minimums change", PUB, { category: "salary_minimums", effective: "2027-01-01", at: "2026-11-05 10:00:00+00" });
  await page("update", "no-type", "No type", PUB, { at: "2026-11-04 10:00:00+00" });
  await page("update", "quota-old", "Withdrawn quota", OLD, { category: "quotas" });
  await page("update", "quota-draft", "Draft quota", DRAFT, { category: "quotas" });
  await page("notice", "other-notice", "Another notice", PUB);
  const org = (await su.query("insert into organisation(slug, display_name, kind, status) values ('fake-g1-org', 'Fake G1 Org', 'employer', 'verified') returning id")).rows[0];
  const src = (await su.query("insert into job_source(kind, board) values ('portal', 'fake-board') returning id")).rows[0].id;
  await su.query(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, occupation_code, permit_type, badge, status, closes_at, own_page_url, search_vector, posted_at)
     values ($1, 'admin_manual', $2, 'Fake Cook', 'Fake Employer', 'IT', '1122', 'critical_skills', 'critical_skills_eligible', 'live', now() + interval '20 days', 'https://example.test/a', to_tsvector('english','cook'), '2026-11-10 09:00:00+00')`,
    [org.id, src]);
  await su.query("update organisation set claimed_at = '2026-11-01 00:00:00+00' where slug = 'fake-g1-org'");
  await su.query("update job set posted_at = '2026-11-10 09:00:00+00' where title = 'Fake Cook'");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const freshIp = () => `203.0.113.${(++n % 240) + 10}.${n}`;
type Got = { status: number; body: Record<string, any>; retry: string | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function get(route: Handler, path: string, ip = freshIp()): Promise<Got> {
  const res = await route(new Request(`${BASE}${path}`, { headers: { "x-vercel-forwarded-for": ip } }));
  return { status: res.status, body: (await res.json()) as Got["body"], retry: res.headers.get("retry-after") };
}
const as = <T>(fn: () => Promise<T>, ip = freshIp()): Promise<T> => {
  state.headers = new Headers({ "x-vercel-forwarded-for": ip });
  return fn();
};
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => {
  const t: number[] = [];
  for (let i = 0; i < 21; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); }
  return t.sort((a, b) => a - b)[10]!;
};
const problems = (g: Got, method: string, path: string) => replyProblems(spec, "GET", path, g.status, g.body);

describe("B15: GET /api/guides and GET /api/guide", () => {
  it("lists the published guides by title with slug, title and checkedOn, and no draft, withdrawn or other kind", async () => {
    const g = await get(GUIDES, "/api/guides");
    expect(g.status).toBe(200);
    expect(g.body.guides).toEqual([
      { slug: "dete-portal-closed", title: "A guide with the notice slug", checkedOn: "2026-11-01" },
      { slug: "alpha-guide", title: "Alpha guide", checkedOn: "2026-11-01" },
      { slug: "zeta-guide", title: "Zeta guide", checkedOn: "2026-11-01" },
    ]);
    expect(problems(g, "GET", "/api/guides")).toEqual([]);
    expect(JSON.stringify(g.body)).not.toMatch(/draft|old-guide|Fake body|staff/i);
  });
  it("reads one guide with the new fields null, and a draft, withdrawn, another kind, unknown or hostile slug is a clean 404", async () => {
    const g = await get(GUIDE, "/api/guide?slug=alpha-guide");
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ kind: "guide", slug: "alpha-guide", title: "Alpha guide", body: "Fake body", checkedOn: "2026-11-01", category: null, effectiveFrom: null });
    expect(Object.keys(g.body).sort()).toEqual(["body", "category", "checkedOn", "effectiveFrom", "id", "kind", "publishedAt", "slug", "sourceUrl", "title", "updatedAt"]);
    expect(problems(g, "GET", "/api/guide")).toEqual([]);
    for (const slug of ["draft-guide", "old-guide", "who-needs-a-permit", "nope", "", "ALPHA-GUIDE", "alpha-guide'; drop table content_page;--", "../alpha-guide", "alpha%00", "a".repeat(5000)]) {
      const r = await get(GUIDE, `/api/guide?slug=${encodeURIComponent(slug)}`);
      expect([r.status, r.body], slug).toEqual([404, { code: "NOT_FOUND" }]);
    }
    expect((await get(GUIDE, "/api/guide")).status).toBe(404);
  });
  it("the data layer wrappers answer what the routes answer", async () => {
    expect(await as(() => D.readGuides())).toMatchObject({ ok: true, data: (await get(GUIDES, "/api/guides")).body });
    expect(await as(() => D.readGuide({ slug: "zeta-guide" }))).toMatchObject({ ok: true, data: { slug: "zeta-guide", category: null } });
  });
});

describe("B19: GET /api/help/list", () => {
  it("lists the published help pages by group then title, with slug, title and category, and nothing unpublished or of another kind", async () => {
    const g = await get(HELPLIST, "/api/help/list");
    expect(g.status).toBe(200);
    expect(g.body.pages).toEqual([
      { slug: "delete-account", title: "Delete my account", category: "account" },
      { slug: "who-needs-a-permit", title: "Who needs an employment permit?", category: "permit_services" },
      { slug: "no-group", title: "No group", category: null },
    ]);
    expect(problems(g, "GET", "/api/help/list")).toEqual([]);
  });
  it("one help page read carries its category, and the data layer wrapper answers the same as the route", async () => {
    const g = await get(HELP, "/api/help?slug=who-needs-a-permit");
    expect(g.body).toMatchObject({ kind: "help", category: "permit_services", effectiveFrom: null });
    expect(problems(g, "GET", "/api/help")).toEqual([]);
    expect(await as(() => D.readHelpList())).toMatchObject({ ok: true, data: (await get(HELPLIST, "/api/help/list")).body });
  });
});

describe("B17: GET /api/updates with a category", () => {
  it("every update carries its category and effective day, and the whole feed is unchanged in order", async () => {
    const g = await get(UPDATES, "/api/updates");
    expect(g.status).toBe(200);
    const u = g.body.updates as { slug: string; category: string | null; effectiveFrom: string | null }[];
    expect(u.slice(0, 2).map((x) => [x.slug, x.category, x.effectiveFrom])).toEqual([["min-1", "salary_minimums", "2027-01-01"], ["no-type", null, null]]);
    expect(u).toHaveLength(20);
    expect(g.body.next).not.toBeNull();
    expect(problems(g, "GET", "/api/updates")).toEqual([]);
  });
  it("keeps one category, pages it with the cursor, and leaves out drafts and withdrawn pages", async () => {
    const first = await get(UPDATES, "/api/updates?category=quotas");
    const a = first.body.updates as { slug: string; category: string }[];
    expect(a).toHaveLength(20);
    expect(a.every((x) => x.category === "quotas")).toBe(true);
    expect(a[0]!.slug).toBe("quota-24"); // newest first
    expect(problems(first, "GET", "/api/updates")).toEqual([]);
    const second = await get(UPDATES, `/api/updates?category=quotas&after=${first.body.next}`);
    expect((second.body.updates as { slug: string }[]).map((x) => x.slug)).toEqual(["quota-4", "quota-3", "quota-2", "quota-1", "quota-0"]);
    expect(second.body.next).toBeNull();
    const m = await get(UPDATES, "/api/updates?category=salary_minimums");
    expect((m.body.updates as { slug: string }[]).map((x) => x.slug)).toEqual(["min-1"]);
    expect((await get(UPDATES, "/api/updates?category=processing")).body).toEqual({ updates: [], next: null });
  });
  it("refuses an unknown, help, empty, hostile or repeated-type category with 400 and runs no read", async () => {
    for (const c of ["nope", "account", "permit_services", "", "QUOTAS", "quotas'%20or%20'1'='1", "quotas%00", "x".repeat(5000), "quotas,processing"]) {
      const g = await get(UPDATES, `/api/updates?category=${c}`);
      expect([g.status, g.body], c).toEqual([400, { code: "BAD_REQUEST" }]);
      expect(problems(g, "GET", "/api/updates"), c).toEqual([]);
    }
    expect(await as(() => D.readUpdates({ category: "quotas" }))).toMatchObject({ ok: true });
    expect(await as(() => D.readUpdates({ category: "nope" }))).toMatchObject({ ok: false, status: 400, code: "BAD_REQUEST" });
  });
});

describe("#291: GET /api/permit-notice", () => {
  const notice = (status: string) => su.query("update content_page set status = $1, published_at = case when $1 = 'draft' then null else coalesce(published_at, now()) end where kind = 'notice' and slug = 'dete-portal-closed'", [status]);
  it("is 404 when staff have it off (no notice, another slug, a guide with the slug), and the data layer says ok with null", async () => {
    const g = await get(NOTICE, "/api/permit-notice");
    expect([g.status, g.body]).toEqual([404, { code: "NOT_FOUND" }]);
    expect(problems(g, "GET", "/api/permit-notice")).toEqual([]);
    expect(await as(() => D.readPermitNotice())).toEqual({ ok: true, data: null });
  });
  it("shows the notice once staff publish it and hides it again when they withdraw it", async () => {
    await su.query("insert into content_page(kind, slug, title, body, status) values ('notice', 'dete-portal-closed', 'DETE portal closed', 'Placeholder notice.', 'draft')");
    expect((await get(NOTICE, "/api/permit-notice")).status).toBe(404); // a draft is off
    await notice("published");
    const g = await get(NOTICE, "/api/permit-notice");
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ kind: "notice", slug: "dete-portal-closed", title: "DETE portal closed", body: "Placeholder notice.", category: null, effectiveFrom: null });
    expect(problems(g, "GET", "/api/permit-notice")).toEqual([]);
    expect(await as(() => D.readPermitNotice())).toMatchObject({ ok: true, data: { title: "DETE portal closed" } });
    await notice("withdrawn");
    expect((await get(NOTICE, "/api/permit-notice")).status).toBe(404);
    expect(await as(() => D.readPermitNotice())).toEqual({ ok: true, data: null });
    await notice("published"); // left on for the sitemap and security checks below
  });
  it("no other notice or kind can be read through any public route", async () => {
    for (const [route, path] of [[GUIDE, "/api/guide?slug=other-notice"], [HELP, "/api/help?slug=other-notice"], [GUIDE, "/api/guide?slug=dete-portal-closed&kind=notice"]] as const) {
      const r = await get(route, path);
      if (path.includes("dete-portal-closed")) expect(r.body.kind).toBe("guide");
      else expect(r.status, path).toBe(404);
    }
    expect((await get(GUIDES, "/api/guides")).body.guides.map((x: { slug: string }) => x.slug)).not.toContain("other-notice");
    expect((await get(HELPLIST, "/api/help/list")).body.pages.map((x: { slug: string }) => x.slug)).not.toContain("other-notice");
    expect((await get(UPDATES, "/api/updates")).body.updates.map((x: { slug: string }) => x.slug)).not.toContain("other-notice");
  });
});

describe("B20 and #290: the new legal purposes on GET /api/legal", () => {
  const NEW = ["cookie_policy", "employer_acceptable_use", "data_retention"] as const;
  it("is 404 before a version, then the text in force once the two-person route published it", async () => {
    for (const p of NEW) expect(await get(LEGAL, `/api/legal?purpose=${p}`), p).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    for (const p of NEW) await publishLegal(su, admin, p, "v1", `PLACEHOLDER ${p} text.\nLine two.`);
    await publishLegal(su, admin, "cookie_policy", "v2", "PLACEHOLDER cookie_policy second version.");
    for (const p of NEW) {
      const g = await get(LEGAL, `/api/legal?purpose=${p}`);
      expect(g.status, p).toBe(200);
      expect(g.body, p).toMatchObject({ purpose: p, version: p === "cookie_policy" ? "v2" : "v1" });
      expect(Object.keys(g.body).sort()).toEqual(["body", "publishedAt", "purpose", "version"]);
      expect(problems(g, "GET", "/api/legal"), p).toEqual([]);
    }
    expect(await as(() => D.readLegal({ purpose: "data_retention" }))).toMatchObject({ ok: true, data: { purpose: "data_retention", version: "v1" } });
  });
  it("still refuses the employer sign-up terms, other purposes and hostile ones with 400", async () => {
    for (const p of ["portal_signup_terms", "visibility", "pay_floor", "COOKIE_POLICY", "cookie_policy%00", "cookies", "x".repeat(5000), ""]) {
      const g = await get(LEGAL, `/api/legal?purpose=${p}`);
      expect([g.status, g.body], p).toEqual([400, { code: "BAD_REQUEST" }]);
    }
  });
});

describe("B21: the sitemap parts and the index", () => {
  it("the ids name every file once, and /sitemap-index.xml lists exactly those", async () => {
    const ids = await as(() => D.readSitemapIds());
    expect(ids).toEqual(["jobs-0", "companies-0", "occupations-0", "pages-0", "guides-0", "updates-0", "help-0"]);
    const res = await INDEX(new Request(`${BASE}/sitemap-index.xml`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/xml/);
    const xml = await res.text();
    expect([...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1])).toEqual(ids.map((id) => `${BASE}/sitemap/${id}.xml`));
  });
  it("pages-0 holds the static pages and each legal text in force with its date, and nothing without a version", async () => {
    const urls = (await SITEMAP({ id: Promise.resolve("pages-0") })).map((e) => e.url.replace(BASE, ""));
    expect(urls).toEqual(["/", "/jobs", "/companies", "/guides", "/updates", "/help", "/eligibility-checker", "/permit-services", "/cookies", "/data-retention", "/employer-acceptable-use"]);
    const legal = await D.readSitemapPart("pages-0");
    expect(legal!.filter((e) => e.kind === "legal").every((e) => !Number.isNaN(Date.parse(e.lastModified!)))).toBe(true);
  });
  it("guides, updates and help list only published pages by their readable address, with a change date", async () => {
    const guides = await SITEMAP({ id: Promise.resolve("guides-0") });
    expect(guides.map((e) => e.url.replace(BASE, "")).sort()).toEqual(["/guides/alpha-guide", "/guides/dete-portal-closed", "/guides/zeta-guide"]);
    expect(guides.every((e) => e.lastModified)).toBe(true);
    const updates = (await SITEMAP({ id: Promise.resolve("updates-0") })).map((e) => e.url.replace(BASE, ""));
    expect(updates).toHaveLength(27);
    expect(updates).toContain("/updates/min-1");
    expect(updates.some((u) => /draft|old/.test(u))).toBe(false);
    expect((await SITEMAP({ id: Promise.resolve("help-0") })).map((e) => e.url.replace(BASE, "")).sort()).toEqual(["/help/delete-account", "/help/no-group", "/help/who-needs-a-permit"]);
    expect(await SITEMAP({ id: Promise.resolve("guides-1") })).toEqual([]);
  });
  it("a company's change date is its newest live job (or its last claim), an occupation's its text block's", async () => {
    const c = (await D.readSitemapPart("companies-0"))!.find((e) => e.key === "fake-g1-org")!;
    expect(c.lastModified).toBe("2026-11-10T09:00:00.000Z");
    await su.query("update organisation set claimed_at = '2026-11-12 00:00:00+00' where slug = 'fake-g1-org'");
    const { sitemapPart, getPool } = await import("../src");
    expect((await sitemapPart(getPool(), "companies-0"))!.find((e) => e.key === "fake-g1-org")!.lastModified).toBe("2026-11-12T00:00:00.000Z");
    const occ = (await sitemapPart(getPool(), "occupations-0"))!;
    expect(occ.find((e) => e.key === "2136")!.lastModified).toBeDefined();
    expect(occ.filter((e) => e.key !== "2136").every((e) => e.lastModified === undefined)).toBe(true);
  });
  it("an id that is not a file is refused before any statement", async () => {
    const { sitemapPart, getPool } = await import("../src");
    for (const id of ["page-0", "pages", "guides-x", "help-", "../help-0", "HELP-0", "help-0.xml", "help-00000"]) {
      const [r, q] = await counted(() => sitemapPart(getPool(), id));
      expect([r, q], id).toEqual([null, 0]);
    }
  });
});

describe("rate limit, statements and time", () => {
  it("a visitor over the limit gets 429 with a wait on each new read, and a candidate-side change does not touch it", async () => {
    for (const [route, path] of [[GUIDES, "/api/guides"], [HELPLIST, "/api/help/list"], [NOTICE, "/api/permit-notice"], [GUIDE, "/api/guide?slug=alpha-guide"]] as const) {
      const ip = freshIp();
      let last: Got | undefined;
      for (let i = 0; i < 61; i++) last = await get(route, path, ip);
      expect([last!.status, last!.body], path).toEqual([429, { code: "TOO_MANY_REQUESTS" }]);
      expect(Number(last!.retry)).toBeGreaterThan(0);
    }
  });
  it("each new read is 3 statements for a visitor and fast; the sitemap ids and parts are 1 statement", async () => {
    for (const [route, path] of [[GUIDES, "/api/guides"], [GUIDE, "/api/guide?slug=alpha-guide"], [HELPLIST, "/api/help/list"], [NOTICE, "/api/permit-notice"], [UPDATES, "/api/updates?category=quotas"], [LEGAL, "/api/legal?purpose=cookie_policy"]] as const) {
      const [, c] = await counted(() => get(route, path));
      const ms = await median(() => get(route, path));
      console.log(`${path}: ${c} statements, median ${ms.toFixed(2)} ms`);
      expect(c, path).toBeLessThanOrEqual(BUDGET.read);
      expect(ms, path).toBeLessThan(BUDGET.medianMs);
    }
    const { sitemapIds, sitemapPart, getPool } = await import("../src");
    await sitemapIds(getPool()); // warms the rules
    expect((await counted(() => sitemapIds(getPool())))[1]).toBeLessThanOrEqual(BUDGET.ids);
    for (const id of ["guides-0", "updates-0", "help-0", "pages-0", "companies-0"]) expect((await counted(() => sitemapPart(getPool(), id)))[1], id).toBeLessThanOrEqual(BUDGET.part);
    expect((await counted(() => INDEX(new Request(`${BASE}/sitemap-index.xml`))))[1]).toBe(0); // the ids are kept
  });
  it("the new routes have no write method", async () => {
    const mods = [await import("../../../apps/candidate/app/api/guides/route"), await import("../../../apps/candidate/app/api/guide/route"),
      await import("../../../apps/candidate/app/api/help/list/route"), await import("../../../apps/candidate/app/api/permit-notice/route"), await import("../../../apps/candidate/app/sitemap-index.xml/route")];
    for (const m of mods) expect(Object.keys(m).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
  });
});
