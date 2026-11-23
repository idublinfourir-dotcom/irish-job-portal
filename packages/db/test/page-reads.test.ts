// Step 16 round 1 (B1, B4, B5, B12): the new candidate reads end to end on the test database as app_candidate. GET /api/minimums and GET /api/occupations
// through the real route handlers, and the data layer wrappers of apps/candidate/lib/data.ts (sectors, guide, view count, the minimums and picker reads
// and the ten signed-in readers) with the real candidate login. Only Next's request context is stood in (next/headers gives the headers a test sets;
// server-only is empty); no network. Fake data only.
// Budget (measured 23 November 2026, see the printed line): a visitor's minimums read is 3 statements warm (2 rate counts, the next-version lookup), the
// picker 2 (the rules are kept), the sectors 3; the median time of each is under 15 ms.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { loadSpec, replyProblems } from "./openapi";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));

const BUDGET = { minimums: 3, occupations: 2, sectors: 3, medianMs: 15 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
type Data = typeof import("../../../apps/candidate/lib/data");
let db: TestDb, su: pg.Pool, AUTH: Handler, MINIMUMS: Handler, OCCUPATIONS: Handler, SAVED: Handler, D: Data;
let jobId: string;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ GET: MINIMUMS } = await import("../../../apps/candidate/app/api/minimums/route"));
  ({ GET: OCCUPATIONS } = await import("../../../apps/candidate/app/api/occupations/route"));
  ({ POST: SAVED } = await import("../../../apps/candidate/app/api/candidate/saved/route"));
  D = await import("../../../apps/candidate/lib/data");
  await su.query(`insert into content_page(kind, slug, title, body, status, published_at, source_url, checked_on) values
    ('guide', 'a-guide', 'A guide', 'Guide body', 'published', now(), 'https://enterprise.gov.ie/', '2026-11-01'),
    ('guide', 'draft-guide', 'Draft', 'Draft body', 'draft', null, null, null), ('help', 'a-help', 'Help', 'Help body', 'published', now(), null, null)`);
  const org = (await su.query("insert into organisation(slug, display_name, kind, status) values ('fake-reads-org', 'Fake Org', 'employer', 'verified') returning id")).rows[0];
  const src = (await su.query("insert into job_source(kind, board) values ('portal', 'fake-board') returning id")).rows[0].id;
  const insert = async (sector: string, status: string, n: number) => {
    for (let i = 0; i < n; i++) {
      jobId = (await su.query(
        `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, occupation_code, permit_type, badge, quota_full, status, closes_at, own_page_url, search_vector)
         values ($1, 'admin_manual', $2, $3, 'Fake Employer', $4, '1122', 'critical_skills', 'critical_skills_eligible', false, $5, now() + interval '20 days', 'https://example.test/a', to_tsvector('english','cook')) returning id::text`,
        [org.id, src, `Fake Cook ${sector} ${i}`, sector, status])).rows[0].id;
    }
  };
  await insert("IT", "live", 3);
  await insert("health", "live", 1);
  await insert("care", "draft", 2); // a draft is not counted
  await insert("IT", "live", 1); // the last live job is the one the view count tests use
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const freshIp = () => `203.0.113.${(++n % 240) + 10}.${n}`;
async function login(o: { suspended?: boolean } = {}) {
  const email = `fake.reader${++n}${Date.now().toString(36)}@example.test`, password = "Fake-password-12345";
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(n % 200) + 10}` };
  expect((await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake Reader", ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const id = (await su.query("select id from candidate_user where email=$1", [email])).rows[0].id as string;
  if (o.suspended) await su.query("update candidate_user set suspended_at=now() where id=$1", [id]);
  return { cookie, id };
}
/** Acts as one request: the headers the page would see (next/headers), then runs `fn`. */
const as = <T>(cookie: string | undefined, fn: () => Promise<T>, ip = freshIp()): Promise<T> => {
  state.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": ip });
  return fn();
};
type Got = { status: number; body: Record<string, unknown>; retry: string | null };
async function get(route: Handler, path: string, o: { cookie?: string; ip?: string } = {}): Promise<Got> {
  const res = await route(new Request(`${BASE}${path}`, { headers: { ...(o.cookie ? { cookie: o.cookie } : {}), "x-vercel-forwarded-for": o.ip ?? freshIp() } }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, retry: res.headers.get("retry-after") };
}
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

describe("B5: GET /api/minimums", () => {
  it("gives a visitor and a candidate the minimums in force, as the rules version holds them, and the reply matches the spec", async () => {
    const m = (await su.query("select data from rules_version where kind = 'minimums' and effective_from <= current_date order by effective_from desc, id desc limit 1")).rows[0].data;
    const { cookie } = await login();
    for (const o of [{}, { cookie }]) {
      const g = await get(MINIMUMS, "/api/minimums", o);
      expect(g.status).toBe(200);
      expect(g.body).toMatchObject({
        criticalSkills: m.criticalSkills, graduate: m.graduate, graduateMonths: m.graduateMonths, minContractMonths: m.minContractMonths,
        nonList: m.nonListRoute ? m.nonList : null, rulesCheckedOn: m.checkedOn, nextVersionOn: null,
        general: m.general ?? null, generalLower: m.generalLower ?? null, generalLowerCodes: m.generalLowerCodes ?? [],
      });
      expect(Object.keys(g.body).sort()).toEqual(["criticalSkills", "general", "generalLower", "generalLowerCodes", "graduate", "graduateMonths", "minContractMonths", "nextVersionOn", "nonList", "rulesCheckedOn"]);
      expect(replyProblems(loadSpec("candidate"), "GET", "/api/minimums", g.status, g.body)).toEqual([]);
    }
  });
  it("shows the day the next confirmed version starts, the earliest one, and not one that already started", async () => {
    const c = await su.connect();
    try {
      await c.query("set session_replication_role = replica"); // as fill.ts: the approval trigger off for the fixture; the checks still hold
      const data = (await c.query("select data from rules_version where kind = 'minimums' order by id limit 1")).rows[0].data;
      for (const [i, d] of ["2099-07-01", "2099-01-01"].entries()) await c.query("insert into rules_version(kind, data, effective_from, seeded_by_owner, approval_request_id) values ('minimums', $1, $2, false, $3)", [data, d, 900_001 + i]);
      expect((await get(MINIMUMS, "/api/minimums")).body.nextVersionOn).toBe("2099-01-01");
      await c.query("delete from rules_version where effective_from >= '2099-01-01'");
    } finally { c.release(); }
    expect((await get(MINIMUMS, "/api/minimums")).body.nextVersionOn).toBeNull();
  });
  it("the data layer wrapper answers the same", async () => {
    const r = await as(undefined, () => D.readMinimums());
    expect(r).toMatchObject({ ok: true, data: (await get(MINIMUMS, "/api/minimums")).body });
  });
});

describe("B12: GET /api/occupations", () => {
  it("lists all 369 SOC 2010 unit groups in code order with a title, a unique slug and the list status the checker uses", async () => {
    const g = await get(OCCUPATIONS, "/api/occupations");
    expect(g.status).toBe(200);
    const o = g.body.occupations as { code: string; title: string; slug: string; listStatus: string }[];
    expect(o).toHaveLength(369);
    expect(o.map((x) => x.code)).toEqual(o.map((x) => x.code).sort());
    expect(new Set(o.map((x) => x.slug)).size).toBe(369);
    const by = new Map(o.map((x) => [x.code, x]));
    expect(by.get("1115")).toEqual({ code: "1115", title: "Chief executives and senior officials", slug: "chief-executives-and-senior-officials", listStatus: "other" });
    // every list entry of the rules in force is a picker entry with the status the occupation page gives it
    const lists = (await su.query("select data from rules_version where kind in ('critical_skills_list', 'ineligible_list') and effective_from <= current_date")).rows.flatMap((r) => r.data as { code: string; list: string }[]);
    expect(lists.length).toBeGreaterThan(50);
    for (const e of lists) expect(by.get(e.code)?.listStatus, e.code).toBe(lists.some((x) => x.code === e.code && x.list === "critical-skills") ? "critical-skills" : "ineligible");
    expect(o.filter((x) => x.listStatus === "other").length).toBe(369 - new Set(lists.map((e) => e.code)).size);
    expect(replyProblems(loadSpec("candidate"), "GET", "/api/occupations", g.status, g.body)).toEqual([]);
  });
  it("every slug opens its own occupation page read through the data layer's code", async () => {
    const o = (await get(OCCUPATIONS, "/api/occupations")).body.occupations as { code: string; slug: string; listStatus: string }[];
    const { occupationCodeOfSlug } = await import("../../../apps/candidate/lib/occupations");
    for (const e of o) expect(occupationCodeOfSlug(e.slug)).toBe(e.code);
    const listed = o.find((e) => e.listStatus === "critical-skills")!;
    const r = await as(undefined, () => D.readOccupation({ code: occupationCodeOfSlug(listed.slug)! }));
    expect(r).toMatchObject({ ok: true, data: { code: listed.code } });
  });
  it("the data layer wrapper answers the same", async () => {
    const r = await as(undefined, () => D.readOccupations());
    expect(r).toMatchObject({ ok: true, data: (await get(OCCUPATIONS, "/api/occupations")).body });
  });
});

describe("B1: the data layer reads and the view count", () => {
  it("counts live jobs per sector, zero included, and not a draft", async () => {
    const r = await as(undefined, () => D.readSectors());
    expect(r.ok && (r.data as { sectors: { sector: string; jobs: number }[] }).sectors.find((s) => s.sector === "IT")?.jobs).toBe(4);
    expect(r.ok && (r.data as { sectors: { sector: string; jobs: number }[] }).sectors.find((s) => s.sector === "care")?.jobs).toBe(0);
    expect(r.ok && (r.data as { sectors: unknown[] }).sectors).toHaveLength(8);
  });
  it("counts the sectors for a search: the filters narrow the counts, the sector filter itself does not, and a bad filter is 400", async () => {
    const n = async (query?: Record<string, string>) => {
      const r = await as(undefined, () => D.readSectors(query));
      return r.ok ? Object.fromEntries((r.data as { sectors: { sector: string; jobs: number }[] }).sectors.map((s) => [s.sector, s.jobs])) : r;
    };
    expect((await n({ occupationCode: "1122" })) as Record<string, number>).toMatchObject({ IT: 4, health: 1, care: 0 });
    expect((await n({ occupationCode: "2136" })) as Record<string, number>).toMatchObject({ IT: 0, health: 0 });
    expect((await n({ badge: "critical_skills_eligible" })) as Record<string, number>).toMatchObject({ IT: 4, health: 1 });
    expect((await n({ sector: "health", occupationCode: "1122" })) as Record<string, number>).toMatchObject({ IT: 4, health: 1 }); // the sector filter does not count
    expect(await n({ occupationCode: "" })).toMatchObject({ IT: 4 }); // a blank select means any
    for (const query of <Record<string, string>[]>[{ occupationCode: "1122'; drop table job;--" }, { salaryMin: "x" }, { badge: "nope" }, { postedWithin: "-1" }, { q: "x".repeat(5000) }, { sector: "nope" }])
      expect(await n(query), JSON.stringify(query)).toMatchObject({ ok: false, status: 400, code: "BAD_REQUEST" });
    expect(await as(undefined, () => D.readSectors([["county", "Cork"], ["county", "Kerry"]]))).toMatchObject({ ok: false, status: 400 }); // a filter twice
    const [, c] = await counted(() => as(undefined, () => D.readSectors({ occupationCode: "1122" })));
    expect(c).toBeLessThanOrEqual(BUDGET.sectors); // 2 rate counts and one grouped read
  });
  it("reads a published guide by slug; a draft, a help page, an unknown, a missing or a hostile slug is a clean 404", async () => {
    expect(await as(undefined, () => D.readGuide({ slug: "a-guide" }))).toMatchObject({ ok: true, data: { kind: "guide", slug: "a-guide", checkedOn: "2026-11-01" } });
    for (const slug of ["draft-guide", "a-help", "nope", "", "A-GUIDE", "a-guide'; drop table job;--", "../a-guide", "a".repeat(5000)])
      expect(await as(undefined, () => D.readGuide({ slug })), slug).toMatchObject({ ok: false, status: 404 });
    expect(await as(undefined, () => D.readGuide())).toMatchObject({ ok: false, status: 404 });
  });
  it("counts one view of a live job per call, and nothing for an unknown, hostile or not-live job", async () => {
    const views = async () => Number((await su.query("select coalesce(sum(views), 0) v from job_daily_stat where job_id = $1", [jobId])).rows[0].v);
    expect(await D.countView(jobId)).toBe(true);
    expect(await D.countView(jobId)).toBe(true);
    expect(await views()).toBe(2);
    const draft = (await su.query("select id::text from job where status = 'draft' limit 1")).rows[0].id;
    for (const id of [draft, "999999999", "abc", "1; drop table job", "", "-1", "0x10", "9".repeat(40)]) expect(await D.countView(id), id).toBe(false);
    expect((await su.query("select count(*)::int n from job_daily_stat")).rows[0].n).toBe(1);
  });
  it("is rate limited like the other public reads: the 61st read of a minute from one address is 429", async () => {
    const ip = freshIp();
    for (let i = 0; i < 60; i++) expect((await as(undefined, () => D.readSectors(), ip)).ok).toBe(true);
    expect(await as(undefined, () => D.readSectors(), ip)).toMatchObject({ ok: false, status: 429 });
    expect((await get(MINIMUMS, "/api/minimums", { ip })).status).toBe(429);
    expect((await get(OCCUPATIONS, "/api/occupations", { ip })).status).toBe(429);
  });
});

describe("B4: the signed-in readers", () => {
  const readers: [string, () => Promise<{ ok: boolean; status?: number; code?: string; data?: unknown }>][] = [
    ["profile", () => D.readProfile()], ["cv", () => D.readCv()], ["saved", () => D.readSaved()], ["alerts", () => D.readAlerts()],
    ["did you apply", () => D.readDidYouApply()], ["notification settings", () => D.readNotificationSettings()], ["one job", () => D.readMyJob(jobId)],
    ["cases", () => D.readCases()], ["one case", () => D.readCase("1")], ["case timeline", () => D.readCaseTimeline("1")],
  ];
  it("every reader refuses a visitor with 401 NO_SESSION, a forged cookie too, and a suspended candidate with 403", async () => {
    const suspended = (await login({ suspended: true })).cookie;
    for (const [name, read] of readers) {
      expect(await as(undefined, read), name).toMatchObject({ ok: false, status: 401, code: "NO_SESSION" });
      expect(await as("better-auth.session_token=forged.value", read), name).toMatchObject({ ok: false, status: 401 });
      expect(await as(suspended, read), name).toMatchObject({ ok: false, status: 403, code: "REFUSED" });
    }
  });
  it("gives a candidate their own data and never another's", async () => {
    const [a, b] = [await login(), await login()];
    expect((await SAVED(new Request(`${BASE}/api/candidate/saved`, { method: "POST", headers: { cookie: a.cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ jobId }) }))).status).toBe(200);
    const mineA = await as(a.cookie, () => D.readSaved());
    expect(JSON.stringify(mineA)).toContain(jobId);
    expect(JSON.stringify(await as(b.cookie, () => D.readSaved()))).not.toContain(jobId);
    expect(await as(a.cookie, () => D.readMyJob(jobId))).toMatchObject({ ok: true });
    expect(await as(b.cookie, () => D.readMyJob(jobId))).toMatchObject({ ok: false, status: 404 });
    for (const [name, read] of readers) {
      const r = await as(a.cookie, read);
      expect(r.ok || r.status === 404, `${name}: ${JSON.stringify(r)}`).toBe(true); // an empty account has no CV and no case: 404, never 500
    }
    expect(JSON.stringify(await as(a.cookie, () => D.readProfile()))).not.toContain(b.id);
  });
  it("hostile ids and queries are a clean refusal, never a thrown error", async () => {
    const { cookie } = await login();
    for (const id of ["abc", "1; drop table job", "", "-1", "9".repeat(40), "a".repeat(5000), "../1"]) {
      for (const read of [() => D.readMyJob(id), () => D.readCase(id), () => D.readCaseTimeline(id)]) {
        const r = await as(cookie, read);
        expect(r.ok, id).toBe(false);
        expect([400, 404], `${id}: ${JSON.stringify(r)}`).toContain((r as { status: number }).status);
      }
    }
    const r = await as(cookie, () => D.readSaved({ after: "x".repeat(5000), "a=b&c": "d" }));
    expect(r.ok || [400, 404].includes((r as { status: number }).status)).toBe(true);
  });
});

describe("performance and the six reads' statement budgets", () => {
  it("a visitor's minimums read, picker read and sectors read stay inside their statement and time budgets", async () => {
    await get(MINIMUMS, "/api/minimums"); // warm: the rules are kept 5 minutes
    const [, minimums] = await counted(() => get(MINIMUMS, "/api/minimums"));
    const [, occupations] = await counted(() => get(OCCUPATIONS, "/api/occupations"));
    const [, sectors] = await counted(() => as(undefined, () => D.readSectors()));
    const ms = { minimums: await median(() => get(MINIMUMS, "/api/minimums")), occupations: await median(() => get(OCCUPATIONS, "/api/occupations")), sectors: await median(() => as(undefined, () => D.readSectors())) };
    console.log(`page reads: minimums ${minimums} statements ${ms.minimums.toFixed(2)} ms, occupations ${occupations} statements ${ms.occupations.toFixed(2)} ms, sectors ${sectors} statements ${ms.sectors.toFixed(2)} ms`);
    expect(minimums).toBe(BUDGET.minimums);
    expect(occupations).toBe(BUDGET.occupations);
    expect(sectors).toBe(BUDGET.sectors);
    for (const v of Object.values(ms)) expect(v).toBeLessThan(BUDGET.medianMs);
  });
});
