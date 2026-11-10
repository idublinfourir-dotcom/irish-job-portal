// Integration: runBoards against the real test database, connected as app_fetcher. Design 3.1 to 3.6.
// Plans are written by hand (helpers.plan) except in the matcher test, which uses the real chain and planAdvert.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../db/test/db";
import { planAdvert, runBoards, type BoardTask } from "../src";
import { advert, counting, deps, NOW, plan, task } from "./helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// The statement counts below are the exact budget. The time only catches a gross slowdown: 2.2 to 2.6 s run alone, 9.8 s inside the
// full check with every test file writing to the same server, so the limit is about three times that. 1,000 adverts is one
// large day, and the whole daily run has 65 minutes.
const PERF_MS = 30_000;
let db: TestDb;
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p).then((r) => r.rows);
const fetcher = () => db.pool("app_fetcher");
const run = (boards: BoardTask[], p: Parameters<typeof runBoards>[1], over = {}) => runBoards(deps(fetcher(), boards, over), p);
let n = 0;
const board = () => `b${++n}`; // each test gets its own board, so tests do not see each other's adverts
const count = async (table: string, where = "true") => Number((await su(`select count(*) from ${table} where ${where}`))[0].count);

beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());

describe("one board, every case", () => {
  it("passed: source, run, advert, live job with badge and search vector, text, and a new unclaimed organisation with an alias", async () => {
    const b = board(), a = advert("p1", { employer: "Zeta Fake Works Ltd.", title: "Quantum Engineer" });
    const [r] = await run([task("fake", b, [a])], (x) => plan(x, "passed"));
    expect(r).toMatchObject({ ok: true, passed: 1, seen: 1, unsaved: [] });
    const [src] = await su("select * from job_source where kind='fake' and board=$1", [b]);
    expect(src.last_ok_at).not.toBeNull();
    expect(src.last_error).toBeNull();
    const [fr] = await su("select * from fetch_run where job_source_id=$1", [src.id]);
    expect(fr).toMatchObject({ seen: 1, new: 1, closed: 0, error: null });
    expect(fr.finished_at.toISOString()).toBe(NOW.toISOString());
    const [fa] = await su("select * from fetched_advert where job_source_id=$1", [src.id]);
    expect(fa).toMatchObject({ external_id: a.id, result: "passed", employer_name: "Zeta Fake Works Ltd." });
    const [j] = await su("select j.*, j.search_vector @@ websearch_to_tsquery('english','quantum') as hit from job j where fetched_advert_id=$1", [fa.id]);
    expect(j).toMatchObject({ source: "fetched", status: "live", badge: "critical_skills_eligible", pass_route: "stated_pay", permit_type: "critical_skills", hit: true, own_page_url: a.url });
    expect((await su("select advert_text from job_text where job_id=$1", [j.id]))[0].advert_text).toBe(a.description);
    const [o] = await su("select * from organisation where id=$1", [j.organisation_id]);
    expect(o).toMatchObject({ slug: "zeta-fake-works-ltd", display_name: "Zeta Fake Works Ltd.", kind: "employer", status: "unclaimed" });
    expect(await su("select kind, source, normalised_name from organisation_name where organisation_id=$1", [o.id])).toEqual([{ kind: "alias", source: "job_site", normalised_name: "zeta fake works ltd" }]);
  });

  it("queued: an in_review job with no badge and no pass route; the trigger adds the admin queue item", async () => {
    const a = advert("q1", { employer: "Queue Fake Ltd" });
    const [r] = await run([task("fake", board(), [a])], (x) => plan(x, "queued"));
    expect(r).toMatchObject({ queued: 1 });
    const [j] = await su("select j.* from job j join fetched_advert f on f.id=j.fetched_advert_id where f.external_id=$1", [a.id]);
    expect(j).toMatchObject({ status: "in_review", badge: null, pass_route: null });
    expect(await count("job_text", `job_id=${j.id}`)).toBe(1);
    expect((await su("select queue from review_item where job_id=$1", [j.id])).map((x) => x.queue)).toEqual(["fetched_job"]);
  });

  it("rejected: an advert row only, no job, no text, no organisation", async () => {
    const a = advert("r1", { employer: "Reject Fake Ltd" });
    const orgs = await count("organisation");
    const [r] = await run([task("fake", board(), [a])], (x) => plan(x, "reject"));
    expect(r).toMatchObject({ rejected: 1 });
    const [fa] = await su("select * from fetched_advert where external_id=$1", [a.id]);
    expect(fa.result).toBe("rejected");
    expect(await count("job", `fetched_advert_id=${fa.id}`)).toBe(0);
    expect(await count("organisation")).toBe(orgs);
  });

  it("a known employer under another spelling reuses the organisation", async () => {
    const list = [advert("k1", { employer: "Known Fake Co" }), advert("k2", { employer: "KNOWN, FAKE co!" })];
    await run([task("fake", board(), list)], (x) => plan(x, "passed"));
    expect(await count("organisation", "slug like 'known-fake-co%'")).toBe(1);
    expect(await count("job j join fetched_advert f on f.id=j.fetched_advert_id", "f.external_id in ('fake:b:k1','fake:b:k2')")).toBe(2);
  });

  it("an unknown employer on two boards at once gives one organisation", async () => {
    const mk = (i: number) => task("fake", board(), [advert(`race${i}`, { employer: "Race Fake Ltd" })]);
    const reports = await run([mk(1), mk(2), mk(3), mk(4)], (x) => plan(x, "passed"), { concurrency: 4 });
    expect(reports.map((r) => r.passed + r.unsaved.length)).toEqual([1, 1, 1, 1]);
    expect(reports.reduce((s, r) => s + r.passed, 0)).toBeGreaterThanOrEqual(3); // a lost race retries once; any rest stays unsaved for the next run
    expect(await count("organisation", "slug like 'race-fake-ltd%'")).toBe(1);
  });

  it("a taken slug gets -2", async () => {
    await su("insert into organisation(slug, display_name, kind) values('slug-fake-ltd','Someone Else','employer')");
    await run([task("fake", board(), [advert("s1", { employer: "Slug Fake Ltd" })])], (x) => plan(x, "passed"));
    expect((await su("select slug from organisation where display_name='Slug Fake Ltd'"))[0].slug).toBe("slug-fake-ltd-2");
  });

  it("a merged organisation is followed one step", async () => {
    const [to] = await su("insert into organisation(slug, display_name, kind) values('merged-to','Merged To','employer') returning id");
    const [from] = await su("insert into organisation(slug, display_name, kind, merged_into_id) values('merged-from','Merged From Fake','employer',$1) returning id", [to.id]);
    await su("insert into organisation_name(organisation_id,name,normalised_name,kind,source) values($1,'Merged From Fake','merged from fake','legal','admin')", [from.id]);
    const a = advert("m1", { employer: "Merged From Fake" });
    await run([task("fake", board(), [a])], (x) => plan(x, "passed"));
    expect((await su("select organisation_id from job j join fetched_advert f on f.id=j.fetched_advert_id where f.external_id=$1", [a.id]))[0].organisation_id).toBe(to.id);
  });

  it("an employer with only punctuation is saved as rejected with its own stage; a suspended one too", async () => {
    await su("insert into organisation(slug, display_name, kind, status) values('susp-fake','Susp Fake','employer','suspended') returning id").then(async ([o]) =>
      su("insert into organisation_name(organisation_id,name,normalised_name,kind,source) values($1,'Susp Fake','susp fake','alias','admin')", [o.id]));
    const list = [advert("e1", { employer: "?!..." }), advert("e2", { employer: "Susp Fake" })];
    const [r] = await run([task("fake", board(), list)], (x) => plan(x, "passed"));
    expect(r).toMatchObject({ rejected: 2, passed: 0, unsaved: [] });
    const rows = await su("select external_id, result, stage from fetched_advert where external_id in ($1,$2) order by external_id", list.map((a) => a.id));
    expect(rows).toEqual([
      { external_id: list[0]!.id, result: "rejected", stage: "0 no employer name" },
      { external_id: list[1]!.id, result: "rejected", stage: "0 employer suspended, banned or closed" },
    ]);
    expect(await count("job", "employer_name in ('?!...','Susp Fake')")).toBe(0);
  });

  it("a write that fails half way leaves nothing: no advert, no organisation, no name; the id stays unsaved", async () => {
    const a = advert("t1", { employer: "Torn Fake Ltd" });
    const [r] = await run([task("fake", board(), [a])], (x) => plan(x, "passed", { salaryLow: 2_147_483_648 })); // integer overflow at the job insert
    expect(r).toMatchObject({ passed: 0, unsaved: [a.id], ok: true });
    expect(await count("fetched_advert", `external_id='${a.id}'`)).toBe(0);
    expect(await count("organisation", "slug like 'torn-fake-ltd%'")).toBe(0);
  });

  it("a crash between adverts keeps what was saved", async () => {
    const list = [advert("c1", { employer: "Crash Fake A" }), advert("c2", { employer: "Crash Fake B" }), advert("c3", { employer: "Crash Fake C" })];
    const [r] = await run([task("fake", board(), list)], (x) => { if (x.id.endsWith(":c2")) throw new Error("boom"); return plan(x, "passed"); });
    expect(r).toMatchObject({ passed: 2, unsaved: [list[1]!.id] });
    expect(await count("fetched_advert", "external_id in ('fake:b:c1','fake:b:c3')")).toBe(2);
    expect(await count("fetched_advert", "external_id = 'fake:b:c2'")).toBe(0);
  });

  it("a deadline already past saves nothing and still closes the run row", async () => {
    const b = board();
    const [r] = await run([task("fake", b, [advert("d1")])], (x) => plan(x, "reject"), { deadline: new Date(NOW.getTime() - 1) });
    expect(r).toMatchObject({ ok: true, unsaved: ["fake:b:d1"] });
    expect(await count("fetched_advert", "external_id='fake:b:d1'")).toBe(0);
    expect((await su("select fr.finished_at from fetch_run fr join job_source s on s.id=fr.job_source_id where s.board=$1", [b]))[0].finished_at).not.toBeNull();
  });
});

