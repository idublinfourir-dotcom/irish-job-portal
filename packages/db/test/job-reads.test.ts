// Integration: the Search module's two reads (src/search.ts) and the sponsor sort key (migration 0008), run on the real test database as
// app_candidate. Fake names and fake numbers only.
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { importPermits, linkNames } from "../src/dete";
import { BadSearchInput, COUNT_CAP, decodeCursor, encodeCursor, getJob, listJobs, PAGE_SIZE, RULES_CHECKED_ON, SORTS, type JobList, type Sort } from "../src/search";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

const YEAR = new Date().getUTCFullYear();
const BASE = "2026-10-01 10:00:00+00";

let db: TestDb;
let id: (prefix: string) => string;
let F: { org: () => Promise<number> };
let su: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
let source: string;
beforeAll(async () => {
  db = await createTestDb();
  ({ id, F, su } = fixtures(db) as unknown as { id: typeof id; F: typeof F; su: typeof su });
  source = (await su("insert into job_source(kind, board) values ('portal', $1) returning id::text", [id("src")])).rows[0].id;
  // a pay scales version (the rules are cached per process, so it goes in before the first read)
  const c = await db.pool("postgres").connect();
  try {
    await c.query("begin");
    await c.query("set local role portal_owner");
    await c.query("insert into rules_version(kind, data, effective_from, seeded_by_owner) values ('pay_scales', $1::jsonb, '2026-06-01', true)", [readFileSync(new URL("../../rules/data/pay-scales-v1.json", import.meta.url), "utf8")]);
    await c.query("commit");
  } finally { c.release(); }
});
afterAll(() => db.drop());

const candidate = () => db.pool("app_candidate");
const admin = () => db.pool("app_admin");

type Made = { id: string; org: number; key: number; k: number; quota: boolean; salary: number | null };
let tick = 0;

