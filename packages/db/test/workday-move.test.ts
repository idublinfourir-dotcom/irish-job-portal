// Integration (W1c): the one-off Workday move through the real command, main(argv, env, log), against the real test database, and the next
// fetch of the career-site kinds on top of it. The Workday rows are written by the real fetcher (a fake Workday board), as they are live.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/workday-move-cli";
import { requisition } from "../src/workday-move";
import { createTestDb, urlFor, type TestDb } from "./db";
import { runBoards } from "../../fetcher/src";
import { advert, careerRun, deps, fakeModel, plan, task } from "../../fetcher/test/helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb;
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p).then((r) => r.rows);
// What the Workday adapter saved for these employers: `workday:<tenant>:<externalPath>`.
const WORKDAY: [tenant: string, path: string][] = [
  ["mastercard", "/job/Dublin-Ireland/Senior-Enterprise-Operations-Engineer_R-291229"],
  ["thermofisher", "/job/Athlone/CMBL---Scientist-I_R-01367934"],
  ["thermofisher", "/job/Athlone/CMBL---Scientist-I_R-01367934-1"], // the same requisition posted again: one of the two moves
  ["citi", "/job/Dublin--Ireland/Data-Engineer--Officer-_261007676"],
  ["fmr", "/job/Galway-Ireland/Data-Engineer_2136526"],
  ["salesforce", "/job/Ireland---Dublin/Senior-Success-Architect-Industry_JR317362"],
  ["abbott", "/job/Kilkenny/Warehouse-Operator_31165733"],
  ["amat", "/job/Leixlip/Customer-Support-Technician_R2614187"], // W1e: Applied Materials, now eightfold
  ["statestreet", "/job/Dublin/no-requisition-here"], // no id: stays
  ["pfizer", "/job/Cork/Engineer_4900001"], // not one of the seven: never touched
];
const ENV = (role = "app_fetcher") => ({ FETCHER_DATABASE_URL: urlFor(db.name, role), DATABASE_SSL: "disable" });
async function move(...argv: string[]) {
  const out: string[] = [];
  const code = await main(argv, ENV(), (l) => out.push(l));
  return { code, out };
}
const snapshot = async () => ({
  adverts: await su("select id, job_source_id, external_id, gone_at from fetched_advert order by id"),
  jobs: await su("select id, job_source_id, fetched_advert_id, status from job order by id"),
  sources: await su("select id, kind, board from job_source order by id"),
});
const rowOf = async (externalId: string) =>
  (await su("select f.id::int as advert, s.kind, s.board, j.id::int as job, j.status, js.kind as job_kind from fetched_advert f join job_source s on s.id = f.job_source_id left join job j on j.fetched_advert_id = f.id left join job_source js on js.id = j.job_source_id where f.external_id = $1", [externalId]));

beforeAll(async () => {
  db = await createTestDb();
  for (const tenant of new Set(WORKDAY.map(([t]) => t))) {
    const ads = WORKDAY.filter(([t]) => t === tenant).map(([, path], i) => advert(`${i}`, { id: `workday:${tenant}:${path}`, source: "workday", board: tenant, title: `${tenant} job ${i}`, url: `https://${tenant}.wd1.myworkdayjobs.com${path}` }));
    const [r] = await runBoards(deps(db.pool("app_fetcher"), [task("workday", tenant, ads)], { checkBatch: fakeModel().checkBatch }), (x) => plan(x, "passed"));
    expect(r).toMatchObject({ ok: true, passed: ads.length });
  }
});
afterAll(() => db.drop());

describe("requisition", () => {
  it("reads the id at the end of a Workday path, without the -1 of a second posting", () => {
    expect(WORKDAY.map(([, p]) => requisition(`workday:x:${p}`))).toEqual(["R-291229", "R-01367934", "R-01367934", "261007676", "2136526", "JR317362", "31165733", "R2614187", null, "4900001"]);
    expect(requisition("workday:amat:/job/Dublin/Electronics-Engineer_R2626678-1")).toBe("R2626678");
    expect(requisition("workday:citi:/job/Dublin--Ireland/Senior-Full-Stack---AI-Engineering-Manager---Java---Angular_261009111-1")).toBe("261009111");
  });
});

