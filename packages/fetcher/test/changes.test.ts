// Integration: changed adverts, adverts gone, adverts that come back (design 3.8), against the real test database as app_fetcher.
// Every scenario is two or three runBoards calls with a fake board whose answer changes between calls. Plans are written by hand
// (helpers.plan) except where a test says it uses the real chain. No network, no real board.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rulesMatcher } from "@portal/matcher";
import type { RawAdvert } from "@portal/sources";
import { createTestDb, type TestDb } from "../../db/test/db";
import { finishBoard, planAdvert, runBoards, saveKnown, startBoard, type BoardReport, type BoardTask, type Deps, type Known } from "../src";
import { advert, counting, deps, fakeModel, NOW, plan } from "./helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb;
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p).then((r) => r.rows);
const count = async (table: string, where = "true") => Number((await su(`select count(*) from ${table} where ${where}`))[0].count);
beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());

type Kind = "reject" | "passed" | "queued";
let n = 0;
let day = 0; // each run is a later day, so last_seen_at moves
/** One fake board. `ads` is what the board shows now (change it between runs), `modes` what the hand-written plan says about each advert. */
function world(employer?: string) {
  const b = `c${++n}`;
  employer ??= `Chg Fake ${n} Ltd`;
  const w = {
    b, employer, reread: 1 as number | undefined, ads: new Map<string, RawAdvert>(), modes: new Map<string, Kind>(), failNext: false, emptyNext: false, calls: [] as ReadonlySet<string>[],
    put(id: string, mode: Kind, over: Partial<RawAdvert> = {}) { const a = advert(`${b}-${id}`, { employer, ...over }); w.ads.set(id, a); w.modes.set(id, mode); return a; },
    drop(id: string) { w.ads.delete(id); },
    get task(): BoardTask {
      return { kind: "fake", board: b, rereadDays: w.reread, fetch: async (known) => {
        w.calls.push(new Set(known));
        if (w.failNext) { w.failNext = false; throw new Error("HTTP 500"); }
        if (w.emptyNext) { w.emptyNext = false; return { seen: [], adverts: [] }; }
        const all = [...w.ads.values()];
        return { seen: all.map((a) => a.id), adverts: all.filter((a) => !known.has(a.id)) };
      } };
    },
    async go(over: { real?: boolean; db?: ReturnType<typeof counting>["db"]; matcher?: Deps["matcher"]; checkBatch?: Deps["checkBatch"] } = {}): Promise<BoardReport> {
      const modeOf = (a: RawAdvert) => [...w.ads].find(([, x]) => x.id === a.id) && w.modes.get([...w.ads].find(([, x]) => x.id === a.id)![0])!;
      const [r] = await runBoards(deps(over.db ?? db.pool("app_fetcher"), [w.task], { now: () => new Date(NOW.getTime() + ++day * 86_400_000), ...(over.matcher ? { matcher: over.matcher } : {}), ...(over.checkBatch ? { checkBatch: over.checkBatch } : {}) }), over.real ? planAdvert : (a) => plan(a, modeOf(a)!));
      return r!;
    },
    id: (id: string) => `fake:b:${b}-${id}`,
  };
  return w;
}
/** The advert row, its job and the job's text, by the advert's id. */
async function row(external: string) {
  const [r] = await su(
    `select f.id as advert_id, f.result, f.stage, f.reason, f.quoted_evidence, f.title as advert_title, f.content_hash, f.gone_at, f.last_seen_at, j.id as job_id, j.status, j.close_reason, j.closed_at, j.title,
            j.badge, j.pass_route, j.own_page_url, j.search_vector is not null as has_vector, j.posted_at, t.advert_text,
            (select count(*) from review_item r where r.job_id = j.id and r.queue = 'fetched_job')::int as reviews
       from fetched_advert f left join job j on j.fetched_advert_id = f.id left join job_text t on t.job_id = j.id where f.external_id = $1`, [external]);
  return r;
}
/** A row without last_seen_at, which moves on every run. */
const stable = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "last_seen_at"));
const hit = async (jobId: number, word: string) => (await su("select search_vector @@ websearch_to_tsquery('english',$2) as hit from job where id=$1", [jobId, word]))[0].hit;

