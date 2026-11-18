// Integration: the job list filters (S1, S2, #247, src/search.ts) on the real test database, run as app_candidate: each filter alone and
// combined, keyword on title, employer and advert words, hidden jobs, paging under a filter, the count, cursors, the alert run agreeing with
// search, sectorCounts, and hostile keyword text. Fake data only. Every test starts with no live jobs (the ones before are closed).
import net from "node:net";
import { SOC2010_CODES } from "@portal/rules";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAlert, createAlert } from "../src/alerts";
import { queueAlerts } from "../src/alerts-run-cli";
import { BadSearchInput, decodeCursor, encodeCursor, filterHash, listJobs, PAGE_SIZE, sectorCounts, SORTS, toAlertBody, type JobList, type SearchFilters, type Sort } from "../src/search";
import { createTestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

let db: Awaited<ReturnType<typeof createTestDb>>;
type Fx = { id(p: string): string; F: { cand(o?: object): Promise<string>; org(): Promise<number>; portal(): Promise<string>; member(org: string, user: string, o?: object): Promise<number>; text(purpose: string): Promise<number> } };
let f: Fx;
let org: string, src: string, member: string, text: string;
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p);
const candidate = () => db.pool("app_candidate");

beforeAll(async () => {
  db = await createTestDb();
  f = fixtures(db) as unknown as Fx;
  org = String(await f.F.org());
  src = (await su("insert into job_source(kind, board) values ('portal', 'fake-board') returning id::text")).rows[0].id;
  member = String(await f.F.member(org, await f.F.portal(), { role: "account_owner" }));
  text = String(await f.F.text("sponsorship_statement"));
});
afterAll(() => db.drop());
beforeEach(async () => {
  await su("update job set status = 'closed', close_reason = 'closed' where status = 'live'");
});

type J = {
  title?: string; employer?: string; advert?: string; occ?: string | null; sector?: string; county?: string | null; low?: number | null; high?: number | null;
  sponsor?: boolean; quota?: boolean; status?: string; closes?: string; ago?: string;
};
type Made = Required<Pick<J, "occ" | "sector" | "county" | "low" | "high" | "sponsor" | "quota">> & { id: string; days: number };
let tick = 0;
/** One job as postgres (an employer job with no pay gets a pay grade, which is not stated pay), its search_vector made the way the writers make it (title, employer, advert). `ago` is how long ago it was posted. */
async function job(o: J = {}): Promise<Made> {
  const title = o.title ?? "Fake job", employer = o.employer ?? "Fake Org", advert = o.advert ?? "";
  const status = o.status ?? "live";
  const start = o.sponsor ? "draft" : status;
  const extra = start === "hidden" ? ", hidden_reason" : start === "closed" ? ", close_reason" : "";
  const vals = start === "hidden" ? ", 'admin'" : start === "closed" ? ", 'closed'" : "";
  const id = (await su(
    `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, badge, salary_low, salary_high,
       pay_grade, quota_full, status, closes_at, own_page_url, search_vector${extra})
     values ($1, $12, $2, $13, $14, $3, $4, $5, 'critical_skills', $6, $7, $8, $15, $9, $10, ${o.closes ?? "now() + interval '20 days'"}, 'https://example.test/a',
       to_tsvector('english', $13 || ' ' || $14 || ' ' || $11)${vals})
     returning id::text`,
    [org, src, o.county ?? null, o.sector ?? "IT", o.occ ?? null, o.sponsor ? "sponsor_confirmed" : "critical_skills_eligible", o.low ?? null, o.high ?? null,
      o.quota ?? false, start, advert, o.sponsor ? "employer" : "admin_manual", title, employer,
      o.sponsor && o.low == null && o.high == null ? "Grade VII" : null])).rows[0].id as string;
  if (advert) await su("insert into job_text(job_id, advert_text) values ($1, $2)", [id, advert]);
  if (o.sponsor) {
    await db.query("app_portal", "insert into sponsorship_statement(job_id, organisation_id, kind, consent_text_id, signer_membership_id, signer_name) values ($1, $2, 'own_company', $3, $4, 'Fake Signer')", [id, org, text, member]);
    await su("update job set status = 'live' where id = $1", [id]);
  }
  // distinct posted times, newest made last; `ago` moves it back
  await su(`update job set posted_at = now() - $2::interval - interval '1 hour' + $3::int * interval '1 millisecond' where id = $1`, [id, o.ago ?? "2 days", ++tick]);
  const days = Number((await su("select extract(epoch from now() - posted_at) / 86400 d from job where id = $1", [id])).rows[0].d);
  return { id, days, occ: o.occ ?? null, sector: o.sector ?? "IT", county: o.county ?? null, low: o.low ?? null, high: o.high ?? null, sponsor: !!o.sponsor, quota: !!o.quota };
}

