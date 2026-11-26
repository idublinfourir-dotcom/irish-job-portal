// Integration: a rules change reaches the live fetched jobs whose advert is the same (#93, #261). The real rules chain, the real planAdvert and recheckLive on the real
// test database as app_fetcher. The model is a fake; adverts and boards are made up (Google, Stripe and the HSE only by name, which is what the rules read). No network.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAIN_RULES_V1, HSE_ENTRY, MINIMUMS_V1, type ListRules, type PayRules } from "@portal/rules";
import { createTestDb, type Role, type TestDb } from "../../db/test/db";
import { isDue, RECHECK, recheckLive, runBoards, type BoardTask, type Deps } from "../src";
import { advert, counting, deps, fakeModel, LISTS_V1, noModel, NOW, task } from "./helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const PERF_MS = 5_000; // 2,000 live jobs; live has 466

let db: TestDb;
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p).then((r) => r.rows);
const fetcher = () => db.pool("app_fetcher");
type Rules = PayRules & ListRules;
const rules = (over: Partial<Rules> = {}): Rules => ({ ...CHAIN_RULES_V1, publicPayCandidates: new Map<string, 1 | 2>([[HSE_ENTRY, 1]]), occupationLists: LISTS_V1, ...over });
const raised = (criticalSkills: number) => rules({ minimums: { ...MINIMUMS_V1, criticalSkills } });
const run = (boards: BoardTask[], r: Rules = rules(), over: Partial<Deps> = {}) => {
  const d = deps(fetcher(), boards, { checkBatch: fakeModel().checkBatch, ...over });
  return runBoards({ ...d, chain: { ...d.chain, ...r } });
};
let n = 0;
const board = () => `r${++n}`;
/** An advert the model backs, with this employer and pay text; its board's reread day is another one, so only a lost hash hands it back. */
const ad = (b: string, name: string, employer: string, pay = "") => {
  for (let i = 0; ; i++) {
    const a = advert(`${b}-${name}-${i}`, { employer, title: "Platform Engineer", description: `Join our team. ${pay} Permanent full time.` });
    if (!isDue(a.id, 7, NOW)) return a;
  }
};
const look = async (id: string) =>
  (await su(`select f.result, f.stage, f.content_hash is not null as hash, j.id::text as job, j.status, j.close_reason, j.badge, j.pass_route, j.search_vector is not null as vector,
      (select count(*)::int from job_text t where t.job_id = j.id) as texts from fetched_advert f left join job j on j.fetched_advert_id = f.id where f.external_id = $1`, [id]))[0];