describe("a new advert is saved with its hash", () => {
  it("passed, queued and rejected rows all carry a 64 hex hash", async () => {
    const w = world();
    w.put("p", "passed"); w.put("q", "queued"); w.put("r", "reject");
    await w.go();
    for (const id of ["p", "q", "r"]) expect((await row(w.id(id))).content_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("3.8 row: not changed", () => {
  it("nothing is written but last_seen_at: job, text and advert row stay as they were, and the run says so", async () => {
    const w = world();
    w.put("p", "passed"); w.put("r", "reject");
    await w.go();
    const before = await Promise.all(["p", "r"].map((id) => row(w.id(id))));
    const r2 = await w.go();
    expect(r2).toMatchObject({ ok: true, changed: 0, closed: 0, passed: 0, rejected: 0, unsaved: [], seen: 2 });
    const after = await Promise.all(["p", "r"].map((id) => row(w.id(id))));
    for (const [i, a] of after.entries()) { expect(stable(a)).toEqual(stable(before[i])); expect(a.last_seen_at > before[i].last_seen_at).toBe(true); }
    expect((await su("select new, closed from fetch_run fr join job_source s on s.id=fr.job_source_id where s.board=$1 order by fr.id desc limit 1", [w.b]))[0]).toEqual({ new: 0, closed: 0 });
  });
});

describe("3.8 row: changed, no job", () => {
  it("a rejected advert that changes and is still rejected: the row is rewritten, still no job", async () => {
    const w = world();
    w.put("r", "reject");
    await w.go();
    const h = (await row(w.id("r"))).content_hash;
    w.put("r", "reject", { title: "Brand New Title" });
    expect(await w.go()).toMatchObject({ changed: 1, rejected: 0, unsaved: [] });
    const a = await row(w.id("r"));
    expect(a).toMatchObject({ result: "rejected", advert_title: "Brand New Title", job_id: null });
    expect(a.content_hash).not.toBe(h);
    expect(await count("fetched_advert", `external_id='${w.id("r")}'`)).toBe(1);
  });
  it("a rejected advert that now passes: a live job and its text are made, on the same advert row", async () => {
    const w = world();
    w.put("r", "reject");
    await w.go();
    const id0 = (await row(w.id("r"))).advert_id;
    w.put("r", "passed", { description: "Fresh words about quantum widgets." });
    expect(await w.go()).toMatchObject({ changed: 1, passed: 0 });
    const a = await row(w.id("r"));
    expect(a).toMatchObject({ advert_id: id0, result: "passed", status: "live", badge: "critical_skills_eligible", advert_text: "Fresh words about quantum widgets.", has_vector: true });
  });
  it("a rejected advert that now is unsure: a queued job, with the admin queue item", async () => {
    const w = world();
    w.put("r", "reject");
    await w.go();
    w.put("r", "queued", { title: "Unsure now" });
    await w.go();
    expect(await row(w.id("r"))).toMatchObject({ result: "queued", status: "in_review", badge: null, reviews: 1 });
  });
});

describe("3.8 row: changed, with a job the fetcher closed", () => {
  async function closedJob(reason: "recheck" | "gone") {
    const w = world();
    w.put("j", "passed"); w.put("keep", "reject");
    await w.go();
    if (reason === "recheck") { w.put("j", "reject", { description: "now fails" }); await w.go(); }
    else { w.drop("j"); await w.go(); }
    expect(await row(w.id("j"))).toMatchObject({ status: "closed", close_reason: reason === "recheck" ? "recheck_failed" : "closed" });
    return w;
  }
  it("passes again after recheck_failed: reopened to live, with new content, text and search vector", async () => {
    const w = await closedJob("recheck");
    w.put("j", "passed", { title: "Zymurgist Wanted", description: "Better text." });
    expect(await w.go()).toMatchObject({ changed: 1, closed: 0 });
    const a = await row(w.id("j"));
    expect(a).toMatchObject({ status: "live", close_reason: null, closed_at: null, result: "passed", title: "Zymurgist Wanted", advert_text: "Better text.", has_vector: true, gone_at: null });
    expect(await hit(a.job_id, "zymurgist")).toBe(true);
  });
  it("passes again after the advert was gone: reopened to live (design: an advert that comes back)", async () => {
    const w = await closedJob("gone");
    w.put("j", "passed"); // same text, it just came back
    expect(await w.go()).toMatchObject({ changed: 1 });
    expect(await row(w.id("j"))).toMatchObject({ status: "live", close_reason: null, gone_at: null, advert_text: "Build fake things." });
  });
  it("is now unsure: the job stays closed, the advert row carries the queue stage", async () => {
    const w = await closedJob("recheck");
    w.put("j", "queued", { description: "Unsure." });
    await w.go();
    expect(await row(w.id("j"))).toMatchObject({ status: "closed", close_reason: "recheck_failed", result: "queued", advert_text: null, has_vector: false });
  });
  it("still fails: the job stays closed, and the next run with the same text writes nothing", async () => {
    const w = await closedJob("recheck");
    w.put("j", "reject", { description: "Still bad." });
    expect(await w.go()).toMatchObject({ changed: 1 });
    const before = await row(w.id("j"));
    expect(await w.go()).toMatchObject({ changed: 0 });
    expect(stable(await row(w.id("j")))).toEqual(stable(before));
    expect(before).toMatchObject({ status: "closed", close_reason: "recheck_failed", result: "rejected" });
  });
});

describe("3.8 row: changed, with a live job", () => {
  it("that still passes: job content, search vector, text and advert row are updated, the job keeps its id and posted_at", async () => {
    const w = world();
    w.put("j", "passed");
    await w.go();
    const was = await row(w.id("j"));
    w.put("j", "passed", { title: "Cryptozoologist", description: "New description words.", location: "Cork, Ireland" });
    expect(await w.go()).toMatchObject({ changed: 1, closed: 0, passed: 0 });
    const a = await row(w.id("j"));
    expect(a).toMatchObject({ job_id: was.job_id, status: "live", title: "Cryptozoologist", advert_text: "New description words.", advert_title: "Cryptozoologist", has_vector: true });
    expect(a.posted_at).toEqual(was.posted_at);
    expect(a.content_hash).not.toBe(was.content_hash);
    expect(await hit(a.job_id, "cryptozoologist")).toBe(true);
    expect(await hit(a.job_id, "engineer")).toBe(false);
  });
  it("that is now unsure: in_review, no badge, no pass route, in the admin queue, text updated, advert queued", async () => {
    const w = world();
    w.put("j", "passed");
    await w.go();
    w.put("j", "queued", { description: "Unsure words." });
    await w.go();
    expect(await row(w.id("j"))).toMatchObject({ status: "in_review", badge: null, pass_route: null, result: "queued", advert_text: "Unsure words.", reviews: 1 });
  });
  it("that now fails: closed as recheck_failed, no search vector, no text, advert rejected with the rule and the evidence; closed counts it", async () => {
    const w = world();
    w.put("j", "passed");
    await w.go();
    w.put("j", "reject", { description: "Now bad." });
    const r = await w.go();
    expect(r).toMatchObject({ changed: 1, closed: 1, rejected: 0 });
    const a = await row(w.id("j"));
    expect(a).toMatchObject({ status: "closed", close_reason: "recheck_failed", has_vector: false, advert_text: null, result: "rejected", stage: "fake stage" });
    expect(a.closed_at).not.toBeNull();
    expect((await su("select closed from fetch_run fr join job_source s on s.id=fr.job_source_id where s.board=$1 order by fr.id desc limit 1", [w.b]))[0].closed).toBe(1);
  });
  it("the rule and the evidence of a failed advert are kept on the advert row, short", async () => {
    const w = world();
    w.put("j", "passed");
    await w.go();
    const a = w.put("j", "reject", { description: "Now bad." });
    const [r] = await runBoards(deps(db.pool("app_fetcher"), [w.task], { now: () => new Date(NOW.getTime() + 99 * 86_400_000) }), (x) => {
      const p = plan(x, "reject");
      if (p.action !== "reject") throw new Error("plan");
      return { ...p, advert: { ...p.advert, stage: "6 not on Critical Skills list", reason: "irish: no", quotedEvidence: "the exact words" } };
    });
    expect(r).toMatchObject({ closed: 1 });
    expect(await row(a.id)).toMatchObject({ stage: "6 not on Critical Skills list", reason: "irish: no", quoted_evidence: "the exact words", status: "closed", close_reason: "recheck_failed" });
  });
});

describe("3.8 row: a job in_review or hidden is never touched, whatever changed", () => {
  async function held(kind: "in_review" | "hidden") {
    const w = world();
    w.put("j", kind === "in_review" ? "queued" : "passed");
    await w.go();
    if (kind === "hidden") await su("update job set status='hidden', hidden_reason='admin' where fetched_advert_id=(select id from fetched_advert where external_id=$1)", [w.id("j")]);
    return w;
  }
  it.each(["in_review", "hidden"] as const)("%s: a changed advert that now fails leaves job, text, hash and advert row exactly as they were", async (kind) => {
    const w = await held(kind);
    const before = await row(w.id("j"));
    expect(before.status).toBe(kind);
    w.put("j", "reject", { title: "Totally different", description: "Other words." });
    expect(await w.go()).toMatchObject({ changed: 0, closed: 0, unsaved: [] });
    expect(stable(await row(w.id("j")))).toEqual(stable(before));
  });
  it.each(["in_review", "hidden"] as const)("%s: a changed advert that still passes is not touched either", async (kind) => {
    const w = await held(kind);
    const before = await row(w.id("j"));
    w.put("j", "passed", { description: "Other words again." });
    await w.go();
    expect(stable(await row(w.id("j")))).toEqual(stable(before));
  });
  it.each(["in_review", "hidden"] as const)("%s: when its advert goes the job stays; when it comes back gone_at clears and the job is still untouched", async (kind) => {
    const w = await held(kind);
    const other = w.put("other", "reject");
    await w.go();
    const before = await row(w.id("j"));
    w.drop("j");
    expect(await w.go()).toMatchObject({ closed: 0 });
    expect(await row(w.id("j"))).toMatchObject({ status: kind, advert_text: before.advert_text, close_reason: null });
    expect((await row(w.id("j"))).gone_at).not.toBeNull();
    w.put("j", "reject", { description: "back, and different" });
    await w.go();
    const a = await row(w.id("j"));
    expect(a).toMatchObject({ status: kind, gone_at: null, content_hash: before.content_hash, advert_text: before.advert_text, title: before.title });
    expect(other.id).toBeTruthy();
  });
  it("a job staff removed stays removed, however the advert changes, and the advert's hash is kept up to date", async () => {
    const w = world();
    w.put("j", "passed");
    await w.go();
    await su("update job set status='closed', close_reason='removed', closed_at=now(), search_vector=null where fetched_advert_id=(select id from fetched_advert where external_id=$1)", [w.id("j")]);
    const h = (await row(w.id("j"))).content_hash;
    w.put("j", "passed", { description: "Better, but staff removed it." });
    await w.go();
    const a = await row(w.id("j"));
    expect(a).toMatchObject({ status: "closed", close_reason: "removed", has_vector: false });
    expect(a.content_hash).not.toBe(h);
    expect(await w.go()).toMatchObject({ changed: 0 }); // quiet from now on
  });
});

describe("3.8: advert gone", () => {
  it("the live job closes with reason closed, no search vector, no text; gone_at is set; the run row counts it; the rest of the board is unharmed", async () => {
    const w = world();
    w.put("a", "passed"); w.put("b", "passed"); w.put("r", "reject");
    await w.go();
    w.drop("a");
    const r = await w.go();
    expect(r).toMatchObject({ ok: true, closed: 1, seen: 2 });
    expect(await row(w.id("a"))).toMatchObject({ status: "closed", close_reason: "closed", has_vector: false, advert_text: null });
    expect((await row(w.id("a"))).gone_at.toISOString()).toBe(new Date(NOW.getTime() + day * 86_400_000).toISOString());
    expect(await row(w.id("b"))).toMatchObject({ status: "live", has_vector: true, gone_at: null });
    expect((await row(w.id("r"))).gone_at).toBeNull();
    expect((await su("select closed from fetch_run fr join job_source s on s.id=fr.job_source_id where s.board=$1 order by fr.id desc limit 1", [w.b]))[0].closed).toBe(1);
  });
  it("a second run does not close it again (closed = 0) and does not move gone_at; a gone id is not handed to the fetch as known", async () => {
    const w = world();
    w.reread = undefined;
    w.put("a", "passed"); w.put("b", "passed");
    await w.go();
    w.drop("a");
    await w.go();
    const g = (await row(w.id("a"))).gone_at;
    expect(await w.go()).toMatchObject({ closed: 0 });
    expect((await row(w.id("a"))).gone_at).toEqual(g);
    expect([...w.calls.at(-1)!]).toEqual([w.id("b")]); // the gone advert is not known
  });
  it("a rejected advert that goes just gets gone_at", async () => {
    const w = world();
    w.put("a", "reject"); w.put("b", "reject");
    await w.go();
    w.drop("a");
    expect(await w.go()).toMatchObject({ closed: 0 });
    expect((await row(w.id("a"))).gone_at).not.toBeNull();
  });
  it("a failed fetch closes nothing, marks nothing gone, and the job stays live", async () => {
    const w = world();
    w.put("a", "passed");
    await w.go();
    w.failNext = true;
    expect(await w.go()).toMatchObject({ ok: false, closed: 0 });
    expect(await row(w.id("a"))).toMatchObject({ status: "live", gone_at: null });
  });
  it("an empty answer while adverts were known closes nothing", async () => {
    const w = world();
    w.put("a", "passed");
    await w.go();
    w.emptyNext = true;
    expect(await w.go()).toMatchObject({ ok: false, error: "returned nothing while 1 adverts were known", closed: 0 });
    expect(await row(w.id("a"))).toMatchObject({ status: "live", gone_at: null, has_vector: true });
  });
  it("the finishing statement itself closes nothing for an empty list of seen ids (second guard, below the run loop)", async () => {
    const w = world();
    w.put("a", "passed");
    await w.go();
    const pool = db.pool("app_fetcher");
    const run = await startBoard(pool, "fake", w.b);
    expect(await finishBoard(pool, run, NOW, [], 0)).toBe(0);
    expect(await row(w.id("a"))).toMatchObject({ status: "live", gone_at: null, has_vector: true });
  });
  it("only this board's jobs close: another board with the same employer is untouched", async () => {
    const w = world(), x = world(w.employer);
    w.put("a", "passed"); x.put("a", "passed");
    await w.go(); await x.go();
    w.drop("a"); w.put("z", "reject");
    await w.go();
    expect(await row(w.id("a"))).toMatchObject({ status: "closed" });
    expect(await row(x.id("a"))).toMatchObject({ status: "live" });
  });
  it("an advert that is unsaved (deadline) but seen is not marked gone", async () => {
    const w = world();
    w.put("a", "passed");
    await w.go();
    w.put("a", "passed", { description: "changed, but the deadline is past" });
    const [r] = await runBoards(deps(db.pool("app_fetcher"), [w.task], { deadline: new Date(NOW.getTime() - 1) }), (x) => plan(x, "passed"));
    expect(r).toMatchObject({ unsaved: [w.id("a")], closed: 0 });
    expect(await row(w.id("a"))).toMatchObject({ status: "live", gone_at: null });
  });
});

describe("3.8: an advert comes back", () => {
  it("assessed again: gone_at cleared, the job the fetcher closed is reopened to live and has its text", async () => {
    const w = world();
    w.put("a", "passed"); w.put("b", "passed");
    await w.go();
    w.drop("a");
    await w.go();
    w.put("a", "passed");
    const r = await w.go();
    expect(r).toMatchObject({ changed: 1, closed: 0 });
    expect(await row(w.id("a"))).toMatchObject({ status: "live", close_reason: null, closed_at: null, gone_at: null, has_vector: true, advert_text: "Build fake things." });
    expect(w.calls.at(-1)!.has(w.id("a"))).toBe(false); // it was handed over with its text
  });
  it("comes back and now fails: the job stays closed, gone_at cleared", async () => {
    const w = world();
    w.put("a", "passed"); w.put("b", "passed");
    await w.go();
    w.drop("a");
    await w.go();
    w.put("a", "reject");
    await w.go();
    expect(await row(w.id("a"))).toMatchObject({ status: "closed", close_reason: "closed", gone_at: null, result: "rejected" });
  });
  it("a job staff removed while the advert was gone is not reopened", async () => {
    const w = world();
    w.put("a", "passed"); w.put("b", "passed");
    await w.go();
    await su("update job set status='closed', close_reason='removed', closed_at=now(), search_vector=null where fetched_advert_id=(select id from fetched_advert where external_id=$1)", [w.id("a")]);
    w.drop("a");
    await w.go();
    w.put("a", "passed");
    await w.go();
    expect(await row(w.id("a"))).toMatchObject({ status: "closed", close_reason: "removed", gone_at: null });
  });
});

describe("3.8: a row saved before this change has no hash", () => {
  it("counts as changed once, gets its hash, and is quiet after that", async () => {
    const w = world();
    w.put("a", "passed"); w.put("r", "reject");
    await w.go();
    await su("update fetched_advert set content_hash = null where external_id in ($1,$2)", [w.id("a"), w.id("r")]);
    expect(await w.go()).toMatchObject({ changed: 2 });
    expect((await row(w.id("a"))).content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await row(w.id("r"))).content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await w.go()).toMatchObject({ changed: 0 });
  });
});

describe("the second read (rereadDays)", () => {
  it("a board with rereadDays 7 hands each known id back on one day in seven; with no rereadDays never", async () => {
    const w = world();
    for (let i = 0; i < 40; i++) w.put(`x${i}`, "reject");
    const t = w.task;
    const seven: BoardTask = { ...t, rereadDays: 7 };
    await runBoards(deps(db.pool("app_fetcher"), [seven], { now: () => NOW }), (x) => plan(x, "reject"));
    const handed = new Set<string>();
    for (let d = 1; d <= 7; d++) {
      await runBoards(deps(db.pool("app_fetcher"), [seven], { now: () => new Date(NOW.getTime() + d * 86_400_000) }), (x) => plan(x, "reject"));
      const known = w.calls.at(-1)!;
      for (const a of w.ads.values()) if (!known.has(a.id)) { expect(handed.has(a.id)).toBe(false); handed.add(a.id); }
    }
    expect(handed.size).toBe(40);
    const never: BoardTask = { ...t, rereadDays: undefined };
    await runBoards(deps(db.pool("app_fetcher"), [never], { now: () => NOW }), (x) => plan(x, "reject"));
    expect(w.calls.at(-1)!.size).toBe(40);
  });
});

describe("permissions", () => {
  const known = async (w: ReturnType<typeof world>, id: string): Promise<Known & { sourceId: number }> => {
    const b = await startBoard(db.pool("app_fetcher"), "fake", w.b);
    return { ...b.rows.get(w.id(id))!, sourceId: b.sourceId };
  };
  it("app_fetcher: a job that staff moved to in_review or hidden after the fetcher read it is not touched (the write matches no row and rolls back)", async () => {
    for (const status of ["in_review", "hidden"]) {
      const w = world();
      w.put("j", "passed");
      await w.go();
      const k = await known(w, "j"); // read as live
      await su(`update job set status='${status}'${status === "hidden" ? ", hidden_reason='admin'" : ""} where id=$1`, [k.jobId]);
      const before = await row(w.id("j"));
      const p = plan(w.ads.get("j")!, "reject");
      for (const q of [p, plan(w.ads.get("j")!, "passed"), plan(w.ads.get("j")!, "queued")]) {
        if (q.action === "defer") throw new Error("plan");
        await expect(saveKnown(db.pool("app_fetcher"), k.sourceId, k, q, "f".repeat(64))).rejects.toThrow();
      }
      expect(await row(w.id("j"))).toEqual(before);
    }
  });
  it("app_fetcher: cannot move an in_review job to live, cannot reopen a removed job, cannot relabel it", async () => {
    const w = world();
    w.put("q", "queued"); w.put("r", "passed");
    await w.go();
    const f = db.pool("app_fetcher");
    await expect(f.query("update job set status='live', badge='critical_skills_eligible' where fetched_advert_id=(select id from fetched_advert where external_id=$1)", [w.id("q")])).rejects.toThrow(/never moves a job out of/);
    await su("update job set status='closed', close_reason='removed', closed_at=now(), search_vector=null where fetched_advert_id=(select id from fetched_advert where external_id=$1)", [w.id("r")]);
    await expect(f.query("update job set status='live', close_reason=null, search_vector=to_tsvector('x') where fetched_advert_id=(select id from fetched_advert where external_id=$1)", [w.id("r")])).rejects.toThrow(/never reopens/);
    await expect(f.query("update job set close_reason='recheck_failed' where fetched_advert_id=(select id from fetched_advert where external_id=$1)", [w.id("r")])).rejects.toThrow(/close reason/);
    expect(await row(w.id("r"))).toMatchObject({ close_reason: "removed" });
  });
  it("app_fetcher: cannot close an employer's job, with any reason", async () => {
    const [src] = await su("insert into job_source(kind, board) values ('emp','x') on conflict (kind, board) do update set board=excluded.board returning id");
    const [org] = await su("insert into organisation(slug, display_name, kind, status) values ('emp-chg-fake','Emp Chg Fake','employer','verified') returning id");
    const [j] = await su(
      `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, salary_low, status, closes_at, search_vector, own_page_url)
       values ($1,'employer',$2,'t','e','IT','general',50000,'live', now() + interval '10 days', to_tsvector('t'), 'https://e.example.test') returning id`, [org.id, src.id]);
    const f = db.pool("app_fetcher");
    for (const reason of ["recheck_failed", "closed"])
      await expect(f.query("update job set status='closed', close_reason=$2, search_vector=null where id=$1", [j.id, reason])).rejects.toThrow(/fetcher writes only fetched jobs|permission denied/);
    expect((await su("select status from job where id=$1", [j.id]))[0].status).toBe("live");
  });
  it.each(["app_candidate", "app_portal"] as const)("%s: cannot read the board's rows, finish a run, or save a known advert", async (role) => {
    const w = world();
    w.put("j", "passed");
    await w.go();
    const k = await known(w, "j");
    const pool = db.pool(role);
    await expect(startBoard(pool, "fake", w.b)).rejects.toThrow(/permission denied/);
    const f = db.pool("app_fetcher");
    const run = await startBoard(f, "fake", w.b);
    await expect(finishBoard(pool, run, NOW, [], 0)).rejects.toThrow(/permission denied/);
    for (const mode of ["reject", "passed"] as const) {
      const p = plan(w.ads.get("j")!, mode);
      if (p.action === "defer") throw new Error("plan");
      await expect(saveKnown(pool, k.sourceId, k, p, "f".repeat(64))).rejects.toThrow();
    }
    expect(await row(w.id("j"))).toMatchObject({ status: "live", result: "passed" });
  });
  it("app_admin cannot run the fetcher's writes (it reads, and may reject a queued advert)", async () => {
    const w = world();
    w.put("j", "passed");
    await w.go();
    const r = await runBoards(deps(db.pool("app_admin"), [w.task]), (x) => plan(x, "reject"));
    expect(r[0]).toMatchObject({ ok: false });
    expect(await row(w.id("j"))).toMatchObject({ status: "live" });
  });
});

describe("security: hostile text in a changed advert", () => {
  const evil = "x'); drop table job; --";
  it("a null byte and SQL-looking text in every field of a changed advert are stored as text; the tables survive", async () => {
    const w = world();
    w.put("j", "passed");
    await w.go();
    w.put("j", "passed", { title: `T${evil}\0`, description: `D${evil}\0 end`, location: `L${evil}`, employmentType: evil, salaryBox: evil });
    const r = await w.go();
    expect(r).toMatchObject({ changed: 1, unsaved: [] });
    const a = await row(w.id("j"));
    expect(a).toMatchObject({ title: `T${evil}`, advert_text: `D${evil} end`, status: "live" });
    expect(await count("job")).toBeGreaterThan(0);
  });
  it("a 31,000 character description with the real chain: the live job closes as recheck_failed and no text is kept", async () => {
    const w = world();
    w.put("j", "passed");
    await w.go();
    w.put("j", "passed", { description: "x".repeat(31_000) });
    const r = await w.go({ real: true });
    expect(r).toMatchObject({ closed: 1, unsaved: [] });
    expect(await row(w.id("j"))).toMatchObject({ status: "closed", close_reason: "recheck_failed", advert_text: null, result: "rejected", stage: "0 advert too long (admin queue)" });
  });
  it("a javascript: link on an advert that had a good one: alone it is not even noticed (the link is not in the hash), with changed text the job closes; the link is never stored", async () => {
    const w = world();
    const good = w.put("j", "passed");
    await w.go();
    w.put("j", "passed", { url: "javascript:alert(1)" });
    expect(await w.go({ real: true })).toMatchObject({ changed: 0, unsaved: [] });
    expect(await row(w.id("j"))).toMatchObject({ status: "live", own_page_url: good.url });
    w.put("j", "passed", { url: "javascript:alert(1)", description: "Also new words." });
    const r = await w.go({ real: true });
    expect(r).toMatchObject({ changed: 1, unsaved: [] });
    expect((await row(w.id("j"))).status).not.toBe("live");
    expect(await count("job", "own_page_url ilike 'javascript:%'")).toBe(0);
    expect(await count("fetched_advert", "url ilike 'javascript:%'")).toBe(0);
  });
  it("an advert that flips between two texts on every run keeps one advert row, one job and one text", async () => {
    const w = world();
    w.put("j", "passed", { description: "Text A" });
    await w.go();
    const was = await row(w.id("j"));
    for (let i = 0; i < 6; i++) {
      w.put("j", "passed", { description: i % 2 ? "Text A" : "Text B" });
      expect(await w.go()).toMatchObject({ changed: 1, unsaved: [] });
    }
    expect(await count("fetched_advert", `external_id='${w.id("j")}'`)).toBe(1);
    expect(await count("job", `fetched_advert_id=${was.advert_id}`)).toBe(1);
    expect(await count("job_text", `job_id=${was.job_id}`)).toBe(1);
    expect(await row(w.id("j"))).toMatchObject({ job_id: was.job_id, advert_text: "Text A", status: "live" });
  });
  it("a flip between passing and failing: the job closes and reopens, still one row of each", async () => {
    const w = world();
    w.put("j", "passed");
    await w.go();
    for (let i = 0; i < 4; i++) {
      w.put("j", i % 2 ? "passed" : "reject", { description: `flip ${i}` });
      await w.go();
    }
    expect(await row(w.id("j"))).toMatchObject({ status: "live", has_vector: true, advert_text: "flip 3" });
    expect(await count("job", `fetched_advert_id=${(await row(w.id("j"))).advert_id}`)).toBe(1);
  });
});

describe("performance: counted statements", () => {
  const verb = (s: string) => s.split(" ").slice(0, 2).join(" ");
  it("a run where nothing changed costs the first cut's 4 statements per board, however many adverts", async () => {
    const w = world();
    for (let i = 0; i < 30; i++) w.put(`x${i}`, i % 3 ? "reject" : "passed");
    await w.go();
    const c = counting(db.pool("app_fetcher"));
    await w.go({ db: c.db });
    expect(c.sql).toHaveLength(4);
    expect(c.sql.map(verb)).toEqual(["insert into", "insert into", "select external_id,", "with seen"]);
  });
  it("one changed live advert costs 5 statements on top (begin, advert, job, text, commit); one that now fails costs 4", async () => {
    const w = world();
    w.put("a", "passed"); w.put("b", "passed");
    await w.go();
    w.put("a", "passed", { description: "changed a" });
    let c = counting(db.pool("app_fetcher"));
    await w.go({ db: c.db });
    expect(c.sql).toHaveLength(4 + 5);
    expect(c.sql.slice(3, 8).map(verb)).toEqual(["begin", "update fetched_advert", "update job", "insert into", "commit"]);
    w.put("b", "reject", { description: "b fails" });
    c = counting(db.pool("app_fetcher"));
    await w.go({ db: c.db });
    expect(c.sql).toHaveLength(4 + 4);
    expect(c.sql.slice(3, 7).map(verb)).toEqual(["begin", "update fetched_advert", "with c", "commit"]);
  });
  it("any number of gone adverts cost no statement beyond the 4 of a board: they close inside the finish statement", async () => {
    const w = world();
    for (let i = 0; i < 100; i++) w.put(`x${i}`, "passed");
    await w.go();
    for (let i = 0; i < 15; i++) w.drop(`x${i}`);
    const c = counting(db.pool("app_fetcher"));
    expect(await w.go({ db: c.db })).toMatchObject({ closed: 15 });
    expect(c.sql).toHaveLength(4);
  });
  it("a changed advert with no job yet: a new job costs the same as a new advert, one transaction", async () => {
    const w = world();
    w.put("a", "reject");
    await w.go();
    w.put("a", "passed", { description: "now good" });
    const c = counting(db.pool("app_fetcher"));
    await w.go({ db: c.db });
    expect(c.sql.length).toBeLessThanOrEqual(4 + 9); // the first cut's budget for a new job with a new employer: begin, find, slugs, org, name, advert, job, text, commit
  });
});

describe("performance: 1,000 known adverts, 50 changed, 50 gone", () => {
  it("statements and time are within budget", async () => {
    const w = world("Perf Chg Ltd");
    for (let i = 0; i < 1000; i++) w.put(`p${i}`, i < 300 ? "passed" : "reject");
    await w.go();
    for (let i = 0; i < 50; i++) w.put(`p${i}`, "passed", { description: `changed ${i}` });
    for (let i = 50; i < 100; i++) w.drop(`p${i}`);
    const c = counting(db.pool("app_fetcher"));
    const t0 = performance.now();
    const r = await w.go({ db: c.db });
    const ms = performance.now() - t0;
    console.log(`perf changes: ${c.sql.length} statements, ${ms.toFixed(0)} ms`);
    expect(r).toMatchObject({ changed: 50, closed: 50, unsaved: [], seen: 950 });
    expect(c.sql).toHaveLength(4 + 50 * 5); // gone adverts cost nothing extra
    expect(ms).toBeLessThan(PERF_MS);
    expect(await count("job", `fetched_advert_id in (select id from fetched_advert where job_source_id=(select id from job_source where board='${w.b}')) and status='live'`)).toBe(250);
  });
});
// GF1 (26 November 2026): the three fixes from the reviewer's hand check, through the real chain, the matcher the daily run uses
// (run/main.ts) and the real database as app_fetcher.
describe("GF1: wrong badges the hand check found", () => {
  const rules: Deps["matcher"] = async (title, description) => ({ match: await rulesMatcher(title, description), quote: null, modelId: "rules", failure: null });
  const run = (w: ReturnType<typeof world>) => w.go({ real: true, matcher: rules, checkBatch: fakeModel().checkBatch }); // the model backs every badge it is shown
  it("a live big-company job whose advert becomes a fund accounting associate closes; a safety auditor and a 'cannot assist with any visa sponsorship' advert get no job", async () => {
    const w = world("Amazon");
    w.put("j", "passed", { title: "Software Engineer" });
    w.put("q", "passed", { title: "QA Auditor III" });
    expect(await run(w)).toMatchObject({ unsaved: [] });
    expect(await row(w.id("j"))).toMatchObject({ status: "live", pass_route: "big_company" });
    expect(await row(w.id("q"))).toMatchObject({ status: "live", pass_route: "big_company" }); // the reviewer kept this badge
    w.put("j", "passed", { title: "Fund Accounting (Alternatives) Associate 2" });
    w.put("s", "passed", { title: "Health and Safety Auditor, AWS Health and Safety" });
    w.put("v", "passed", { title: "Software Engineer", description: "Build fake things. ***Please note our clients cannot assist with any visa sponsorship***" });
    expect(await run(w)).toMatchObject({ closed: 1, unsaved: [] });
    expect(await row(w.id("j"))).toMatchObject({ status: "closed", close_reason: "recheck_failed", advert_text: null, result: "rejected", stage: "6 not on Critical Skills list" });
    expect(await row(w.id("s"))).toMatchObject({ job_id: null, result: "rejected", stage: "6 not on Critical Skills list" });
    expect(await row(w.id("v"))).toMatchObject({ job_id: null, result: "rejected", stage: "4 says no sponsorship" });
    expect(await row(w.id("q"))).toMatchObject({ status: "live" });
  });
});

// 198 ms alone; the first cut's tests ran about 4 times slower inside the full suite, so about 0.8 s there. The limit leaves room for three times that.
const PERF_MS = 5_000;
