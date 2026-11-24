// Integration: the content reads, the company page and the occupation page (src/content.ts, src/public-pages.ts, migration 0018), run on the real test
// database as app_candidate and app_portal, the roles that hold the view's select right. Fake names and numbers only; no outside service is called.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { importPermits, linkNames } from "../src/dete";
import { BadContentInput, getGuide, getHelp, listUpdates, UPDATES_PAGE } from "../src/content";
import { getCompanyPage, getOccupationPage, scopedJobs, type CompanyPage, type ListEntry } from "../src/public-pages";
import { BadSearchInput, PAGE_SIZE } from "../src/search";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

let db: TestDb;
let id: (prefix: string) => string;
let F: { org: (o?: Record<string, unknown>) => Promise<number> };
let su: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
let source: string;
beforeAll(async () => {
  db = await createTestDb();
  ({ id, F, su } = fixtures(db) as unknown as { id: typeof id; F: typeof F; su: typeof su });
  source = (await su("insert into job_source(kind, board) values ('portal', $1) returning id::text", [id("src")])).rows[0].id;
});
afterAll(() => db.drop());

const candidate = () => db.pool("app_candidate");
const portal = () => db.pool("app_portal");
const admin = () => db.pool("app_admin");
const NOW = new Date("2026-11-12T10:00:00Z");

async function page(o: { kind?: string; slug?: string; status?: string; at?: string; title?: string; body?: string } = {}) {
  const kind = o.kind ?? "update";
  const status = o.status ?? "published";
  const published = status === "published";
  return (await su(
    `insert into content_page(kind, slug, title, body, source_url, checked_on, status, published_at) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id::text`,
    [kind, o.slug ?? id("s"), o.title ?? id("T"), o.body ?? "Body text", kind === "help" || !published ? null : "https://enterprise.gov.ie/", kind === "help" || !published ? null : "2026-11-01",
     status, published || status === "withdrawn" ? (o.at ?? "2026-11-01 10:00:00+00") : null],
  )).rows[0].id as string;
}

describe("updates feed, guides and help pages", () => {
  it("shows published updates newest first, never drafts or withdrawn pages, never guides", async () => {
    const t = id("feed");
    await page({ title: `${t} old`, at: "2026-01-01 00:00:00+00" });
    await page({ title: `${t} new`, at: "2026-06-01 00:00:00+00" });
    await page({ title: `${t} draft`, status: "draft" });
    await page({ title: `${t} withdrawn`, status: "withdrawn", at: "2026-07-01 00:00:00+00" });
    await page({ title: `${t} guide`, kind: "guide", at: "2026-08-01 00:00:00+00" });
    for (const pool of [candidate(), portal()]) {
      const titles = (await listUpdates(pool)).updates.map((u) => u.title).filter((x) => x.startsWith(t));
      expect(titles).toEqual([`${t} new`, `${t} old`]);
    }
  });

  it("pages by published time and id with no page repeated or missed, including entries at the same instant", async () => {
    const t = id("pg");
    const made: string[] = [];
    for (let i = 0; i < UPDATES_PAGE * 2 + 5; i++) made.push(await page({ title: `${t}-${i}`, at: `2027-03-01 00:00:${String(Math.floor(i / 3)).padStart(2, "0")}.123456+00` }));
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const r = await listUpdates(candidate(), after);
      expect(r.updates.length).toBeLessThanOrEqual(UPDATES_PAGE);
      seen.push(...r.updates.filter((u) => u.title.startsWith(t)).map((u) => u.id));
      after = r.next ?? undefined;
      pages++;
    } while (after && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...made].reverse());
  });

  it("a guide and a help page are found by slug, only as their own kind, and only when published", async () => {
    const g = id("guide");
    const h = id("help");
    await page({ kind: "guide", slug: g, title: "A guide" });
    await page({ kind: "help", slug: h, title: "A help page" });
    await page({ kind: "guide", slug: `${g}-d`, status: "draft" });
    await page({ kind: "help", slug: `${h}-w`, status: "withdrawn" });
    for (const pool of [candidate(), portal()]) {
      expect(await getGuide(pool, g)).toMatchObject({ title: "A guide", kind: "guide", sourceUrl: "https://enterprise.gov.ie/", checkedOn: "2026-11-01" });
      expect(await getHelp(pool, h)).toMatchObject({ title: "A help page", sourceUrl: null, checkedOn: null });
      expect(await getHelp(pool, g)).toBeNull();
      expect(await getGuide(pool, h)).toBeNull();
      expect(await getGuide(pool, `${g}-d`)).toBeNull();
      expect(await getHelp(pool, `${h}-w`)).toBeNull();
      expect(await getGuide(pool, "no-such-page")).toBeNull();
    }
  });

  it("a page withdrawn after it was published disappears at once", async () => {
    const g = id("wd");
    const pid = await page({ kind: "guide", slug: g });
    expect(await getGuide(candidate(), g)).not.toBeNull();
    await su("update content_page set status = 'withdrawn' where id = $1", [pid]);
    expect(await getGuide(candidate(), g)).toBeNull();
  });

  it("hostile slugs and cursors are refused without a database error", async () => {
    for (const slug of ["", "A", "x'; drop table content_page; --", "a b", "a".repeat(101), "../etc", "\u0000", "é", "x\n"]) expect(await getGuide(candidate(), slug)).toBeNull();
    for (const bad of ["x", "!!!", "a".repeat(300), Buffer.from("{}").toString("base64url"), Buffer.from('{"t":"now","i":"1"}').toString("base64url"),
      Buffer.from('{"t":"2026-11-11 14:35:01+00","i":"1; drop table job"}').toString("base64url"), Buffer.from("null").toString("base64url")])
      await expect(listUpdates(candidate(), bad)).rejects.toBeInstanceOf(BadContentInput);
  });
});