/** The filter rule worked out in JavaScript from what was inserted (keyword left out: tested by itself). */
const hit = (m: Made, x: SearchFilters) => {
  const pay = m.low !== null || m.high !== null;
  return (x.occupationCode === undefined || m.occ === x.occupationCode) && (x.sector === undefined || m.sector === x.sector) &&
    (x.county === undefined || m.county === x.county) && (x.badge === undefined || (x.badge === "sponsor_confirmed") === m.sponsor) &&
    (x.salaryMin === undefined || (pay && (m.high ?? m.low ?? 0) >= x.salaryMin)) && (x.salaryStated === undefined || pay) &&
    (x.postedWithin === undefined || m.days < x.postedWithin);
};

/** Every page from the first by next; checks each page's cursors and that nothing repeats. */
async function walk(sort: Sort, filters: SearchFilters): Promise<{ ids: string[]; pages: JobList[] }> {
  const pages = [await listJobs(candidate(), { sort, filters })];
  while (pages.at(-1)!.next) pages.push(await listJobs(candidate(), { sort, filters, after: pages.at(-1)!.next! }));
  const ids = pages.flatMap((p) => p.jobs.map((j) => j.id));
  expect(new Set(ids).size, "a row repeated").toBe(ids.length);
  return { ids, pages };
}
const sorted = (a: string[]) => [...a].sort();

describe("each filter alone and combined", () => {
  it("finds exactly the jobs the rule says, on every sort, with the count", async () => {
    const made = [
      await job({ occ: "2231", sector: "health", county: "Dublin", low: 45000, high: 55000, sponsor: true }),
      await job({ occ: "2231", sector: "health", county: "Cork", low: 30000, high: 30000 }),
      await job({ occ: "2136", sector: "IT", county: "Dublin", high: 70000, ago: "5 days" }),
      await job({ occ: "2136", sector: "IT", county: null, ago: "20 days" }),
      await job({ occ: null, sector: "finance", county: "Galway", low: 40000, sponsor: true, ago: "40 days" }),
      await job({ occ: "1122", sector: "construction and engineering", county: "Dublin", low: 39999, ago: "2 hours" }),
      await job({ occ: "2231", sector: "health", county: "Dublin", low: 60000, high: 60000, quota: true, ago: "1 hour" }),
      await job({ occ: "2136", sector: "IT", county: "Cork", sponsor: true, ago: "10 days" }),
      await job({ occ: "6145", sector: "care", county: "Dublin", low: 34000 }), // #257
      await job({ occ: "5434", sector: "hospitality", county: "Cork", low: 36000, ago: "3 hours" }),
    ];
    const cases: SearchFilters[] = [
      {}, { sector: "care" }, { sector: "hospitality" }, { sector: "care", county: "Dublin" }, { sector: "hospitality", county: "Dublin" }, { occupationCode: "2231" }, { occupationCode: "3111" }, { sector: "health" }, { sector: "pharma and science" }, { county: "Dublin" }, { salaryMin: 40000 },
      { salaryMin: 0 }, { badge: "sponsor_confirmed" }, { postedWithin: 1 }, { postedWithin: 3 }, { postedWithin: 7 }, { postedWithin: 30 }, { salaryStated: true },
      { sector: "health", county: "Dublin" }, { sector: "IT", badge: "sponsor_confirmed" }, { county: "Dublin", salaryMin: 40000, postedWithin: 7 },
      { occupationCode: "2231", sector: "health", county: "Dublin", salaryMin: 45000, badge: "sponsor_confirmed", postedWithin: 3, salaryStated: true },
    ];
    for (const x of cases) {
      const want = made.filter((m) => hit(m, x));
      for (const sort of SORTS) {
        const { ids, pages } = await walk(sort, x);
        expect(sorted(ids), `${sort} ${JSON.stringify(x)}`).toEqual(sorted(want.map((m) => m.id)));
        expect(pages[0]!.count).toEqual({ n: want.length, more: false });
        // a full-quota job still sorts last under a filter (#85)
        const firstFull = ids.findIndex((i) => made.find((m) => m.id === i)!.quota);
        if (firstFull >= 0) expect(ids.slice(firstFull).every((i) => made.find((m) => m.id === i)!.quota)).toBe(true);
      }
    }
    await expect(listJobs(candidate(), { filters: { occupationCode: "9999" } })).rejects.toThrow(BadSearchInput); // not a SOC 2010 code
  });
});