/** One job for an organisation as postgres. `k` is its posted time, in microseconds after BASE, so neighbours differ only by microseconds. */
async function addJob(org: number, o: { status?: string; k?: number; quota?: boolean; salary?: number | null; closes?: string; text?: string; badge?: string | null; source?: string } = {}): Promise<Made> {
  const status = o.status ?? "live";
  const k = o.k ?? ++tick;
  const extra =
    status === "live" || status === "under_review" ? ", search_vector" : status === "hidden" ? ", hidden_reason" : status === "closed" ? ", close_reason" : "";
  const vals = status === "live" || status === "under_review" ? ", to_tsvector('english','cook')" : status === "hidden" ? ", 'admin'" : status === "closed" ? ", 'closed'" : "";
  const closes = o.closes ?? "now() + interval '20 days'";
  const r = (await su(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, badge, salary_low, salary_high, quota_full, status, closes_at, own_page_url${extra})
     values ($1, 'admin_manual', $2, $3, 'Fake Employer', 'it', 'critical_skills', $4, $5, $5, $6, '${status}', ${closes}, 'https://example.test/a'${vals}) returning id::text`,
    [org, o.source ?? source, id("Cook"), o.badge === undefined ? "critical_skills_eligible" : o.badge, o.salary ?? null, o.quota ?? false],
  )).rows[0];
  // posted_at is set by a trigger on the move into live, so it is written after (it is not a status change)
  await su(`update job set posted_at = timestamptz '${BASE}' + $2::int * interval '1 microsecond' where id = $1`, [r.id, k]);
  if (o.text !== undefined) await su("insert into job_text(job_id, advert_text) values ($1, $2)", [r.id, o.text]);
  const j = (await su("select sponsor_sort from job where id = $1", [r.id])).rows[0];
  return { id: r.id, org, key: j.sponsor_sort, k, quota: o.quota ?? false, salary: o.salary ?? null };
}

/** An organisation with one name and DETE rows linked to it through the real import and link code. */
async function employer(rows: [year: number, permits: number][] | null) {
  const org = await F.org();
  const tag = id("jr");
  const nameId = (await su("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, $2, 'alias', 'admin') returning id::text", [org, tag])).rows[0].id as string;
  if (rows) {
    await importPermits(admin(), rows.map(([y, p]) => ({ deteName: tag, year: y, permits: p, sourceFile: "f.xlsx" })));
    await linkNames(admin(), [{ organisationNameId: nameId, deteName: tag }]);
  }
  return { org, tag, nameId };
}

const keyOf = async (org: number) => (await su("select sponsor_sort from organisation where id = $1", [org])).rows[0].sponsor_sort as number;
const ids = (l: JobList) => l.jobs.map((j) => j.id);

/** The order the design asks for, worked out in JavaScript from what was inserted. */
function expected(sort: Sort, jobs: Made[]): string[] {
  const num = (m: Made) => (sort === "salary" ? (m.salary ?? 0) : sort === "sponsor" ? m.key : 0);
  return [...jobs]
    .sort((a, b) => Number(a.quota) - Number(b.quota) || num(b) - num(a) || (sort === "salary" ? 0 : b.k - a.k) || (BigInt(b.id) < BigInt(a.id) ? -1 : BigInt(b.id) > BigInt(a.id) ? 1 : 0))
    .map((m) => m.id);
}

/** Every page from the first on, by next. */
async function walk(sort: Sort): Promise<JobList[]> {
  const pages = [await listJobs(candidate(), { sort })];
  while (pages.at(-1)!.next) pages.push(await listJobs(candidate(), { sort, after: pages.at(-1)!.next! }));
  return pages;
}

describe("the sponsor key", () => {
  it("is the permits of the last 5 calendar years, -1 with no confirmed link, 0 when linked with none in the window", async () => {
    const a = await employer([[YEAR, 30], [YEAR - 4, 20], [YEAR - 5, 100]]); // 2 inside, 1 outside
    const none = await employer([[YEAR - 5, 7]]);
    const unlinked = await employer(null);
    expect(await keyOf(a.org)).toBe(50);
    expect(await keyOf(none.org)).toBe(0);
    expect(await keyOf(unlinked.org)).toBe(-1);
  });

  it("is copied onto a new job, and onto the open jobs of the employer when a DETE import or a link change moves it", async () => {
    const e = await employer(null);
    const open = await addJob(e.org);
    const closed = await addJob(e.org, { status: "closed" });
    expect([open.key, closed.key]).toEqual([-1, -1]);

    await importPermits(admin(), [{ deteName: e.tag, year: YEAR, permits: 12, sourceFile: "f.xlsx" }]);
    expect((await linkNames(admin(), [{ organisationNameId: e.nameId, deteName: e.tag }])).labelsChanged).toBe(1);
    const key = async (j: Made) => (await su("select sponsor_sort from job where id = $1", [j.id])).rows[0].sponsor_sort as number;
    expect(await key(open)).toBe(12);
    expect(await key(closed)).toBe(-1); // a closed job keeps what it had
    expect((await addJob(e.org)).key).toBe(12); // a job inserted later copies it

    // a later import with a bigger figure for the same year moves it again
    await importPermits(admin(), [{ deteName: e.tag, year: YEAR, permits: 20, sourceFile: "g.xlsx" }]);
    expect(await key(open)).toBe(20);
    expect(await listJobs(candidate(), { sort: "sponsor" }).then((l) => l.jobs.find((j) => j.id === open.id)?.sponsorPermits)).toBe(20);

    // the link moves to another employer's name row: the first employer is unlinked again, the other takes the 20
    const other = await employer(null);
    await linkNames(admin(), [{ organisationNameId: other.nameId, deteName: e.tag }]);
    expect(await keyOf(e.org)).toBe(-1);
    expect(await keyOf(other.org)).toBe(20);
    expect(await key(open)).toBe(-1);
  });

  it("sorts live jobs of an employer with permits above those with none and those with no link", async () => {
    const hi = await employer([[YEAR, 900]]);
    const lo = await employer([[YEAR, 800]]);
    const linkedNone = await employer([[YEAR - 5, 5]]);
    const unl = await employer(null);
    const made = [await addJob(unl.org), await addJob(linkedNone.org), await addJob(lo.org), await addJob(hi.org)];
    const top = (await listJobs(candidate(), { sort: "sponsor" })).jobs.map((j) => j.id).filter((i) => made.some((m) => m.id === i));
    expect(top).toEqual([made[3]!.id, made[2]!.id, made[1]!.id, made[0]!.id]);
  });
});

describe("visibility", () => {
  it("never returns a queued, draft, closed, expired, hidden or under-review job, for each sort and for one job", async () => {
    const e = await employer([[YEAR, 40]]);
    const live = await addJob(e.org);
    const other: Record<string, Made> = {
      draft: await addJob(e.org, { status: "draft" }),
      queued: await addJob(e.org, { status: "in_review" }),
      under_review: await addJob(e.org, { status: "under_review" }),
      hidden: await addJob(e.org, { status: "hidden" }),
      closed: await addJob(e.org, { status: "closed" }),
      expired: await addJob(e.org, { closes: "now() - interval '1 day'" }), // still live in the table, past its end
    };
    expect((await su("select status from job where id = $1", [other.expired!.id])).rows[0].status).toBe("live");
    for (const sort of SORTS) {
      const all = (await walk(sort)).flatMap(ids);
      expect(all).toContain(live.id);
      for (const [name, j] of Object.entries(other)) expect(all, `${sort}: ${name}`).not.toContain(j.id);
    }
    expect(await getJob(candidate(), live.id)).toMatchObject({ id: live.id });
    for (const [name, j] of Object.entries(other)) expect(await getJob(candidate(), j.id), name).toBeNull();
    expect(await getJob(candidate(), "999999999999")).toBeNull();
  });

  it("a job drops out of the list and the page as soon as it is hidden, and a job with closes_at at infinity stays", async () => {
    const e = await employer(null);
    const forever = await addJob(e.org, { closes: "'infinity'" });
    const gone = await addJob(e.org);
    expect(await getJob(candidate(), forever.id)).toMatchObject({ closesAt: null });
    await su("update job set status = 'hidden', hidden_reason = 'admin' where id = $1", [gone.id]);
    expect(await getJob(candidate(), gone.id)).toBeNull();
    expect((await walk("newest")).flatMap(ids)).not.toContain(gone.id);
    expect((await walk("newest")).flatMap(ids)).toContain(forever.id);
  });
});

describe("the three sorts, their tie order and paging", () => {
  let all: Made[];
  beforeAll(async () => {
    // a fresh database, so the fifty-odd jobs below are the only live ones
    const own = await createTestDb();
    const f = fixtures(own) as unknown as { id: typeof id; F: typeof F; su: typeof su };
    const src = (await f.su("insert into job_source(kind, board) values ('portal', $1) returning id::text", [f.id("src")])).rows[0].id;
    const orgs = [] as { org: number; tag: string; nameId: string }[];
    for (const permits of [50, 50, 10, null, 0]) {
      const org = await f.F.org();
      const tag = f.id("pg");
      const nameId = (await f.su("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, $2, 'alias', 'admin') returning id::text", [org, tag])).rows[0].id as string;
      if (permits !== null) {
        await importPermits(own.pool("app_admin"), [{ deteName: tag, year: permits === 0 ? YEAR - 5 : YEAR, permits: permits === 0 ? 3 : permits, sourceFile: "f.xlsx" }]);
        await linkNames(own.pool("app_admin"), [{ organisationNameId: nameId, deteName: tag }]);
      }
      orgs.push({ org, tag, nameId });
    }
    all = [];
    for (let i = 0; i < 53; i++) {
      const org = orgs[i % 5]!.org;
      // times collide on purpose (i % 11), salaries too, and a few jobs are full-quota
      const r = (await f.su(
        `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, badge, salary_low, salary_high, quota_full, status, closes_at, own_page_url, search_vector)
         values ($1, 'admin_manual', $2, $3, 'Fake Employer', 'it', 'critical_skills', 'critical_skills_eligible', $4, $4, $5, 'live', now() + interval '20 days', 'https://example.test/a', to_tsvector('english','cook')) returning id::text`,
        [org, src, f.id("Cook"), i % 7 === 3 ? null : (i % 6) * 10000, i % 13 === 0],
      )).rows[0];
      const k = (i % 11) * 3 + 1;
      await f.su(`update job set posted_at = timestamptz '${BASE}' + $2::int * interval '1 microsecond' where id = $1`, [r.id, k]);
      const key = (await f.su("select sponsor_sort from job where id = $1", [r.id])).rows[0].sponsor_sort as number;
      all.push({ id: r.id, org, key, k, quota: i % 13 === 0, salary: i % 7 === 3 ? null : (i % 6) * 10000 });
    }
    pool = own.pool("app_candidate");
    dropOwn = () => own.drop();
  });
  let pool: pg.Pool;
  let dropOwn: () => Promise<void>;
  afterAll(() => dropOwn());

  it("has the sponsor values the test means to use", () => {
    expect([...new Set(all.map((m) => m.key))].sort((a, b) => b - a)).toEqual([50, 10, 0, -1]);
  });

  it.each(SORTS)("%s: the pages in order are exactly the design's order, with ties broken by id", async (sort) => {
    const pages: JobList[] = [await listJobs(pool, { sort })];
    while (pages.at(-1)!.next) pages.push(await listJobs(pool, { sort, after: pages.at(-1)!.next! }));
    expect(pages.map((p) => p.jobs.length)).toEqual([PAGE_SIZE, PAGE_SIZE, all.length - 2 * PAGE_SIZE]);
    expect(pages.flatMap(ids)).toEqual(expected(sort, all));
    expect(pages[0]!.count).toEqual({ n: all.length, more: false });
    expect(pages.slice(1).map((p) => p.count)).toEqual([null, null]);
    expect(pages[0]!.previous).toBeNull();
    expect(pages.at(-1)!.next).toBeNull();
  });

  it.each(SORTS)("%s: previous pages give back the same pages, no gap and no repeat", async (sort) => {
    const forward: JobList[] = [await listJobs(pool, { sort })];
    while (forward.at(-1)!.next) forward.push(await listJobs(pool, { sort, after: forward.at(-1)!.next! }));
    // from the last page back to the first
    const back: JobList[] = [forward.at(-1)!];
    while (back.at(-1)!.previous) back.push(await listJobs(pool, { sort, before: back.at(-1)!.previous! }));
    expect(back.map(ids).reverse()).toEqual(forward.map(ids));
    expect(back.at(-1)!.previous).toBeNull(); // the first page reached backwards has nothing before it
    // next then previous lands on the page it left
    const second = await listJobs(pool, { sort, after: forward[0]!.next! });
    expect(ids(await listJobs(pool, { sort, before: second.previous! }))).toEqual(ids(forward[0]!));
    // a page reached backwards still knows its next page
    expect(ids(await listJobs(pool, { sort, after: back[1]!.next! }))).toEqual(ids(forward[2]!));
  });

  it("the sponsor sort puts permits first, then newest, and employers with no link after the rest, quota last", async () => {
    const jobs = (await walk2("sponsor")).filter((m) => !m.quota);
    const keys = jobs.map((m) => m.key);
    expect(keys).toEqual([...keys].sort((a, b) => b - a));
    const last = jobs.filter((m) => m.key === -1);
    expect(jobs.slice(-last.length).map((m) => m.id)).toEqual(last.map((m) => m.id));
    const quotaTail = (await walk2("sponsor")).slice(-all.filter((m) => m.quota).length);
    expect(quotaTail.every((m) => m.quota)).toBe(true);
  });
  const walk2 = async (sort: Sort) => {
    const byId = new Map(all.map((m) => [m.id, m]));
    const pages: JobList[] = [await listJobs(pool, { sort })];
    while (pages.at(-1)!.next) pages.push(await listJobs(pool, { sort, after: pages.at(-1)!.next! }));
    return pages.flatMap(ids).map((i) => byId.get(i)!);
  };

  it("a card carries what it shows", async () => {
    const l = await listJobs(pool, { sort: "sponsor" });
    const first = l.jobs[0]!;
    const made = all.find((m) => m.id === first.id)!;
    expect(first).toMatchObject({ employerName: "Fake Employer", badge: "critical_skills_eligible", quotaFull: false, sponsorPermits: made.key > 0 ? made.key : null });
    expect(first.salaryLine).toBe(made.salary === null ? null : `€${new Intl.NumberFormat("en-IE").format(made.salary)}`);
    expect(first.postedAt).toBeInstanceOf(Date);
    expect(Object.keys(first).sort()).not.toContain("advertText");
  });

  it("a cursor from the end of one sort cannot be used on another, and the default sort is sponsor", async () => {
    const n = (await listJobs(pool, { sort: "newest" })).next!;
    await expect(listJobs(pool, { sort: "salary", after: n })).rejects.toThrow(BadSearchInput);
    await expect(listJobs(pool, { sort: "sponsor", before: n })).rejects.toThrow(BadSearchInput);
    expect(ids(await listJobs(pool))).toEqual(ids(await listJobs(pool, { sort: "sponsor" })));
  });

  it("a hand-made cursor with extreme values returns only live jobs and never an error", async () => {
    const edge = (sort: Sort, keys: string[], id: string, quotaFull: boolean) => encodeCursor({ sort, quotaFull, keys, id });
    const far = edge("sponsor", ["2147483647", "2999-01-01 00:00:00+00"], "9223372036854775807", false);
    const near = edge("sponsor", ["-1", "1970-01-01 00:00:00+00"], "1", true);
    const liveIds = new Set(all.map((m) => m.id));
    for (const c of [far, near]) {
      for (const p of [await listJobs(pool, { sort: "sponsor", after: c }), await listJobs(pool, { sort: "sponsor", before: c })]) {
        expect(ids(p).every((i) => liveIds.has(i))).toBe(true);
      }
    }
    expect(ids(await listJobs(pool, { sort: "sponsor", after: near }))).toEqual([]); // nothing sorts after the very last position
    expect(ids(await listJobs(pool, { sort: "sponsor", before: far }))).toEqual([]); // nothing sorts before the very first position
    expect(ids(await listJobs(pool, { sort: "sponsor", after: far }))).toHaveLength(PAGE_SIZE);
    expect(ids(await listJobs(pool, { sort: "sponsor", before: near }))).toHaveLength(PAGE_SIZE);
    expect(decodeCursor("sponsor", far).id).toBe("9223372036854775807");
  });
});

describe("a count that stops at 200", () => {
  it("counts up to 200, then says more", async () => {
    const own = await createTestDb();
    try {
      const f = fixtures(own) as unknown as { id: typeof id; F: typeof F; su: typeof su };
      const src = (await f.su("insert into job_source(kind, board) values ('portal', $1) returning id::text", [f.id("src")])).rows[0].id;
      const org = await f.F.org();
      const make = (n: number) =>
        f.su(
          `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, badge, status, closes_at, own_page_url, search_vector)
           select $1, 'admin_manual', $2, 'Cook ' || g, 'Fake Employer', 'it', 'critical_skills', 'critical_skills_eligible', 'live', now() + interval '20 days', 'https://example.test/a', to_tsvector('english','cook')
             from generate_series(1, $3::int) g`,
          [org, src, n],
        );
      const count = async (sort: Sort) => (await listJobs(own.pool("app_candidate"), { sort })).count;
      await make(150);
      for (const s of SORTS) expect(await count(s)).toEqual({ n: 150, more: false });
      await make(50);
      for (const s of SORTS) expect(await count(s)).toEqual({ n: COUNT_CAP, more: false });
      await make(5);
      for (const s of SORTS) expect(await count(s)).toEqual({ n: COUNT_CAP, more: true });
      await make(500);
      const big = await listJobs(own.pool("app_candidate"), { sort: "sponsor" });
      expect(big.count).toEqual({ n: COUNT_CAP, more: true });
      expect(big.jobs).toHaveLength(PAGE_SIZE);
      // a later page does not count
      expect((await listJobs(own.pool("app_candidate"), { sort: "sponsor", after: big.next! })).count).toBeNull();
    } finally {
      await own.drop();
    }
  });
});

describe("one job", () => {
  it("returns the columns, the advert, the employer, the badges, last checked and the rules date", async () => {
    const e = await employer([[YEAR, 30], [YEAR - 4, 20], [YEAR - 5, 100]]);
    const s = (await su("insert into job_source(kind, board, last_ok_at) values ('portal', $1, '2026-11-10 06:00:00+00') returning id::text", [id("src")])).rows[0].id as string;
    const j = await addJob(e.org, { salary: 52000, text: "Fake advert text for a cook.", source: s });
    const page = (await getJob(candidate(), j.id))!;
    expect(page).toMatchObject({
      id: j.id, title: expect.stringContaining("Cook"), employerName: "Fake Employer", sector: "it", permitType: "critical_skills", badge: "critical_skills_eligible",
      salaryLow: 52000, salaryHigh: 52000, salaryLine: "€52,000", advertText: "Fake advert text for a cook.", applicationRoute: "own_page",
      ownPageUrl: "https://example.test/a", permitHistory: "has_history", rulesCheckedOn: RULES_CHECKED_ON,
      employer: { id: String(e.org), name: "Fake Org", kind: "employer" },
    });
    expect(page.lastCheckedAt?.toISOString()).toBe("2026-11-10T06:00:00.000Z");
    // 50 permits in the 5-year window; the older 100 do not count, and "since" is not earlier than the window
    expect(page.sponsored).toEqual({ permits: 50, since: YEAR - 4 });
    expect(Object.keys(page)).not.toContain("searchVector");
    expect(JSON.stringify(page)).not.toMatch(/hire_answer|hidden_reason|close_reason/);
  });

  it("'since' is the first year with permits when that is inside the window", async () => {
    const e = await employer([[YEAR - 1, 4], [YEAR, 6]]);
    const j = await addJob(e.org);
    expect((await getJob(candidate(), j.id))!.sponsored).toEqual({ permits: 10, since: YEAR - 1 });
  });

  it.each([
    ["not linked", async () => (await employer(null)).org],
    ["linked, but no permits in the last 5 years", async () => (await employer([[YEAR - 5, 9]])).org],
  ])("has no sponsored badge when %s, and the job has no advert text yet", async (_name, make) => {
    const j = await addJob(await make());
    const page = (await getJob(candidate(), j.id))!;
    expect(page.sponsored).toBeNull();
    expect(page.advertText).toBeNull();
    expect(page.lastCheckedAt).toBeNull();
  });

  it("a job with no badge shows none", async () => {
    const e = await employer(null);
    const none = await addJob(e.org, { badge: null });
    expect((await getJob(candidate(), none.id))!.badge).toBeNull();
  });

  it("follows a DETE import at once", async () => {
    const e = await employer(null);
    const j = await addJob(e.org);
    expect((await getJob(candidate(), j.id))!.sponsored).toBeNull();
    await importPermits(admin(), [{ deteName: e.tag, year: YEAR - 2, permits: 8, sourceFile: "f.xlsx" }]);
    await linkNames(admin(), [{ organisationNameId: e.nameId, deteName: e.tag }]);
    expect((await getJob(candidate(), j.id))!.sponsored).toEqual({ permits: 8, since: YEAR - 2 });
  });

  it.each(["0", "-1", "abc", "1 or 1=1", "1; drop table job", "9223372036854775808", "99999999999999999999", "1.5", ""])("hostile id %j returns null and harms nothing", async (bad) => {
    const before = (await su("select count(*)::int n from job")).rows[0].n;
    expect(await getJob(candidate(), bad)).toBeNull();
    expect((await su("select count(*)::int n from job")).rows[0].n).toBe(before);
  });
});

describe("job page additions (B6)", () => {
  it("quota, standing line, minimums, the per-year permit block and the employer labels", async () => {
    const e = await employer([[2019, 3], [YEAR - 2, 30], [YEAR - 1, 20]]);
    const j = await addJob(e.org, { quota: true });
    const page = (await getJob(candidate(), j.id, new Date(Date.UTC(YEAR, 5, 1))))!;
    expect(page.quotaFull).toBe(true);
    expect(page.standingLine).toMatch(/^Our check is guidance, not a permit decision\. Only DETE decides\. Rules last checked on .+\.$/);
    expect(page.minimums).toMatchObject({ criticalSkills: 40904, graduate: 36848, graduateMonths: 12, nonList: 68911, minContractMonths: 24, standardWeekHours: 39 });
    expect(page.permits).toEqual({
      byYear: [{ year: 2019, permits: 3 }, { year: YEAR - 2, permits: 30 }, { year: YEAR - 1, permits: 20 }], peakYear: YEAR - 2, trend: "down", latestMonth: null,
    });
    expect(page.sponsored).toEqual({ permits: 50, since: YEAR - 4 }); // 2019 is the first year with permits, but the window starts at YEAR - 4
    expect(page.employerLabels).toEqual([]);
    expect((await getJob(candidate(), (await addJob(e.org)).id))!.quotaFull).toBe(false);
  });
  it("an employer with no DETE link has no permit block and the label says so; removed claims add their label", async () => {
    const e = await employer(null);
    const j = await addJob(e.org);
    expect((await getJob(candidate(), j.id))).toMatchObject({ permits: null, sponsored: null, employerLabels: ["Permit history not linked yet"] });
    // the strike-3 trigger guards this column; the label read is what is under test, so the trigger is switched off for this one statement
    const k = await db.pool("postgres").connect();
    try { await k.query("set session_replication_role = replica"); await k.query("update organisation set claims_removed_at = now() where id = $1", [e.org]); } finally { k.release(); }
    expect((await getJob(candidate(), j.id))!.employerLabels).toContain("Sponsorship claims removed");
  });
  it("the condition of a code that carries one, and the range-crossing flag against the minimum for the permit type", async () => {
    const e = await employer(null);
    const care = await addJob(e.org);
    await su("update job set occupation_code = '6145' where id = $1", [care.id]);
    expect((await getJob(candidate(), care.id))!.condition).toContain("private household");
    const range = async (low: number | null, high: number | null) => {
      const j = await addJob(e.org);
      await su("update job set salary_low = $2, salary_high = $3 where id = $1", [j.id, low, high]);
      return (await getJob(candidate(), j.id))!;
    };
    expect((await range(30000, 50000)).salaryRangeCrosses).toBe(true); // only the top clears 40,904
    expect((await range(41000, 50000)).salaryRangeCrosses).toBe(false); // the low end clears: a pass
    expect((await range(30000, 35000)).salaryRangeCrosses).toBe(false); // below
    expect((await range(30000, 30000)).salaryRangeCrosses).toBe(false);
    expect((await range(null, null)).salaryRangeCrosses).toBe(false); // not stated
    expect((await range(null, 50000)).salaryRangeCrosses).toBe(false);
    expect((await getJob(candidate(), (await addJob(e.org)).id))!.condition).toBeNull();
  });
});

describe("job card additions (B7)", () => {
  it("a list card carries contract months, permit history, source, the employer page and logo, and the pay scale line for a scale grade", async () => {
    const e = await employer([[YEAR - 1, 5]]);
    await su("update organisation set slug = $2, logo_url = 'https://example.test/logo.png' where id = $1", [e.org, `fake-${e.tag}`]);
    const plain = await addJob(e.org, { k: 900_001 });
    const graded = await addJob(e.org, { k: 900_002 });
    await su("update job set contract_months = 24, pay_grade = '2135' where id = $1", [graded.id]);
    const list = await listJobs(candidate(), { sort: "newest" });
    const g = list.jobs.find((x) => x.id === graded.id)!;
    expect(g).toMatchObject({
      contractMonths: 24, permitHistory: (await su("select permit_history from job where id = $1", [graded.id])).rows[0].permit_history, source: "admin_manual", employerSlug: `fake-${e.tag}`, employerLogoUrl: "https://example.test/logo.png",
      payGrade: "2135", salaryLine: "2135", payScaleLine: "Pay scale for this grade: EUR 38,166 to 56,592",
    });
    expect(list.jobs.find((x) => x.id === plain.id)).toMatchObject({ contractMonths: null, payScaleLine: null });
  });
});

describe("what the additions expose (B6, B7)", () => {
  it("a card and a job page carry exactly the public fields: no organisation internals, no claims date, no hidden reason", async () => {
    const e = await employer([[YEAR - 1, 5]]);
    const j = await addJob(e.org, { k: 900_100 });
    const card = (await listJobs(candidate(), { sort: "newest" })).jobs.find((x) => x.id === j.id)!;
    expect(Object.keys(card).sort()).toEqual([
      "badge", "contractMonths", "county", "employerLogoUrl", "employerName", "employerSlug", "id", "lastCheckedAt", "passRoute", "payGrade", "payScaleLine",
      "permitHistory", "postedAt", "quotaFull", "salaryHigh", "salaryLine", "salaryLow", "source", "sponsorPermits", "title",
    ]);
    const page = JSON.stringify((await getJob(candidate(), j.id))!);
    expect(page).not.toMatch(/claimsRemovedAt|claims_removed_at|search_?vector|hidden|closeReason|weeklyHours|organisation_id/i);
  });
  it("a job that is not live gives no page and no card, whatever the new fields", async () => {
    const e = await employer(null);
    for (const status of ["closed", "hidden"]) {
      const j = await addJob(e.org, { status, k: 900_200 });
      expect(await getJob(candidate(), j.id), status).toBeNull();
      expect((await listJobs(candidate(), { sort: "newest" })).jobs.map((x) => x.id), status).not.toContain(j.id);
    }
  });
});

describe("roles", () => {
  const denied = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: "42501" });
  it("app_candidate runs both reads", async () => {
    await expect(listJobs(candidate())).resolves.toBeTruthy();
    const some = (await listJobs(candidate())).jobs[0];
    if (some) await expect(getJob(candidate(), some.id)).resolves.toBeTruthy();
  });

  // hidden_reason is readable since 0042 (S20: the saved and applied job reads say why a job is gone, a checked code only); the report id stays refused.
  it("app_candidate reads job.hidden_reason (0042, S20)", async () => {
    await expect(candidate().query("select hidden_reason from job limit 1")).resolves.toBeTruthy();
  });
  it.each(["hire_answer", "close_reason", "hidden_report_id", "fetched_advert_id", "posted_by_membership_id", "posted_by_staff_id", "pay_floor_id", "permit_employer_check", "created_at"])(
    "app_candidate cannot read job.%s",
    async (col) => denied(candidate().query(`select ${col} from job limit 1`)),
  );
  it("app_candidate cannot select job.* or organisation.sponsor_sort, and cannot write a job", async () => {
    await denied(candidate().query("select * from job limit 1"));
    await denied(candidate().query("select sponsor_sort from organisation limit 1"));
    await denied(candidate().query("update job set sponsor_sort = 999"));
    await denied(candidate().query("delete from job"));
    await expect(candidate().query("select sponsor_sort from job limit 1")).resolves.toBeTruthy();
  });

  it("app_portal and app_fetcher cannot set the key, so nobody sorts first by choosing it", async () => {
    for (const role of ["app_portal", "app_fetcher"] as const) await denied(db.pool(role).query("update job set sponsor_sort = 999"));
    await denied(db.pool("app_portal").query("update organisation set sponsor_sort = 999"));
    await denied(db.pool("app_fetcher").query("update organisation set sponsor_sort = 999"));
  });

  it("app_portal runs neither read (it has its own job list), app_fetcher and app_admin can read the key", async () => {
    await denied(listJobs(db.pool("app_portal")));
    await denied(db.pool("app_portal").query("select permit_history from job limit 1"));
    await expect(listJobs(db.pool("app_fetcher"))).resolves.toBeTruthy();
    await expect(listJobs(admin())).resolves.toBeTruthy();
  });

  it.each(["anon", "authenticated"] as const)("%s reads nothing", async (role) => {
    await denied(db.pool(role).query("select id from job limit 1"));
    await denied(listJobs(db.pool(role)));
  });

  it("the refresh function is for app_admin only", async () => {
    for (const role of ["app_candidate", "app_portal", "app_fetcher"] as const) await denied(db.pool(role).query("select private.refresh_permit_history()"));
    await expect(admin().query("select private.refresh_permit_history()")).resolves.toBeTruthy();
  });
});