describe("the occupation kind (migration 0018)", () => {
  it("is accepted with a four-digit slug and a source and date, and refused otherwise", async () => {
    const ok = await su("insert into content_page(kind, slug, title, body, source_url, checked_on, status, published_at) values ('occupation', '9101', 't', 'b', 'https://enterprise.gov.ie/', '2026-11-01', 'published', now()) returning id");
    expect(ok.rowCount).toBe(1);
    const refuse = (sql: string) => su(sql).then(() => "allowed", (e: { code: string }) => e.code);
    expect(await refuse("insert into content_page(kind, slug, title, body) values ('occupation', 'nurse', 't', 'b')")).toBe("23514");
    expect(await refuse("insert into content_page(kind, slug, title, body) values ('occupation', '91011', 't', 'b')")).toBe("23514");
    expect(await refuse("insert into content_page(kind, slug, title, body, status, published_at) values ('occupation', '9102', 't', 'b', 'published', now())")).toBe("23514"); // no source
    expect(await refuse("insert into content_page(kind, slug, title, body) values ('blog', '9103', 't', 'b')")).toBe("23514");
    expect(await refuse("insert into content_page(kind, slug, title, body) values ('occupation', '9101', 't', 'b')")).toBe("23505"); // one block per code
    expect(await refuse("insert into content_page(kind, slug, title, body) values ('guide', 'plain-slug', 't', 'b')")).toBe("allowed"); // other kinds keep free slugs
  });
  it("is written by app_admin only, and read through the view by candidate and portal", async () => {
    const wrote = await admin().query("insert into content_page(kind, slug, title, body) values ('occupation', '9104', 't', 'b')").then(() => "ok", (e) => e.code);
    expect(wrote).toBe("ok");
    for (const pool of [candidate(), portal()]) {
      const w = await pool.query("insert into content_page(kind, slug, title, body) values ('occupation', '9105', 't', 'b')").then(() => "allowed", (e) => e.code);
      expect(w).toBe("42501");
      expect((await pool.query("select 1 from content_page limit 1").then(() => "allowed", (e) => e.code))).toBe("42501");
    }
  });
});