describe("keyword", () => {
  it("matches title, employer name and advert words, with stemming; stop words alone are no filter", async () => {
    const a = await job({ title: "Senior Radiographer", advert: "We need a radiographer." });
    const b = await job({ title: "Staff nurse", employer: "Zephyrco Health" });
    const c = await job({ title: "Lab assistant", advert: "Phlebotomy and senior nurse duties in a busy clinic." });
    const d = await job({ title: "Line cook", advert: "Kitchen work.", county: "Cork" });
    const q = async (text: string, extra: SearchFilters = {}) => sorted((await walk("newest", { q: text, ...extra })).ids);
    expect(await q("radiographer")).toEqual([a.id]);
    expect(await q("RADIOGRAPHERS")).toEqual([a.id]);
    expect(await q("zephyrco")).toEqual([b.id]);
    expect(await q("phlebotomy")).toEqual([c.id]);
    expect(await q("nurses")).toEqual(sorted([b.id, c.id]));
    expect(await q('"senior nurse"')).toEqual([c.id]);
    expect(await q("nurse -clinic")).toEqual([b.id]);
    expect(await q("radiographer or cook")).toEqual(sorted([a.id, d.id]));
    expect(await q("cook", { county: "Dublin" })).toEqual([]);
    expect(await q("cook", { county: "Cork" })).toEqual([d.id]);
    expect(await q("nothingmatchesthis")).toEqual([]);
    const all = sorted([a.id, b.id, c.id, d.id]);
    for (const stop of ["the", "a and the", "!!!", "-", '""', "or"]) expect(await q(stop), stop).toEqual(all);
    expect((await listJobs(candidate(), { filters: { q: "the" } })).count).toEqual({ n: 4, more: false });
  });
});

describe("hidden jobs", () => {
  it("never show under any filter, keyword or sort; a full-quota live job does, last", async () => {
    const same = { title: "Hiddenword nurse", occ: "2231", sector: "health", county: "Dublin", low: 50000, high: 50000, ago: "1 hour" };
    const live = await job({ ...same, sponsor: true });
    const full = await job({ ...same, sponsor: true, quota: true });
    const hidden = [
      await job({ ...same, status: "closed" }), await job({ ...same, status: "hidden" }), await job({ ...same, status: "under_review" }),
      await job({ ...same, status: "in_review" }), await job({ ...same, status: "draft" }), await job({ ...same, closes: "now() - interval '1 minute'" }),
    ];
    const filters: SearchFilters[] = [
      {}, { q: "hiddenword" }, { occupationCode: "2231" }, { sector: "health" }, { county: "Dublin" }, { salaryMin: 50000 }, { postedWithin: 1 }, { salaryStated: true },
      { q: "hiddenword", occupationCode: "2231", sector: "health", county: "Dublin", salaryMin: 50000, postedWithin: 1, salaryStated: true },
    ];
    for (const x of filters) for (const sort of SORTS) {
      const { ids } = await walk(sort, x);
      expect(ids, `${sort} ${JSON.stringify(x)}`).toEqual([live.id, full.id]);
      for (const h of hidden) expect(ids).not.toContain(h.id);
    }
    // the badge filter needs a signed statement: only the two sponsor jobs
    expect((await walk("newest", { badge: "sponsor_confirmed" })).ids).toEqual([live.id, full.id]);
  });
});

