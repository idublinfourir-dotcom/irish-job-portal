// Integration (D1 wave 1): the JobsIreland kind through the real fetch run (atsTasks, fetchJobsIreland, makeCaller, runBoards, the rules plan) on the real
// test database as app_fetcher, the site answered by a fake fetch from the saved bodies; and the cross-source duplicate rule (migration 0065, the
// job_twin trigger) through the real run. No network, no real waiting. Fake data only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readSalary } from "@portal/rules";
import type { Fetch, RawAdvert } from "@portal/sources";
import { fake, reply } from "../../sources/src/ats/testkit";
import { api, card, DETAIL, details, hex } from "../../sources/src/jobsireland/testkit";
import { createTestDb, type TestDb } from "../../db/test/db";
import { atsTasks, runBoards, type BoardTask } from "../src";
import { advert, deps, fakeModel, NOW, plan } from "./helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb;
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p).then((r) => r.rows);
beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());

let day = 0;
const at = () => new Date(NOW.getTime() + ++day * 86_400_000);

describe("the jobsireland kind on the real database", () => {
  // a paid job the rules give a badge: pay shown over the minimum, a permanent full-time post
  const paid = (d: string) => reply({ ...DETAIL, id: d, positionTitle: `Platform Engineer ${d.slice(-1)}`, employmentType: { id: "ETY1", name: "Full-time" }, displaySalary: true, actualWages: 45000, jobDescription: "Permanent full-time role building fake platforms." });
  const cards = [card(1), card(2), card(3), card(4, { vacancyType: "VTY4" })];
  async function run(list = cards, over?: (url: string) => Response | undefined) {
    const { fetch, calls } = fake((c) => over?.(c.url) ?? api(list, { detail: paid })(c));
    const tasks = atsTasks({ jobsireland: [["jobsireland", 2]] }, fetch as Fetch, () => {}, async () => {}).map((t) => ({ ...t, rereadDays: undefined }));
    const [r] = await runBoards(deps(db.pool("app_fetcher"), tasks, { checkBatch: fakeModel().checkBatch, now: at }));
    return { r: r!, calls };
  }
  const saved = async () =>
    (await su("select f.external_id, j.status, j.county, j.salary_low, j.own_page_url from fetched_advert f join job_source s on s.id = f.job_source_id left join job j on j.fetched_advert_id = f.id where s.kind = 'jobsireland' order by 1"));

  it("the boards file lists the one JobsIreland board, 500 detail reads a run, re-read weekly", async () => {
    const { default: file } = await import("../data/boards.json", { with: { type: "json" } });
    expect((file as { jobsireland?: unknown }).jobsireland).toEqual([["jobsireland", 500]]);
    expect(atsTasks(file as never, fake(() => reply({})).fetch).filter((t) => t.kind === "jobsireland").map((t) => [t.board, t.rereadDays])).toEqual([["jobsireland", 7]]);
  });
  it("the salary box the adapter writes is what the rules' salary reader reads", () => {
    expect(readSalary("", "€30,000 to €49,999 a year")).toEqual({ low: 30000, high: 49999 });
    expect(readSalary("", "€29,406 a year")).toEqual({ low: 29406, high: 29406 });
  });

  it("day 1: two detail reads under the cap, both saved live with county and pay; the third waits; the scheme place is never read", async () => {
    const { r, calls } = await run();
    expect(r).toMatchObject({ ok: true, seen: 3, passed: 2 });
    expect(details(calls)).toHaveLength(2);
    expect(await saved()).toEqual([1, 2].map((i) => ({ external_id: `jobsireland:jobsireland:${hex(i)}`, status: "live", county: "Monaghan", salary_low: 45000, own_page_url: `https://jobsireland.ie/search-jobs?jobId=${hex(i)}` })));
  });
  it("day 2: the known two cost no read; the third is read and saved", async () => {
    const { r, calls } = await run();
    expect(r).toMatchObject({ ok: true, seen: 3, passed: 1 });
    expect(details(calls).map((c) => c.url)).toEqual([`https://jobsireland.ie/api/jobs/${hex(3)}`]);
    expect((await saved()).map((x) => x.status)).toEqual(["live", "live", "live"]);
  });
  it("a job gone from a list that worked closes; a list that failed closes nothing", async () => {
    const { r } = await run(cards.slice(1));
    expect(r).toMatchObject({ ok: true, closed: 1 });
    expect((await saved()).map((x) => x.status)).toEqual(["closed", "live", "live"]);
    const failed = await run(cards.slice(1), (url) => (url.includes("/api/jobs?") ? reply({}, 503) : undefined));
    expect(failed.r).toMatchObject({ ok: false, closed: 0 });
    expect((await saved()).map((x) => x.status)).toEqual(["closed", "live", "live"]);
  });
});