describe("a second run", () => {
  it("inserts nothing and moves last_seen_at; the fetch is handed the known ids", async () => {
    const b = board(), list = [advert("n1", { employer: "Again Fake Ltd" }), advert("n2")];
    const t = task("fake", b, list);
    await run([t], (x) => plan(x, x.id.endsWith("n1") ? "passed" : "reject"));
    const before = await su("select external_id, last_seen_at from fetched_advert where external_id in ($1,$2) order by 1", list.map((a) => a.id));
    const later = new Date(NOW.getTime() + 6 * 3600e3);
    const [r] = await run([t], (x) => plan(x, "passed"), { now: () => later });
    expect([...t.calls[1]!].sort()).toEqual(list.map((a) => a.id).sort());
    expect(r).toMatchObject({ ok: true, seen: 2, passed: 0, queued: 0, rejected: 0, unsaved: [] });
    const after = await su("select external_id, last_seen_at from fetched_advert where external_id in ($1,$2) order by 1", list.map((a) => a.id));
    expect(after).toHaveLength(2);
    for (const [i, row] of after.entries()) { expect(row.last_seen_at.toISOString()).toBe(later.toISOString()); expect(row.last_seen_at > before[i].last_seen_at).toBe(true); }
    expect(await su("select seen, new from fetch_run fr join job_source s on s.id=fr.job_source_id where s.board=$1 order by fr.id", [b])).toEqual([{ seen: 2, new: 2 }, { seen: 2, new: 0 }]);
  });
});