describe("the Workday move (W1c)", () => {
  it("the dry run writes nothing and says what it would move", async () => {
    const before = await snapshot();
    const { code, out } = await move();
    expect(code).toBe(0);
    expect(out[0]).toBe("dry run, nothing written: 7 Workday adverts would move (add --apply to write)");
    expect(out).toContain("  thermofisher: 1 would move, 1 already under the new source, 0 with no requisition id (stay)");
    expect(out).toContain("  statestreet: 0 would move, 0 already under the new source, 1 with no requisition id (stay)");
    expect(out).toContain("  would move: workday:amat:/job/Leixlip/Customer-Support-Technician_R2614187 -> eightfold:amat:R2614187");
    expect(out).toContain("  would move: workday:citi:/job/Dublin--Ireland/Data-Engineer--Officer-_261007676 -> sitemap:citi:261007676");
    expect(await snapshot()).toEqual(before);
  });

  it("--apply moves each matched advert and its job once, keeping the job's id; a second run moves nothing", async () => {
    const job = (await rowOf(`workday:mastercard:${WORKDAY[0]![1]}`))[0].job;
    const { code, out } = await move("--apply");
    expect([code, out[0]]).toEqual([0, "7 Workday adverts moved, 7 jobs with them"]);
    expect(await rowOf("phenom:mastercard:R-291229")).toEqual([{ advert: expect.any(Number), kind: "phenom", board: "mastercard", job, status: "live", job_kind: "phenom" }]);
    for (const id of ["phenom:thermofisher:R-01367934", "phenom:abbott:31165733", "sitemap:citi:261007676", "sitemap:fmr:2136526", "salesforce:salesforce:JR317362", "eightfold:amat:R2614187"]) expect(await rowOf(id), id).toHaveLength(1);
    // left as they were: the second posting, the row with no id, the other employer
    expect(Number((await su("select count(*) from fetched_advert f join job_source s on s.id = f.job_source_id where s.kind = 'workday'"))[0].count)).toBe(3);
    const before = await snapshot();
    expect((await move("--apply")).out[0]).toBe("0 Workday adverts moved, 0 jobs with them");
    expect(await snapshot()).toEqual(before);
  });

  it("the new boards take over the Workday boards' last good fetch, so the stale close does not fire on the moved jobs at once", async () => {
    const pairs = await su("select n.kind, n.board, n.last_ok_at = w.last_ok_at as same from job_source n join job_source w on w.board = n.board and w.kind = 'workday' where n.kind <> 'workday' order by n.board");
    expect(pairs.length).toBe(8);
    for (const p of pairs) expect(p.same, `${p.kind}:${p.board}`).toBe(true);
  });

  it("the next fetch finds the moved jobs known: no twin, no page call for them, the same job stays live", async () => {
    const jobs = Number((await su("select count(*) from job"))[0].count);
    const { reports, calls } = await careerRun(db);
    expect(reports.every((r) => r.ok)).toBe(true);
    for (const id of ["phenom:mastercard:R-291229", "phenom:thermofisher:R-01367934", "sitemap:citi:261007676", "sitemap:fmr:2136526", "salesforce:salesforce:JR317362", "eightfold:amat:R2614187"]) {
      const rows = await rowOf(id);
      expect(rows, id).toHaveLength(1);
      expect(rows[0].status, id).toBe("live");
    }
    expect(calls.filter((c) => c.includes("/job/R-291229/") || c.includes("/job/R-01367934/") || c.includes("/ie/jobs/2136526/") || c.includes("position_id=790314592423"))).toEqual([]);
    // only the jobs that were never on Workday are new: Thermo R-01369062, Citi 261007029, Fidelity 2136258, Salesforce JR327834, 12 of Applied Materials' 13
    expect(Number((await su("select count(*) from job"))[0].count)).toBe(jobs + 4 + 12);
  });

  it("only the fetcher's login can run it; any other role is refused and nothing is written", async () => {
    const before = await snapshot();
    for (const role of ["app_candidate", "app_portal", "app_admin", "app_backup"]) await expect(main(["--apply"], ENV(role), () => {}), role).rejects.toThrow(/permission denied/);
    expect(await snapshot()).toEqual(before);
  });

  it("the new grant lets the fetcher re-point only fetched jobs; bad arguments and a missing login stop before connecting", async () => {
    const [{ id: org }] = await su("insert into organisation(slug, display_name, kind) values ('move-fake', 'Move Fake Ltd', 'employer') returning id");
    const [{ id: src }] = await su("select id from job_source where kind = 'admin'");
    const [{ id: manual }] = await su(
      "insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url) values ($1, 'admin_manual', $2, 't', 'e', 'it', 'critical_skills', 'draft', now() + interval '10 days', 'https://example.test/m') returning id", [org, src]);
    await expect(db.query("app_fetcher", "update job set job_source_id = $1 where id = $2", [src, manual])).rejects.toThrow(/the fetcher writes only fetched jobs/);
    await expect(db.query("app_fetcher", "update job set organisation_id = organisation_id where id = $1", [manual])).rejects.toThrow(/permission denied/);
    for (const argv of [["--aply"], ["--apply", "--apply"], ["x"]]) expect(await main(argv, ENV(), () => {})).toBe(2);
    expect(await main([], {}, () => {})).toBe(2);
  });
});