describe("the cross-source duplicate rule (0065)", () => {
  let n = 0;
  /** Two fake boards of one world: a JobsIreland one and an employer's own hiring system (`sitemap`), each listing what the test puts there. */
  function world() {
    const w = ++n;
    const boards = { jobsireland: new Map<string, RawAdvert>(), sitemap: new Map<string, RawAdvert>() };
    const name = `Dup Fake ${w} Ltd`;
    const task = (kind: keyof typeof boards): BoardTask => ({ kind, board: `dup${w}`, rereadDays: 1, fetch: async (known) => {
      const all = [...boards[kind].values()];
      return { seen: all.map((a) => a.id), adverts: all.filter((a) => !known.has(a.id)) };
    } });
    return {
      name,
      put(kind: keyof typeof boards, id: string, title: string, employer = name) { boards[kind].set(id, advert(`${kind}-${w}-${id}`, { title, employer, url: `https://jobs.example.test/${kind}/${w}/${id}` })); },
      drop(kind: keyof typeof boards, id: string) { boards[kind].delete(id); },
      async fetch(...kinds: (keyof typeof boards)[]) {
        const tasks = kinds.map(task);
        return runBoards(deps(db.pool("app_fetcher"), tasks, { now: at }), (a) => plan(a, "passed"));
      },
      async job(kind: keyof typeof boards, id: string) {
        const [r] = await su("select j.id::text, j.status, j.hidden_reason, j.twin_of_job_id::text as twin from job j join fetched_advert f on f.id = j.fetched_advert_id where f.external_id = $1", [`fake:b:${kind}-${w}-${id}`]);
        return r as { id: string; status: string; hidden_reason: string | null; twin: string | null };
      },
    };
  }

  it("one twin on another source hides the JobsIreland job, whichever comes first", async () => {
    const a = world();
    a.put("sitemap", "1", "Boner");
    await a.fetch("sitemap");
    a.put("jobsireland", "1", "BONER!");
    await a.fetch("jobsireland");
    const own = await a.job("sitemap", "1");
    expect(await a.job("jobsireland", "1")).toMatchObject({ status: "hidden", hidden_reason: "duplicate", twin: own.id });
    expect(own.status).toBe("live");
    // the other way round: the JobsIreland job is live first, the employer's own goes live after
    const b = world();
    b.put("jobsireland", "1", "Butcher");
    await b.fetch("jobsireland");
    expect((await b.job("jobsireland", "1")).status).toBe("live");
    b.put("sitemap", "1", "Butcher");
    await b.fetch("sitemap");
    expect(await b.job("jobsireland", "1")).toMatchObject({ status: "hidden", hidden_reason: "duplicate", twin: (await b.job("sitemap", "1")).id });
    // later fetches leave it hidden
    await b.fetch("jobsireland", "sitemap");
    expect((await b.job("jobsireland", "1")).status).toBe("hidden");
  });
  it("two twins hide nothing; no company link hides nothing; another title hides nothing", async () => {
    const a = world();
    a.put("sitemap", "1", "Deboner");
    a.put("sitemap", "2", "Deboner");
    a.put("sitemap", "3", "Packer");
    await a.fetch("sitemap");
    a.put("jobsireland", "1", "Deboner");
    a.put("jobsireland", "2", "Packer", "Some Other Fake Ltd"); // a name the fetcher links to another company
    a.put("jobsireland", "3", "Forklift Driver");
    await a.fetch("jobsireland");
    for (const id of ["1", "2", "3"]) expect((await a.job("jobsireland", id)).status, id).toBe("live");
    // two JobsIreland jobs of one title and one own job: the own job hides neither (one to one)
    const b = world();
    b.put("jobsireland", "1", "Chef");
    b.put("jobsireland", "2", "Chef");
    await b.fetch("jobsireland");
    b.put("sitemap", "1", "Chef");
    await b.fetch("sitemap");
    expect([(await b.job("jobsireland", "1")).status, (await b.job("jobsireland", "2")).status]).toEqual(["live", "live"]);
  });
  it("when the twin closes, the JobsIreland job comes back live; if its own advert went meanwhile, it closes", async () => {
    const a = world();
    a.put("sitemap", "1", "Meat Inspector");
    a.put("jobsireland", "1", "Meat Inspector");
    await a.fetch("sitemap");
    await a.fetch("jobsireland");
    expect((await a.job("jobsireland", "1")).status).toBe("hidden");
    a.drop("sitemap", "1");
    a.put("sitemap", "2", "Other Role"); // the board still lists something, so the fetch counts as good
    await a.fetch("sitemap");
    expect((await a.job("sitemap", "1")).status).toBe("closed");
    expect(await a.job("jobsireland", "1")).toMatchObject({ status: "live", hidden_reason: null, twin: null });
    const b = world();
    b.put("sitemap", "1", "Yard Operative");
    b.put("sitemap", "2", "Other Role");
    b.put("jobsireland", "1", "Yard Operative");
    b.put("jobsireland", "2", "Other Role 2");
    await b.fetch("sitemap", "jobsireland");
    expect((await b.job("jobsireland", "1")).status).toBe("hidden");
    b.drop("jobsireland", "1");
    await b.fetch("jobsireland"); // its advert is gone; the hidden job is staff's to keep, so only the advert is marked
    b.drop("sitemap", "1");
    await b.fetch("sitemap");
    expect(await b.job("jobsireland", "1")).toMatchObject({ status: "closed", hidden_reason: null });
  });
  it("a staff job taking over the holder keeps the JobsIreland job hidden under it; staff hiding the holder brings it back", async () => {
    const a = world();
    a.put("sitemap", "1", "Quality Technician");
    a.put("jobsireland", "1", "Quality Technician");
    await a.fetch("sitemap");
    await a.fetch("jobsireland");
    const holder = await a.job("sitemap", "1");
    const [{ org, src }] = await su("select organisation_id::text as org, (select id::text from job_source where kind = 'portal' and board = 'employer') as src from job where id = $1", [holder.id]);
    await db.query("app_admin",
      `insert into job(organisation_id, source, job_source_id, title, employer_name, county, sector, permit_type, salary_low, status, closes_at, search_vector, own_page_url)
       values ($1, 'admin_manual', $2, 'Quality technician', $3, null, 'IT', 'critical_skills', 60000, 'live', now() + interval '29 days', to_tsvector('english', 'fake'), 'https://example.test/apply')`, [org, src, a.name]);
    expect((await a.job("sitemap", "1")).hidden_reason).toBe("duplicate"); // 0057: the staff job hides the fetched one
    expect(await a.job("jobsireland", "1")).toMatchObject({ status: "hidden", twin: holder.id }); // still under its holder, not shown twice
    const b = world();
    b.put("sitemap", "1", "Lab Analyst");
    b.put("jobsireland", "1", "Lab Analyst");
    await b.fetch("sitemap");
    await b.fetch("jobsireland");
    await db.query("app_admin", "update job set status = 'hidden', hidden_reason = 'admin' where id = $1", [(await b.job("sitemap", "1")).id]);
    expect((await b.job("jobsireland", "1")).status).toBe("live");
  });
});