/** The recovery statement of docs/job-rules.md, as written there. */
const recovery = () => /`(update fetched_advert f set content_hash = null [^`]+)`/.exec(readFileSync(new URL("../../../docs/job-rules.md", import.meta.url), "utf8"))![1]!;
// #305: the lists with one code taken off, or moved to the Ineligible list; and a matcher that takes the code from "Role: <word>." in the advert
const lists = (code: string, to: "off" | "ineligible") => rules({ occupationLists: LISTS_V1.flatMap((e) => (e.code !== code ? [e] : to === "off" ? [] : [{ ...e, list: "ineligible" }])) });
const CODES: Record<string, string> = { programmer: "2136", analyst: "2135", mixed: "212x/213x" };
const byRole: Deps["matcher"] = async (_t, d) => ({
  match: { occupationCode: CODES[/Role: (\w+)\./.exec(d)?.[1] ?? ""] ?? "2134", onCriticalSkillsList: "yes", confidence: "high" }, quote: null, modelId: "rules", failure: null,
});
const LIVE = { status: "live", close_reason: null, badge: "critical_skills_eligible", vector: true, texts: 1, hash: true };
const CLOSED = { status: "closed", close_reason: "recheck_failed", vector: false, texts: 0, hash: false };

beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());
beforeEach(() => su("update job set status = 'closed', close_reason = 'closed', search_vector = null where source = 'fetched' and status = 'live'"));

describe("a raised minimum (#93)", () => {
  it("closes the job whose top pay is under it, hostile name and all; a range that crosses, the pay scale and the big company stay; the next fetch refuses it with no model request", async () => {
    const b = board();
    const low = ad(b, "low", "O'Brien\"); drop table job; --", "The salary is €41,500 a year."), range = ad(b, "range", "Acme Ltd", "The salary is €41,500 to €55,000 a year.");
    const high = ad(b, "high", "Acme Ltd", "The salary is €60,000 a year."), big = ad(b, "big", "Google"), hse = ad(b, "hse", "HSE Mid West"), all = [low, range, high, big, hse];
    expect(await run([task("fake", b, all)])).toMatchObject([{ passed: 5 }]);
    for (const a of all) expect(await look(a.id)).toMatchObject(LIVE);
    expect(await recheckLive(fetcher(), rules())).toEqual({ closed: 0, moved: 0 }); // the same rules: nothing
    expect(await recheckLive(fetcher(), raised(43_000))).toEqual({ closed: 1, moved: 0 });
    expect(await look(low.id)).toMatchObject(CLOSED);
    for (const [a, pass_route] of [[range, "stated_pay"], [high, "stated_pay"], [big, "big_company"], [hse, "public_pay"]] as const) expect(await look(a.id)).toMatchObject({ ...LIVE, pass_route });
    expect(await recheckLive(fetcher(), raised(43_000))).toEqual({ closed: 0, moved: 0 }); // a second run: nothing

    const t = { ...task("fake", b, all), rereadDays: 7 };
    const [r] = await run([t], raised(43_000), { checkBatch: noModel, maxModelRequests: 0 });
    expect([...t.calls[0]!].sort()).toEqual([range, high, big, hse].map((a) => a.id).sort()); // only the closed one is read again
    expect(r).toMatchObject({ ok: true, changed: 1, unsaved: [] });
    expect(await look(low.id)).toMatchObject({ ...CLOSED, hash: true, result: "rejected", stage: "8 salary below €43,000" });
  });
  it("an HSE job on its stated pay moves to the pay scale (#67) and stays live with its text and hash", async () => {
    const b = board(), a = ad(b, "hse", "HSE Mid West", "The salary is €41,500 a year.");
    await run([task("fake", b, [a])]);
    expect(await look(a.id)).toMatchObject({ ...LIVE, pass_route: "stated_pay" });
    expect(await recheckLive(fetcher(), raised(43_000))).toEqual({ closed: 0, moved: 1 });
    expect(await look(a.id)).toMatchObject({ ...LIVE, pass_route: "public_pay" });
    expect(await recheckLive(fetcher(), rules())).toEqual({ closed: 0, moved: 1 }); // and back
    expect(await look(a.id)).toMatchObject({ ...LIVE, pass_route: "stated_pay" });
  });
});

it("a version entered by mistake and corrected: the statement of docs/job-rules.md brings its jobs back at the next fetch, and no job closed before it", async () => {
  const b = board(), a = ad(b, "x", "Acme Ltd", "The salary is €60,000 a year."), before = ad(b, "before", "Acme Ltd", "The salary is €41,500 a year."), t = () => ({ ...task("fake", b, [a, before]), rereadDays: 7 });
  await run([t()]);
  await recheckLive(fetcher(), raised(43_000)); // a right one, earlier
  await run([t()], raised(43_000), { checkBatch: noModel, maxModelRequests: 0 });
  await su("update job set closed_at = now() - interval '1 day' where id = $1", [(await look(before.id)).job]);
  expect(await recheckLive(fetcher(), raised(430_000))).toEqual({ closed: 1, moved: 0 }); // the mistake
  await run([t()], raised(430_000), { checkBatch: noModel, maxModelRequests: 0 });
  expect(await look(a.id)).toMatchObject({ ...CLOSED, hash: true });
  await run([t()], raised(43_000), { checkBatch: noModel });
  expect(await look(a.id)).toMatchObject({ ...CLOSED, hash: true }); // corrected alone does nothing
  await fetcher().query(recovery().replace("'<the start of that fetch>'", "now() - interval '1 hour'"));
  expect(await run([t()], raised(43_000))).toMatchObject([{ ok: true, changed: 1 }]);
  expect(await look(a.id)).toMatchObject({ ...LIVE, pass_route: "stated_pay" });
  expect(await look(before.id)).toMatchObject({ ...CLOSED, hash: true });
});

describe("a code off the Critical Skills list (#305)", () => {
  it("closes its live jobs with their text and hash; pay at the any-role minimum stays until the code is Ineligible; the mixed code is not checked; the next fetch refuses it and a new advert of the code with no model request", async () => {
    const b = board(), m = { matcher: byRole };
    const low = ad(b, "low", "Acme Ltd", "Role: programmer. The salary is €41,500 a year."), high = ad(b, "high", "Acme Ltd", "Role: programmer. The salary is €68,911 a year.");
    const mixed = ad(b, "mixed", "Acme Ltd", "Role: mixed. The salary is €41,500 a year."), other = ad(b, "other", "Acme Ltd", "Role: analyst. The salary is €41,500 a year.");
    const all = [low, high, mixed, other];
    expect(await run([task("fake", b, all)], rules(), m)).toMatchObject([{ passed: 4 }]);
    expect(await recheckLive(fetcher(), rules())).toEqual({ closed: 0, moved: 0 });
    expect(await recheckLive(fetcher(), lists("2136", "off"))).toEqual({ closed: 1, moved: 0 });
    expect(await look(low.id)).toMatchObject(CLOSED);
    for (const a of [high, mixed, other]) expect(await look(a.id)).toMatchObject(LIVE);

    const fresh = ad(b, "fresh", "Acme Ltd", "Role: programmer. The salary is €41,500 a year."), t = { ...task("fake", b, [...all, fresh]), rereadDays: 7 };
    const [r] = await run([t], lists("2136", "off"), { ...m, checkBatch: noModel, maxModelRequests: 0 });
    expect(r).toMatchObject({ ok: true, changed: 1, rejected: 1, unsaved: [] }); // without the check both would wait for the model (unsaved)
    for (const a of [low, fresh]) expect(await look(a.id)).toMatchObject({ result: "rejected", stage: "6 not on Critical Skills list", hash: true });
    expect(await look(low.id)).toMatchObject({ ...CLOSED, hash: true });

    expect(await recheckLive(fetcher(), lists("2136", "ineligible"))).toEqual({ closed: 1, moved: 0 }); // Ineligible: the pay no longer helps
    expect(await look(high.id)).toMatchObject(CLOSED);
    for (const a of [mixed, other]) expect(await look(a.id)).toMatchObject(LIVE);
  });
  it("a list entered by mistake and corrected: the corrected list alone does nothing, the statement of docs/job-rules.md brings the job back", async () => {
    const b = board(), m = { matcher: byRole }, a = ad(b, "x", "Acme Ltd", "Role: programmer. The salary is €41,500 a year."), t = () => ({ ...task("fake", b, [a]), rereadDays: 7 });
    await run([t()], rules(), m);
    expect(await recheckLive(fetcher(), lists("2136", "off"))).toEqual({ closed: 1, moved: 0 });
    await run([t()], lists("2136", "off"), { ...m, checkBatch: noModel, maxModelRequests: 0 });
    await run([t()], rules(), { ...m, checkBatch: noModel });
    expect(await look(a.id)).toMatchObject({ ...CLOSED, hash: true, stage: "6 not on Critical Skills list" });
    await fetcher().query(recovery().replace("'<the start of that fetch>'", "now() - interval '1 hour'"));
    expect(await run([t()], rules(), m)).toMatchObject([{ ok: true, changed: 1 }]);
    expect(await look(a.id)).toMatchObject({ ...LIVE, pass_route: "stated_pay" });
  });
});

describe("a name off a list", () => {
  it("off the big-company names: its no-pay jobs close, its stated-pay job and another company's stay", async () => {
    const b = board(), gone = ad(b, "gone", "Google"), pay = ad(b, "pay", "Google", "The salary is €60,000 a year."), other = ad(b, "other", "Stripe");
    await run([task("fake", b, [gone, pay, other])]);
    const without = rules({ bigCompanyNames: CHAIN_RULES_V1.bigCompanyNames.filter((x) => x !== "google") });
    expect(await recheckLive(fetcher(), without)).toEqual({ closed: 1, moved: 0 });
    expect(await look(gone.id)).toMatchObject(CLOSED);
    expect(await look(pay.id)).toMatchObject({ ...LIVE, pass_route: "stated_pay" });
    expect(await look(other.id)).toMatchObject({ ...LIVE, pass_route: "big_company" });
  });
  it("the HSE switch off (#261): its pay scale jobs close, its stated-pay job stays, and the next fetch refuses the closed one", async () => {
    const b = board(), scale = ad(b, "scale", "HSE Mid West"), pay = ad(b, "pay", "HSE Mid West", "The salary is €60,000 a year."), off = rules({ publicPayCandidates: new Map([["beaumont hospital", 2]]) });
    await run([task("fake", b, [scale, pay])]);
    expect(await look(scale.id)).toMatchObject({ ...LIVE, pass_route: "public_pay" });
    expect(await recheckLive(fetcher(), off)).toEqual({ closed: 1, moved: 0 });
    expect(await look(scale.id)).toMatchObject(CLOSED);
    expect(await look(pay.id)).toMatchObject({ ...LIVE, pass_route: "stated_pay" });
    await run([{ ...task("fake", b, [scale, pay]), rereadDays: 7 }], off, { checkBatch: noModel, maxModelRequests: 0 });
    expect(await look(scale.id)).toMatchObject({ ...CLOSED, hash: true, result: "rejected", stage: "8 no salary, not a big company" });
  });
});

describe("what it never touches", () => {
  it("a fetched job that waits, is hidden or closed, and an employer's own job, even when named by id", async () => {
    const b = board(), a = ad(b, "x", "Acme Ltd", "The salary is €41,500 a year.");
    await run([task("fake", b, [a])]);
    const { job } = await look(a.id), org = (await su("select organisation_id from job where id = $1", [job]))[0].organisation_id;
    const other = async (status: string) => (await su(
      `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, pass_route, salary_low, status, hidden_reason, close_reason, closes_at, own_page_url)
       values ($1, 'fetched', (select id from job_source where board = $2), 'T', 'Acme Ltd', 'IT', 'critical_skills', 'stated_pay', 41500, $3, case when $3 = 'hidden' then 'admin' end, case when $3 = 'closed' then 'removed' end, 'infinity', 'https://jobs.example.test/h') returning id::text`,
      [org, b, status]))[0].id as string;
    const employer = (await su("insert into organisation(slug, display_name, kind, status) values ($1, 'Fake Employer', 'employer', 'verified') returning id", [`o-${b}`]))[0].id;
    const own = (await su(
      `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, pass_route, salary_low, badge, status, search_vector, closes_at, own_page_url)
       values ($1, 'employer', (select id from job_source where board = $2), 'T', 'Fake Employer', 'IT', 'critical_skills', 'stated_pay', 41500, 'critical_skills_eligible', 'live', to_tsvector('english', 'T'), now() + interval '20 days', 'https://jobs.example.test/o') returning id::text`, [employer, b]))[0].id as string;
    const ids = [await other("in_review"), await other("hidden"), await other("closed"), own];
    const state = () => su("select id::text, status, pass_route, close_reason, search_vector is not null as vector from job where id = any($1::bigint[]) order by id", [ids]);
    await su("update job set occupation_code = '2136' where id = any($1::bigint[])", [ids]);
    const was = await state();
    expect(await recheckLive(fetcher(), lists("2136", "off"))).toEqual({ closed: 0, moved: 0 }); // #305: the live fetched one is 2134
    expect(await recheckLive(fetcher(), raised(43_000))).toEqual({ closed: 1, moved: 0 }); // the live fetched one
    for (const route of [null, "public_pay"])
      expect((await fetcher().query(RECHECK, [ids, ids.map(() => route)])).rows[0]).toEqual({ closed: 0, moved: 0 });
    expect(await state()).toEqual(was);
  });
  it.each<Role>(["app_candidate", "app_portal", "app_backup"])("security: %s cannot run it", async (role) => {
    const b = board(), a = ad(b, "x", "Acme Ltd", "The salary is €41,500 a year.");
    await run([task("fake", b, [a])]);
    await expect(db.pool(role).query(RECHECK, [[(await look(a.id)).job], [null]])).rejects.toThrow(/permission denied/);
    expect(await look(a.id)).toMatchObject(LIVE);
  });
});

it("performance: 2,001 live jobs: one read when nothing changed, one more statement when all of them close", async () => {
  const b = board(), a = ad(b, "x", "Acme Ltd", "The salary is €41,500 a year.");
  await run([task("fake", b, [a])]);
  await su(`with f as (insert into fetched_advert(job_source_id, external_id, title, employer_name, result, stage, content_hash) select (select id from job_source where board = $1), 'perf-' || g, 'T', 'Acme Ltd', 'passed', 'PASS (salary stated)', repeat('b', 64) from generate_series(1, 2000) g returning id),
    j as (insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, sector, occupation_code, permit_type, pass_route, salary_low, salary_high, badge, status, search_vector, closes_at, own_page_url)
      select (select organisation_id from job where id = $2), 'fetched', (select id from job_source where board = $1), f.id, 'T', 'Acme Ltd', 'IT', '2136', 'critical_skills', 'stated_pay', 41500, 41500, 'critical_skills_eligible', 'live', to_tsvector('english', 'T'), 'infinity', 'https://jobs.example.test/p' from f returning id)
    insert into job_text(job_id, advert_text) select id, repeat('Fake words. ', 400) from j`, [b, (await look(a.id)).job]);
  const timed = async (r: Rules) => {
    const c = counting(fetcher()), t = performance.now();
    return { got: await recheckLive(c.db, r), ms: performance.now() - t, statements: c.sql.length };
  };
  const same = await timed(rules()), all = await timed(raised(43_000));
  console.log(`recheckLive on 2,001 live jobs: ${Math.round(same.ms)} ms unchanged, ${Math.round(all.ms)} ms all closed`);
  expect([same.got, same.statements]).toEqual([{ closed: 0, moved: 0 }, 1]);
  expect([all.got, all.statements]).toEqual([{ closed: 2001, moved: 0 }, 2]);
  expect(Math.max(same.ms, all.ms)).toBeLessThan(PERF_MS);
});