describe("failures", () => {
  it("a failed fetch: run and source rows say why, last_ok_at stays, nothing else changes", async () => {
    const b = board();
    await run([task("fake", b, [advert("f1")])], (x) => plan(x, "reject"));
    const ok = (await su("select last_ok_at from job_source where board=$1", [b]))[0].last_ok_at;
    const bad: BoardTask = { kind: "fake", board: b, fetch: async () => { throw new Error("HTTP 429 ".repeat(100)); } };
    const [r] = await run([bad], undefined, { now: () => new Date(NOW.getTime() + 1000) });
    expect(r!.ok).toBe(false);
    const [s] = await su("select * from job_source where board=$1", [b]);
    expect(s.last_error).toHaveLength(300);
    expect(s.last_ok_at).toEqual(ok);
    const runs = await su("select error, finished_at from fetch_run where job_source_id=$1 order by id", [s.id]);
    expect(runs[1].error).toBe(s.last_error);
    expect(runs[1].finished_at).not.toBeNull();
    expect(await count("fetched_advert", `job_source_id=${s.id}`)).toBe(1);
  });

  it("an empty answer while adverts were known is a failed fetch", async () => {
    const b = board();
    await run([task("fake", b, [advert("g1")])], (x) => plan(x, "reject"));
    const [r] = await run([{ kind: "fake", board: b, fetch: async () => ({ seen: [], adverts: [] }) }], undefined);
    expect(r).toMatchObject({ ok: false, error: "returned nothing while 1 adverts were known" });
    expect((await su("select last_error from job_source where board=$1", [b]))[0].last_error).toBe(r!.error);
  });

  it("a matcher model error writes nothing and the advert comes back; a bad answer is queued (real chain and planAdvert)", async () => {
    const b = board();
    const list = [advert("mm1", { employer: "Model Fake Ltd" })];
    const t = task("fake", b, list);
    const model = (failure: { kind: "model error" | "bad answer"; why: string } | null) =>
      async () => ({ match: { occupationCode: "none", onCriticalSkillsList: "unknown" as const, confidence: "low" as const }, quote: "words", modelId: "fake-model", failure });
    const [r1] = await run([t], planAdvert, { matcher: model({ kind: "model error", why: "down" }) });
    expect(r1).toMatchObject({ unsaved: [list[0]!.id], passed: 0, queued: 0, rejected: 0 });
    expect(await count("fetched_advert", "external_id='fake:b:mm1'")).toBe(0);
    const [r2] = await run([t], planAdvert, { matcher: model({ kind: "bad answer", why: "junk" }) });
    expect(r2).toMatchObject({ queued: 1, unsaved: [] });
    expect((await su("select j.status, f.matcher_model from job j join fetched_advert f on f.id=j.fetched_advert_id where f.external_id='fake:b:mm1'"))[0]).toEqual({ status: "in_review", matcher_model: "fake-model" });
  });
});