describe("paging under a filter", () => {
  it("walks forward and back with no row lost or repeated, on every sort", async () => {
    const want: Made[] = [];
    for (let i = 0; i < 47; i++)
      want.push(await job({ sector: "finance", county: "Galway", low: 30000 + (i % 7) * 1000, high: 30000 + (i % 7) * 1000, quota: i % 11 === 0, title: `Analyst ${i}` }));
    for (let i = 0; i < 15; i++) await job({ sector: i % 2 ? "finance" : "IT", county: i % 2 ? "Cork" : "Galway" }); // noise: one of the two filters each
    const x: SearchFilters = { sector: "finance", county: "Galway", q: "analyst" };
    for (const sort of SORTS) {
      const { ids, pages } = await walk(sort, x);
      expect(sorted(ids)).toEqual(sorted(want.map((m) => m.id)));
      expect(pages.length).toBe(Math.ceil(47 / PAGE_SIZE));
      expect(pages[0]!.count).toEqual({ n: 47, more: false });
      expect(pages.slice(1).every((p) => p.count === null)).toBe(true);
      // back from the last page by previous gives the same pages in the same order
      const back: string[][] = [pages.at(-1)!.jobs.map((j) => j.id)];
      let prev = pages.at(-1)!.previous;
      while (prev) {
        const p = await listJobs(candidate(), { sort, filters: x, before: prev });
        back.unshift(p.jobs.map((j) => j.id));
        prev = p.previous;
      }
      expect(back.flat()).toEqual(ids);
      // a cursor from this filter set is refused on another, and on no filters
      const next = pages[0]!.next!;
      for (const other of [{}, { sector: "finance" }, { ...x, county: "Cork" }, { ...x, q: "analysts" }] as SearchFilters[])
        await expect(listJobs(candidate(), { sort, filters: other, after: next }), JSON.stringify(other)).rejects.toThrow(BadSearchInput);
    }
  });
});

describe("search and the alert run agree", () => {
  it("the jobs a search finds with an alert's filters are exactly the jobs the alert run sends (it skips full-quota jobs)", async () => {
    const made = [
      await job({ occ: "2231", sector: "health", county: "Dublin", low: 45000, high: 55000, sponsor: true }),
      await job({ occ: "2231", sector: "health", county: "Cork", low: 30000, high: 30000 }),
      await job({ occ: "2231", sector: "health", county: "Dublin", low: 41000 }),
      await job({ occ: "2231", sector: "health", county: "Dublin" }), // no pay: never under a pay floor
      await job({ occ: "2136", sector: "IT", county: "Dublin", high: 70000, sponsor: true }),
      await job({ occ: null, sector: "finance", county: "Galway", low: 40000 }),
      await job({ occ: "2231", sector: "health", county: "Dublin", low: 60000, high: 60000, quota: true }),
      await job({ occ: "6146", sector: "care", county: "Dublin", low: 38000 }), // #257
      await job({ occ: "9273", sector: "hospitality", county: "Galway" }),
    ];
    const searches: SearchFilters[] = [
      { sector: "care" }, { sector: "hospitality" }, { sector: "health" }, { county: "Dublin" }, { salaryMin: 40000 }, { badge: "sponsor_confirmed" }, { occupationCode: "2231" },
      { sector: "health", county: "Dublin", salaryMin: 40000 }, { occupationCode: "2231", county: "Dublin", salaryMin: 45000, badge: "sponsor_confirmed" }, {},
    ];
    const c = await f.F.cand();
    const alertIds: number[] = [];
    for (const x of searches) {
      const body = checkAlert(SOC2010_CODES)({ ...toAlertBody(x), frequency: "daily" });
      expect(body).not.toBeNull();
      alertIds.push(Number((await createAlert(candidate(), c, body!)).alert.id));
    }
    await su("update alert set created_at = now() - interval '30 days' where candidate_user_id = $1", [c]);
    await queueAlerts(db.pool("app_admin"));
    const sent = new Map<number, string[]>(
      ((await su("select params from email_outbox where candidate_user_id = $1", [c])).rows[0]?.params.alerts ?? [])
        .map((a: { alert_id: number; job_ids: number[] }) => [a.alert_id, a.job_ids.map(String)]));
    for (const [i, x] of searches.entries()) {
      const { ids } = await walk("newest", x);
      const notFull = ids.filter((id) => !made.find((m) => m.id === id)!.quota);
      expect(sent.get(alertIds[i]!) ?? [], JSON.stringify(x)).toEqual(notFull); // same jobs, same order (newest first)
      expect(ids.length - notFull.length).toBe(made.filter((m) => m.quota && hit(m, x)).length);
    }
  });
});

