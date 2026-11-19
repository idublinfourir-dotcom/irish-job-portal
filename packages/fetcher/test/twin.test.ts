// Integration: the fetched twin of an employer's own job (migration 0057, step 15 row D3, #53), against the real test database. The employer's job is
// written as app_portal and the staff job as app_admin, the way their routes write them, so job_guard and the 0057 triggers decide; the fetched job
// comes through the real fetch path (runBoards as app_fetcher, hand-written plans). The public reads are the real ones, as app_candidate. Fake data only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RawAdvert } from "@portal/sources";
import { nameTitlePlaceKey } from "@portal/rules";
import { createTestDb, type TestDb } from "../../db/test/db";
import { listJobs } from "../../db/src/search";
import { getCompanyPage, type CompanyPage } from "../../db/src/public-pages";
import { sitemapPart } from "../../db/src/sitemap";
import { runBoards, type BoardTask } from "../src";
import { advert, deps, NOW, plan } from "./helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb, src: string;
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p).then((r) => r.rows);
const jobOf = async (id: string) => (await su("select status, hidden_reason, close_reason from job where id = $1", [id]))[0];
beforeAll(async () => {
  db = await createTestDb();
  src = (await su("select id::text from job_source where kind = 'portal' and board = 'employer'"))[0].id;
});
afterAll(() => db.drop());

let n = 0, day = 0;
/** A verified employer the fetcher finds by name, its recruiter, and a fake board that lists `ads`. */
async function world(kind = "employer") {
  const name = `Twin Fake ${++n} Ltd`;
  const [o] = await su("insert into organisation(slug, display_name, kind, status) values ($1, $2, $3, 'verified') returning id::text, slug", [`twin-${n}`, name, kind]);
  await su("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, $3, 'legal', 'cro')", [o.id, name, name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()]);
  await su("insert into portal_user(id, name, email, email_verified, created_at, updated_at) values ($1, 'Fake Member', $2, true, now(), now())", [`tw-${n}`, `tw-${n}@example.test`]);
  const [m] = await su("insert into membership(organisation_id, portal_user_id, role, status) values ($1, $2, 'recruiter', 'active') returning id::text", [o.id, `tw-${n}`]);
  const ads = new Map<string, RawAdvert>();
  const b = `tw${n}`;
  const w = {
    org: o.id as string, slug: o.slug as string, mem: m.id as string, name,
    put(id: string, over: Partial<RawAdvert> = {}) { ads.set(id, advert(`${b}-${id}`, { employer: name, ...over })); },
    drop(id: string) { ads.delete(id); },
    get task(): BoardTask {
      return { kind: "fake", board: b, rereadDays: 1, fetch: async (known) => {
        const all = [...ads.values()];
        return { seen: all.map((a) => a.id), adverts: all.filter((a) => !known.has(a.id)) };
      } };
    },
    async fetch() { return (await runBoards(deps(db.pool("app_fetcher"), [w.task], { now: () => new Date(NOW.getTime() + ++day * 86_400_000) }), (a) => ({ ...plan(a, "passed"), ...countyPlan(a) })))[0]!; },
    async fetched(id: string) { return (await su("select j.id::text from job j join fetched_advert f on f.id = j.fetched_advert_id where f.external_id = $1", [`fake:b:${b}-${id}`]))[0]?.id as string; },
    /** The employer's own job, as app_portal writes it. */
    url: (id: string) => `https://jobs.example.test/${b}-${id}`,
    async post(title: string, county: string | null = "Dublin", status = "live", url = "https://example.test/apply") {
      const [r] = (await db.query("app_portal",
        `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, permit_type, salary_low, status, closes_at, search_vector,
           own_page_url, posted_by_membership_id) values ($1, 'employer', $2, $3, $4, $5, 'IT', '2134', 'critical_skills', 60000, $6, now() + interval '29 days', to_tsvector('english', 'fake'),
           $8, $7) returning id::text, status`, [o.id, src, title, name, county, status, m.id, url])).rows;
      return r!.id as string;
    },
  };
  return w;
}
// The hand plan says Dublin; an advert placed in Cork keeps Cork, so a test can make a twin that differs only by county.
const countyPlan = (a: RawAdvert) => {
  const p = plan(a, "passed");
  return p.action === "job" ? { job: { ...p.job, county: a.location.startsWith("Cork") ? "Cork" : "Dublin" } } : {};
};