describe("security", () => {
  const evil = "x'); drop table job; --";
  it("SQL-looking text in every field is stored as text, with U+0000 removed", async () => {
    const a = advert("sec1", { employer: `Evil${evil} Ltd`, title: `T${evil}\0`, url: `https://e.example.test/${evil}\0`, description: `D${evil}\0 more` });
    const p = plan(a, "passed");
    if (p.action !== "job") throw new Error("plan");
    p.advert.stage = evil + "\0"; p.advert.reason = evil; p.advert.quotedEvidence = evil + "\0"; p.advert.matcherModel = evil; p.job.county = evil; p.job.sector = evil; p.job.occupationCode = evil;
    const [r] = await run([task("fake", `b${evil}`, [a])], () => p);
    expect(r).toMatchObject({ passed: 1 });
    const [j] = await su("select j.title, j.sector, j.county, j.own_page_url, f.stage, f.reason, f.quoted_evidence, f.matcher_model, t.advert_text from job j join fetched_advert f on f.id=j.fetched_advert_id join job_text t on t.job_id=j.id where f.external_id=$1", [a.id]);
    expect(j).toEqual({ title: `T${evil}`, sector: evil, county: evil, own_page_url: `https://e.example.test/${evil}`, stage: evil, reason: evil, quoted_evidence: evil, matcher_model: evil, advert_text: `D${evil} more` });
    expect(await count("job")).toBeGreaterThan(0); // the table still exists
    expect(await count("job_source", `board='b${evil.replaceAll("'", "''")}'`)).toBe(1);
    expect((await su("select display_name from organisation where display_name like 'Evil%'"))[0].display_name).toBe(`Evil${evil} Ltd`);
  });

  it.each(["app_candidate", "app_portal"] as const)("run as %s: refused at the first statement, nothing written, reported not thrown", async (role) => {
    const before = await count("job_source");
    const [r] = await runBoards(deps(db.pool(role), [task("fake", board(), [advert("role1")])]), (x) => plan(x, "passed"));
    expect(r).toMatchObject({ ok: false, passed: 0 });
    expect(r!.error).toMatch(/permission denied/);
    expect(await count("job_source")).toBe(before);
  });
});

describe("performance", () => {
  it("1,000 adverts: statements per advert and per board are within budget, and so is the time", async () => {
    const b = board();
    // 700 rejected, 300 jobs. Half of the jobs use 5 employers that already exist, half each a new employer.
    await run([task("fake", board(), Array.from({ length: 5 }, (_, i) => advert(`seed${i}`, { employer: `Perf Old ${i} Ltd` })))], (x) => plan(x, "passed"));
    const list = Array.from({ length: 1000 }, (_, i) => advert(`perf${i}`, { employer: i < 700 ? "Rejected Ltd" : i < 850 ? `Perf Old ${i % 5} Ltd` : `Perf New ${i} Ltd` }));
    const rejected = new Set(list.slice(0, 700).map((a) => a.id));
    const { db: wrapped, sql } = counting(fetcher());
    const t0 = performance.now();
    const [r] = await runBoards(deps(wrapped, [task("fake", b, list)]), (x) => plan(x, rejected.has(x.id) ? "reject" : "passed"));
    const ms = performance.now() - t0;
    expect(r).toMatchObject({ rejected: 700, passed: 300, unsaved: [] });
    const boardStatements = sql.filter((s) => /^(insert into job_source|insert into fetch_run|select external_id|with seen)/.test(s)).length;
    const perRejected = sql.filter((s) => s.startsWith("insert into fetched_advert")).length - 300;
    const jobs = sql.filter((s) => s.startsWith("insert into job(")).length;
    console.log(`perf: ${sql.length} statements, ${boardStatements} per board, ${ms.toFixed(0)} ms`);
    expect(boardStatements).toBe(4);
    expect(perRejected).toBe(700); // one statement each
    expect(jobs).toBe(300);
    // 4 per board, 1 per rejected advert, at most 9 per job (6 with a known employer, 9 with a new one)
    expect(sql.length).toBeLessThanOrEqual(4 + 700 + 150 * 6 + 150 * 9);
    expect(ms).toBeLessThan(PERF_MS);
  });
});