// ===== jobs =====
let tick = 0;
async function addJob(org: number, o: { status?: string; code?: string | null; quota?: boolean; closes?: string; sector?: string } = {}) {
  const status = o.status ?? "live";
  const extra = status === "live" ? ", search_vector" : status === "hidden" ? ", hidden_reason" : status === "closed" ? ", close_reason" : "";
  const vals = status === "live" ? ", to_tsvector('english','cook')" : status === "hidden" ? ", 'admin'" : status === "closed" ? ", 'closed'" : "";
  const r = (await su(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, occupation_code, permit_type, badge, quota_full, status, closes_at, own_page_url${extra})
     values ($1, 'admin_manual', $2, $3, 'Fake Employer', $6, $4, 'critical_skills', 'critical_skills_eligible', $5, '${status}', ${o.closes ?? "now() + interval '20 days'"}, 'https://example.test/a'${vals}) returning id::text`,
    [org, source, id("Job"), o.code ?? null, o.quota ?? false, o.sector ?? "it"],
  )).rows[0];
  await su("update job set posted_at = timestamptz '2026-10-01 10:00:00+00' + $2::int * interval '1 microsecond' where id = $1", [r.id, ++tick]);
  return r.id as string;
}

const LISTS: ListEntry[] = [
  { code: "9201", title: "Fake Listed Role", list: "critical-skills" },
  { code: "9202", title: "Fake Barred Role", list: "ineligible" },
  { code: "9203", title: "Fake Listed Elsewhere", list: "critical-skills" },
  { code: "9203", title: "Fake Barred Elsewhere", list: "ineligible" },
];

describe("occupation page", () => {
  it("returns the list status, the minimums, the live jobs of that code only, and the published text block", async () => {
    const org = await F.org();
    const mine = [await addJob(org, { code: "9201" }), await addJob(org, { code: "9201" })];
    await addJob(org, { code: "9203" });
    await addJob(org, { code: "9201", status: "closed" });
    await addJob(org, { code: "9201", status: "draft" });
    await addJob(org, { code: "9201", status: "hidden" });
    await addJob(org, { code: "9201", closes: "now() - interval '1 day'" });
    await su("insert into content_page(kind, slug, title, body, source_url, checked_on, status, published_at) values ('occupation', '9201', 'About 9201', 'Registration body: fake', 'https://enterprise.gov.ie/', '2026-11-01', 'published', now())");
    await su("insert into content_page(kind, slug, title, body) values ('occupation', '9203', 'Draft block', 'not public')");
    const p = (await getOccupationPage(candidate(), "9201", { lists: LISTS }))!;
    expect(p.listStatus).toBe("critical-skills");
    expect(p.entries).toEqual([{ list: "critical-skills", title: "Fake Listed Role" }]);
    expect(p.minimums).toEqual({ withDegree: 40904, recentGraduate: 36848, graduateMonths: 12, withoutDegreeOrNotListed: 68911, minContractMonths: 24, basedOnWeekHours: 39 });
    expect(p.jobs.jobs.map((j) => j.id).sort()).toEqual([...mine].sort());
    expect(p.jobs.count).toEqual({ n: 2, more: false });
    // B7: each card carries its employer's page slug and logo (one statement for the page's employers)
    const own = (await su("select slug, logo_url from organisation where id = $1", [org])).rows[0];
    for (const j of p.jobs.jobs) expect(j).toMatchObject({ employerSlug: own.slug, employerLogoUrl: own.logo_url });
    expect(p.text).toMatchObject({ title: "About 9201", body: "Registration body: fake" });
    expect(p.standingLine).toMatch(/^Our check is guidance, not a permit decision. Only DETE decides. Rules last checked on 12 Nov 2026\.$/);
    const both = (await getOccupationPage(candidate(), "9203", { lists: LISTS }))!;
    expect(both.listStatus).toBe("critical-skills");
    expect(both.entries).toHaveLength(2);
    expect(both.text).toBeNull(); // a draft block is never shown
    expect(both.jobs.jobs).toHaveLength(1);
  });
  it("an ineligible code has no minimums; an unknown or hostile code is not found", async () => {
    expect((await getOccupationPage(candidate(), "9202", { lists: LISTS }))!.minimums).toBeNull();
    for (const code of ["9999", "", "92", "92011", "9201 ", "9201'; drop table job; --", "abcd", "٩٢٠١"]) expect(await getOccupationPage(candidate(), code, { lists: LISTS }), code).toBeNull();
    expect(await getOccupationPage(candidate(), "1122")).not.toBeNull(); // the real list file is wired in
    expect(await getOccupationPage(candidate(), "9201")).toBeNull();
  });
  it("pages the jobs with a cursor, full-quota jobs last, nothing repeated, and refuses a cursor made for another sort", async () => {
    const org = await F.org();
    const made: string[] = [];
    for (let i = 0; i < PAGE_SIZE + 7; i++) made.push(await addJob(org, { code: "9301", quota: i % 10 === 0 }));
    const first = await scopedJobs(candidate(), "occupation", "9301");
    expect(first.jobs).toHaveLength(PAGE_SIZE);
    expect(first.count).toEqual({ n: PAGE_SIZE + 7, more: false });
    const second = await scopedJobs(candidate(), "occupation", "9301", first.next!);
    expect(second.count).toBeNull();
    expect(second.next).toBeNull();
    const all = [...first.jobs, ...second.jobs];
    expect(new Set(all.map((j) => j.id)).size).toBe(PAGE_SIZE + 7);
    const plain = made.filter((_, i) => i % 10 !== 0);
    const full = made.filter((_, i) => i % 10 === 0);
    expect(all.map((j) => j.id)).toEqual([...plain.reverse(), ...full.reverse()]); // newest first, full-quota jobs last
    await expect(scopedJobs(candidate(), "occupation", "9301", "not-a-cursor")).rejects.toBeInstanceOf(BadSearchInput);
  });
});

// ===== the company page =====
async function company(o: { permits?: [number, number][]; permitHistory?: string; status?: string; names?: string[] } = {}) {
  const org = await F.org({ status: o.status ?? "verified" });
  const tag = id("co");
  const first = (await su("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, $2, 'legal', 'admin') returning id::text", [org, `${tag} Limited`])).rows[0].id as string;
  for (const n of o.names ?? []) await su("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, $2, 'alias', 'admin')", [org, `${tag} ${n}`]);
  if (o.permits) {
    await importPermits(admin(), o.permits.map(([y, p]) => ({ deteName: tag, year: y, permits: p, sourceFile: "f.xlsx" })));
    await linkNames(admin(), [{ organisationNameId: first, deteName: tag }]);
  }
  if (o.permitHistory) await su("update organisation set permit_history = $2 where id = $1", [org, o.permitHistory]);
  const slug = (await su("select slug from organisation where id = $1", [org])).rows[0].slug as string;
  return { org, tag, slug, first };
}
const asCompany = (r: unknown) => r as CompanyPage;

describe("company page", () => {
  it("shows every name, permits per year from 2019, peak, trend, labels, claimed badge and only its own live jobs", async () => {
    const c = await company({ permits: [[2018, 99], [2019, 3], [2023, 40], [2024, 10], [2025, 20]], names: ["Ireland", "Services"] });
    const other = await company({ permits: [[2024, 7]] });
    await su("update organisation set claimed_at = now() where id = $1", [c.org]);
    const mine = [await addJob(c.org), await addJob(c.org)];
    await addJob(c.org, { status: "closed" });
    await addJob(c.org, { status: "draft" });
    await addJob(other.org);
    {
      const p = asCompany(await getCompanyPage(candidate(), c.slug, { now: NOW }));
      expect(p.names.map((n) => n.name)).toEqual([`${c.tag} Limited`, `${c.tag} Ireland`, `${c.tag} Services`]);
      expect(p.permits).toEqual({ byYear: [{ year: 2019, permits: 3 }, { year: 2023, permits: 40 }, { year: 2024, permits: 10 }, { year: 2025, permits: 20 }], peakYear: 2023, trend: "up", latestMonth: null });
      expect(p.claimed).toBe(true);
      expect(p.jobs.jobs.map((j) => j.id).sort()).toEqual([...mine].sort());
      expect(p.jobs.count).toEqual({ n: 2, more: false });
      for (const j of p.jobs.jobs) expect(j).toMatchObject({ employerSlug: c.slug }); // B7: a company page knows its own slug and logo
      expect(JSON.stringify(p)).not.toContain(other.tag);
    }
  });
  it("labels: first-time sponsor, not linked yet, claims removed; nothing for an employer with history", async () => {
    const label = async (o: Parameters<typeof company>[0], extra?: string) => {
      const c = await company(o);
      if (extra) {
        // the strike-3 trigger guards this column; the label read is what is under test, so the trigger is switched off for this one statement
        const k = await db.pool("postgres").connect();
        try { await k.query("set session_replication_role = replica"); await k.query(extra, [c.org]); } finally { k.release(); }
      }
      return asCompany(await getCompanyPage(candidate(), c.slug)).labels;
    };
    expect(await label({ permitHistory: "first_time" })).toEqual(["First-time sponsor"]);
    expect(await label({ permitHistory: "not_linked" })).toEqual(["Permit history not linked yet"]);
    expect(await label({ permits: [[2024, 5]] })).toEqual([]);
    expect(await label({ permitHistory: "first_time" }, "update organisation set claims_removed_at = now() where id = $1")).toEqual(["First-time sponsor", "Sponsorship claims removed"]);
  });
  it("an unlinked company has permits null, which is not zero", async () => {
    const c = await company();
    expect(asCompany(await getCompanyPage(candidate(), c.slug)).permits).toBeNull();
  });
  it("a merged-away company answers with the slug it moved to", async () => {
    const target = await company();
    const gone = await company();
    await su("update organisation set merged_into_id = $2 where id = $1", [gone.org, target.org]);
    expect(await getCompanyPage(candidate(), gone.slug)).toEqual({ merged: target.slug });
    expect(await getCompanyPage(candidate(), target.slug)).toMatchObject({ slug: target.slug });
  });
  it("a rejected or closed company, an unknown slug and a hostile slug are not found; an unclaimed one is shown", async () => {
    for (const status of ["rejected", "closed"]) expect(await getCompanyPage(candidate(), (await company({ status })).slug)).toBeNull();
    const unclaimed = await company({ status: "unclaimed" });
    expect(asCompany(await getCompanyPage(candidate(), unclaimed.slug)).claimed).toBe(false);
    for (const slug of ["no-such-company", "", "X", "a'; drop table organisation; --", "a".repeat(101)]) expect(await getCompanyPage(candidate(), slug)).toBeNull();
  });
  it("jobs of a company with more than a page continue by cursor, and another company's cursor value cannot widen the scope", async () => {
    const c = await company();
    const o = await company();
    for (let i = 0; i < PAGE_SIZE + 3; i++) await addJob(c.org);
    await addJob(o.org);
    const p1 = asCompany(await getCompanyPage(candidate(), c.slug));
    expect(p1.jobs.jobs).toHaveLength(PAGE_SIZE);
    const p2 = asCompany(await getCompanyPage(candidate(), c.slug, { after: p1.jobs.next! }));
    expect(p2.jobs.jobs).toHaveLength(3);
    // the same cursor on the other company's page returns that company's rows only
    const q = asCompany(await getCompanyPage(candidate(), o.slug, { after: p1.jobs.next! }));
    expect(q.jobs.jobs.every((j) => j.employerName === "Fake Employer")).toBe(true);
    const ids = new Set(p1.jobs.jobs.concat(p2.jobs.jobs).map((j) => j.id));
    expect(q.jobs.jobs.some((j) => ids.has(j.id))).toBe(false);
  });
  it("never reads a staff-only column: the company page works under the candidate column grant", async () => {
    const c = await company();
    await expect(getCompanyPage(candidate(), c.slug)).resolves.not.toBeNull();
    const denied = await candidate().query("select cro_number from organisation limit 1").then(() => "allowed", (e) => e.code);
    expect(denied).toBe("42501");
  });
});

describe("migration 0018 index", () => {
  it("exists and serves the occupation read", async () => {
    const r = await su("select pg_get_indexdef(indexrelid) d from pg_index where indexrelid = 'job_live_occupation'::regclass");
    expect(r.rows[0].d).toContain("(occupation_code, ((NOT quota_full)) DESC, sponsor_sort DESC, posted_at DESC, id DESC) INCLUDE (quota_full, closes_at)");
    expect(r.rows[0].d).toContain("WHERE (status = 'live'::text)");
  });
});