describe("the title rule", () => {
  it("is the title part of nameTitlePlaceKey, the same in the database", async () => {
    for (const t of ["Software Engineer", "  SOFTWARE-engineer!! ", "Nurse (RGN) / Night", "Chef de Partie, 2 posts"]) {
      const [r] = await su("select trim(regexp_replace(lower($1::text), '[^a-z0-9]+', ' ', 'g')) as t", [t]);
      expect(r.t).toBe(nameTitlePlaceKey(null, t, null).split("|")[1]);
    }
  });
});

describe("a fetched twin", () => {
  it("is hidden when the employer's job goes live, and the saved job moves once", async () => {
    const w = await world();
    w.put("a");
    await w.fetch();
    const twin = await w.fetched("a");
    expect((await jobOf(twin)).status).toBe("live");
    const [c1, c2] = ["tw-c1-" + n, "tw-c2-" + n];
    for (const c of [c1, c2]) await su("insert into candidate_user(id, name, email, email_verified, created_at, updated_at) values ($1, 'Fake Candidate', $2, true, now(), now())", [c, `${c}@example.test`]);
    await su("insert into saved_job(candidate_user_id, job_id) values ($1, $2), ($3, $2)", [c1, twin, c2]);
    const draft = await w.post("Software Engineer (old title)", "Dublin");
    expect((await jobOf(twin)).status).toBe("live"); // not a twin yet
    await su("insert into saved_job(candidate_user_id, job_id) values ($1, $2)", [c2, draft]); // c2 already saved the employer's job
    await db.query("app_portal", "update job set title = 'software engineer' where id = $1", [draft]); // the edit makes it a twin
    expect(await jobOf(twin)).toEqual({ status: "hidden", hidden_reason: "duplicate", close_reason: null });
    const saved = await su("select candidate_user_id, job_id::text from saved_job where candidate_user_id in ($1, $2) order by 1", [c1, c2]);
    expect(saved).toEqual([{ candidate_user_id: c1, job_id: draft }, { candidate_user_id: c2, job_id: draft }]);
    // a second fetch leaves it hidden
    await w.fetch();
    expect((await jobOf(twin)).status).toBe("hidden");
    // the public reads no longer show it
    const cand = db.pool("app_candidate");
    const ids = (await listJobs(cand, { limit: 20 })).jobs.map((j) => j.id);
    expect(ids).toContain(draft);
    expect(ids).not.toContain(twin);
    expect((await listJobs(cand, { filters: { q: "software engineer" }, limit: 20 })).jobs.map((j) => j.id)).not.toContain(twin);
    expect(((await getCompanyPage(cand, w.slug)) as CompanyPage).jobs.jobs.map((j) => j.id)).toEqual([draft]);
    expect((await sitemapPart(cand, "jobs-0"))!.map((e) => e.key)).not.toContain(twin);
    // staff see why (the reason value); the candidate login may read it too (0042)
    expect((await db.query("app_admin", "select hidden_reason from job where id = $1", [twin])).rows[0].hidden_reason).toBe("duplicate");
  });

  it("a new fetched twin of a live employer job never goes live; a staff job hides it too", async () => {
    const w = await world();
    await w.post("Software Engineer");
    w.put("a");
    await w.fetch();
    expect((await jobOf(await w.fetched("a"))).hidden_reason).toBe("duplicate");
    const s = await world();
    s.put("a", { title: "Data Analyst" });
    await s.fetch();
    const [m] = (await db.query("app_admin",
      `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, permit_type, salary_low, status, closes_at, search_vector, own_page_url)
       values ($1, 'admin_manual', $2, 'Data analyst', $3, null, 'IT', 'critical_skills', 60000, 'live', now() + interval '29 days', to_tsvector('english', 'fake'), 'https://example.test/apply') returning id::text`,
      [s.org, src, s.name])).rows;
    expect(m).toBeTruthy();
    expect((await jobOf(await s.fetched("a"))).hidden_reason).toBe("duplicate");
  });

  it("a different title, county or company is not a twin; an agency job hides nothing", async () => {
    const w = await world(), other = await world(), agency = await world("agency");
    w.put("title", { title: "Senior Software Engineer" });
    w.put("county", { location: "Cork, Ireland" });
    other.put("a");
    agency.put("a");
    await Promise.all([w.fetch(), other.fetch(), agency.fetch()]);
    await w.post("Software Engineer", "Dublin");
    await su(`insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, permit_type, salary_low, status, closes_at, search_vector, own_page_url)
      values ($1, 'agency', $2, 'Software Engineer', 'x', 'Dublin', 'IT', 'critical_skills', 60000, 'live', now() + interval '29 days', to_tsvector('english', 'fake'), 'https://example.test/apply')`, [agency.org, src]);
    for (const j of [await w.fetched("title"), await w.fetched("county"), await other.fetched("a"), await agency.fetched("a")]) expect((await jobOf(j)).status).toBe("live");
  });

  it("comes back by its link when the employer's job closes; a second post then takes it; closes when the advert is gone", async () => {
    const w = await world();
    w.put("a");
    w.put("b", { title: "Data Analyst" });
    await w.fetch();
    const [a, b] = [await w.fetched("a"), await w.fetched("b")];
    const e = await w.post("Software Engineer");
    const e2 = await w.post("SOFTWARE ENGINEER", null); // one to one: the only twin is taken, so this post hides nothing
    expect(await su("select id::text, twin_of_job_id::text from job where id = $1", [a])).toEqual([{ id: a, twin_of_job_id: e }]);
    await db.query("app_portal", "update job set status = 'closed', close_reason = 'closed' where id = $1", [e]);
    expect(await su("select status, twin_of_job_id::text from job where id = $1", [a])).toEqual([{ status: "hidden", twin_of_job_id: e2 }]); // back, then taken by e2
    await db.query("app_portal", "update job set status = 'closed', close_reason = 'closed' where id = $1", [e2]);
    expect(await jobOf(a)).toEqual({ status: "live", hidden_reason: null, close_reason: null });
    // b by its link (another title), its advert gone while hidden: the run is clean, the advert is marked gone, the job stays hidden
    const e3 = await w.post("Analyst, data team", "Dublin", "live", w.url("b") + "/#apply");
    expect((await jobOf(b)).hidden_reason).toBe("duplicate");
    w.drop("b");
    const r = await w.fetch();
    expect([r.ok, r.error]).toEqual([true, null]);
    expect((await su("select f.gone_at is not null as gone from fetched_advert f join job j on j.fetched_advert_id = f.id where j.id = $1", [b]))[0].gone).toBe(true);
    expect((await jobOf(b)).status).toBe("hidden");
    await db.query("app_portal", "update job set status = 'closed', close_reason = 'closed' where id = $1", [e3]);
    expect(await jobOf(b)).toEqual({ status: "closed", hidden_reason: null, close_reason: "closed" });
    // and it reopens the normal way when its advert is listed again
    w.put("b", { title: "Data Analyst" });
    await w.fetch();
    expect((await jobOf(b)).status).toBe("live");
  });

  it("one to one: 7 same-title fetched jobs hide none, unless the post links one of them; saved rows move only for it", async () => {
    const w = await world();
    for (let i = 1; i <= 7; i++) w.put(`s${i}`);
    await w.fetch();
    const ids = await Promise.all([1, 2, 3, 4, 5, 6, 7].map((i) => w.fetched(`s${i}`)));
    const hidden = async () => (await su("select id::text from job where id = any($1::bigint[]) and status = 'hidden'", [ids])).map((x) => x.id);
    await w.post("Software Engineer"); // another link: several candidates, no link match
    expect(await hidden()).toEqual([]);
    const c = `tw-c-${n}`;
    await su("insert into candidate_user(id, name, email, email_verified, created_at, updated_at) values ($1, 'Fake Candidate', $2, true, now(), now())", [c, `${c}@example.test`]);
    await su("insert into saved_job(candidate_user_id, job_id) values ($1, $2), ($1, $3)", [c, ids[3], ids[4]]);
    const e = await w.post("Software Engineer", "Dublin", "live", w.url("s4") + "#top");
    expect(await hidden()).toEqual([ids[3]]);
    expect((await su("select job_id::text from saved_job where candidate_user_id = $1 order by job_id", [c])).map((x) => x.job_id).sort()).toEqual([e, ids[4]].sort());
    // a new fetched job with the same title is not hidden (several candidates, and that post already has its twin)
    w.put("s8");
    await w.fetch();
    expect((await jobOf(await w.fetched("s8"))).status).toBe("live");
  });

  it("two posts with the same title and two fetched jobs: each post hides at most one, by its link", async () => {
    const w = await world();
    w.put("p1");
    w.put("p2");
    await w.fetch();
    const [p1, p2] = [await w.fetched("p1"), await w.fetched("p2")];
    const e1 = await w.post("Software Engineer", "Dublin", "live", w.url("p1"));
    const e2 = await w.post("Software Engineer", "Dublin", "live", w.url("p2") + "/");
    expect(await su("select id::text, twin_of_job_id::text from job where id = any($1::bigint[]) order by id", [[p1, p2]]))
      .toEqual([{ id: p1, twin_of_job_id: e1 }, { id: p2, twin_of_job_id: e2 }]);
  });

  it("a twin that may not be live closes instead, so the employer's close never fails", async () => {
    const w = await world();
    w.put("a");
    await w.fetch();
    const twin = await w.fetched("a");
    const e = await w.post("Software Engineer");
    await su("update job set search_vector = null where id = $1", [twin]); // a hidden row may lack it; a live one may not
    await db.query("app_portal", "update job set status = 'closed', close_reason = 'closed' where id = $1", [e]);
    expect(await jobOf(twin)).toEqual({ status: "closed", hidden_reason: null, close_reason: "closed" });
  });

  it("an invalid live fetched row is still refused by its CHECK (the trigger runs after)", async () => {
    const w = await world();
    await w.post("Software Engineer");
    await expect(su(`insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, permit_type, status, closes_at, search_vector, own_page_url)
      values ($1, 'fetched', $2, 'Software Engineer', 'x', 'Dublin', 'IT', 'critical_skills', 'live', 'infinity', to_tsvector('english', 'x'), 'https://jobs.example.test/x')`, [w.org, src])).rejects.toThrow(/check/);
  });

  it("stays hidden while the company is suspended", async () => {
    const w = await world();
    w.put("a");
    await w.fetch();
    const e = await w.post("Software Engineer");
    await su("update organisation set status = 'suspended' where id = $1", [w.org]);
    await su("update job set status = 'hidden', hidden_reason = 'organisation_suspended' where id = $1", [e]);
    expect((await jobOf(await w.fetched("a"))).hidden_reason).toBe("duplicate");
  });

  it("refuses a hidden reason outside the list", async () => {
    const w = await world();
    const e = await w.post("Nurse");
    await expect(su("update job set status = 'hidden', hidden_reason = 'duplicate; drop table job' where id = $1", [e])).rejects.toThrow(/job_hidden_reason_check/);
  });
});