describe("sectorCounts", () => {
  it("counts live jobs per sector, zero included, against the rows", async () => {
    for (const s of ["health", "health", "IT", "finance", "care", "other"]) await job({ sector: s });
    await job({ sector: "health", status: "closed" });
    await job({ sector: "IT", closes: "now() - interval '1 minute'" });
    await job({ sector: "pharma and science", quota: true });
    const rows = (await su("select sector, count(*)::int n from job where status = 'live' and closes_at > now() group by sector")).rows as { sector: string; n: number }[];
    const got = await sectorCounts(candidate());
    expect(got.map((g) => g.sector)).toEqual(["health", "IT", "construction and engineering", "finance", "care", "hospitality", "pharma and science", "other"]);
    for (const g of got) expect(g.jobs, g.sector).toBe(rows.find((r) => r.sector === g.sector)?.n ?? 0);
    expect(got).toEqual([
      { sector: "health", jobs: 2 }, { sector: "IT", jobs: 1 }, { sector: "construction and engineering", jobs: 0 }, { sector: "finance", jobs: 1 },
      { sector: "care", jobs: 1 }, { sector: "hospitality", jobs: 0 }, { sector: "pharma and science", jobs: 1 }, { sector: "other", jobs: 1 },
    ]);
  });
});

describe("hostile input", () => {
  it("the search reaches no outside service, and the repo's network guard (vitest.setup.ts) still refuses a real host", () => {
    expect(() => net.connect(443, "example.com")).toThrow(/real network/);
  });

  it("keyword text never fails the query and is never SQL; the list runs as app_candidate", async () => {
    const a = await job({ title: "Welder", advert: "Drop table job is not an instruction here." });
    const hostile = [
      "'; drop table job; --", "' or 1=1 --", "1); select pg_sleep(5); --", "nurse -cook", '"unclosed', '""', "-", "--", "or or or", "a & b | !c", ":*", "nurse:*",
      "(((", ")))", "<->", "\\", "\\'", "$1", "%", "_", "‮welder", "wel​der", "wel‍der", "�", "\u{1F600}", "a".repeat(200), "x ".repeat(100),
      "Dröp täble", "اختبار", "测试", "\uD800",
    ];
    for (const q of hostile) for (const sort of SORTS) {
      const l = await listJobs(candidate(), { sort, filters: { q } });
      expect(Array.isArray(l.jobs), q).toBe(true);
    }
    expect((await walk("newest", { q: "drop table" })).ids).toEqual([a.id]);
    expect((await su("select count(*)::int n from job")).rows[0].n).toBeGreaterThan(0); // still there
    for (const q of ["a\u0000b", "a".repeat(201), "a\nb"]) await expect(listJobs(candidate(), { filters: { q } })).rejects.toThrow(BadSearchInput);
  });

  it("a forged cursor is refused: other sort, other filters, bad keys; a well-formed edited position still shows only live jobs", async () => {
    const live = await job({ county: "Cork", ago: "3 days" });
    const gone = await job({ county: "Cork", status: "hidden", ago: "1 day" });
    const x: SearchFilters = { county: "Cork" };
    const h = filterHash(x);
    const at = (await su("select posted_at::text t from job where id = $1", [gone.id])).rows[0].t as string;
    const raw = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const good = { s: "newest", q: false, k: [at], i: gone.id, f: h };
    for (const t of [raw({ ...good, s: "salary" }), raw({ ...good, f: filterHash({}) }), raw({ ...good, f: undefined }), raw({ ...good, k: ["now()"] }),
      raw({ ...good, i: "1 or 1=1" }), raw({ ...good, k: [`${at}'; drop table job; --`] })])
      await expect(listJobs(candidate(), { sort: "newest", filters: x, after: t })).rejects.toThrow(BadSearchInput);
    // a cursor at the hidden job's own position is just a position in the live list: it shows the live job after it, never the hidden one
    const l = await listJobs(candidate(), { sort: "newest", filters: x, before: encodeCursor(decodeCursor("newest", raw({ ...good, k: ["2000-01-01 00:00:00+00"], i: "1" }), h), h) });
    expect(l.jobs.map((j) => j.id)).toEqual([live.id]);
    expect((await listJobs(candidate(), { sort: "newest", filters: x, after: raw(good) })).jobs.map((j) => j.id)).toEqual([live.id]);
  });
});
