// C5 (#253): the daily count of "no" answers to "Do you need a work permit?" (#8), through the real candidate sign-up route on the test database as
// app_candidate. A "no" adds one to today's UTC row and keeps nothing else; the per-IP limit and the bot check (a fake of botid/server) come first, so
// a script cannot inflate it cheaply. Fake people only, no network.
// Measured 18 November 2026: a "no" is 3 statements (the rate limit read and write, the count), median 3 ms. Budget: 3 statements, median 25 ms.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkBotId } from "botid/server";
import { createTestDb, urlFor, type TestDb } from "./db";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { assertPageBudget, measurePages } from "./perf/pages";
import { SIGNUP_NO_SQL } from "../src/signup-no";
import { COUNT_NO } from "../../auth/src/signup";

vi.mock("botid/server", () => ({ checkBotId: vi.fn() }));
const verdict = vi.mocked(checkBotId) as unknown as ReturnType<typeof vi.fn>;
const BUDGET = { statements: 3, medianMs: 25, pages: 10 };
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const BASE = "http://localhost:3000";
let db: TestDb, su: pg.Pool, AUTH: (r: Request) => Promise<Response>;
const bot = process.env.BOT_CHECK;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
});
afterAll(async () => {
  if (bot === undefined) delete process.env.BOT_CHECK; else process.env.BOT_CHECK = bot;
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
beforeEach(async () => { delete process.env.BOT_CHECK; await su.query("delete from signup_no_count"); });

let n = 0;
const freshIp = () => `203.0.113.${(++n % 250) + 1}`;
const signUp = async (body: unknown, ip = freshIp()) => {
  const res = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": ip } }));
  return { status: res.status, json: await res.json().catch(() => null) };
};
const person = (tag: string, o: object = {}) => ({ email: `fake.no.${tag}@example.test`, password: `Fake-${tag}-password-1`, name: `Fake ${tag}`, ...answers, ...o });
const today = async () => Number((await su.query("select coalesce(sum(count), 0) n from signup_no_count where day = (now() at time zone 'UTC')::date")).rows[0].n);
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}

describe("counting a no", () => {
  it("a no is refused as before, adds one to today's UTC row, and makes no account", async () => {
    const r = await signUp(person("a", { needsPermit: false }));
    expect([r.status, r.json?.code]).toEqual([400, "SIGNUP_ANSWERS_REFUSED"]);
    await signUp(person("b", { needsPermit: false, over18: false })); // a no counts whatever the other answers
    expect(await today()).toBe(2);
    expect((await su.query("select count(*)::int n from candidate_user where email like 'fake.no.%'")).rows[0].n).toBe(0);
  });
  it("only the JSON value false is a no: a yes, a missing answer and hostile values add nothing", async () => {
    expect((await signUp(person("yes"))).status).toBe(200);
    for (const v of [undefined, null, "false", 0, "", [], {}, "x".repeat(10_000)]) expect((await signUp(person("h", { needsPermit: v }))).status, String(v)).toBe(400);
    expect((await signUp(null)).status).toBe(400);
    expect(await today()).toBe(0);
  });
  it("keeps nothing about the visitor: the table is a day and a count", async () => {
    await signUp(person("c", { needsPermit: false }), "198.51.100.77");
    const cols = (await su.query("select column_name from information_schema.columns where table_name = 'signup_no_count' order by ordinal_position")).rows.map((r) => r.column_name);
    expect(cols).toEqual(["day", "count"]);
    expect(JSON.stringify((await su.query("select * from signup_no_count")).rows)).not.toMatch(/198\.51|fake\.no/);
  });
  it("20 at once from 20 addresses count 20 (one atomic upsert)", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => signUp(person(`p${i}`, { needsPermit: false }))));
    expect(await today()).toBe(20);
    expect((await su.query("select count(*)::int n from signup_no_count")).rows[0].n).toBe(1);
  });
});

describe("security: a script cannot inflate it cheaply", () => {
  it("the per-IP limit (5 a minute) refuses the 6th call before it is counted", async () => {
    const ip = "192.0.2.50", codes = [];
    for (let i = 0; i < 7; i++) codes.push((await signUp(person(`r${i}`, { needsPermit: false }), ip)).status);
    expect(codes).toEqual([400, 400, 400, 400, 400, 429, 429]);
    expect(await today()).toBe(5);
  });
  it("with BOT_CHECK=on a request the bot check refuses is not counted", async () => {
    process.env.BOT_CHECK = "on";
    verdict.mockResolvedValue({ isBot: true });
    expect((await signUp(person("bot", { needsPermit: false }))).status).toBe(403);
    expect(await today()).toBe(0);
  });
  it("the app roles hold only what they need: app_candidate cannot delete or move a day, the portal cannot touch it, app_admin only reads", async () => {
    await signUp(person("g", { needsPermit: false }));
    const cand = db.pool("app_candidate"), portal = db.pool("app_portal"), admin = db.pool("app_admin");
    await expect(cand.query("delete from signup_no_count")).rejects.toThrow(/permission denied/);
    await expect(cand.query("update signup_no_count set day = day - 1")).rejects.toThrow(/permission denied/);
    await expect(cand.query("update signup_no_count set count = 0")).rejects.toThrow(/check constraint/);
    await expect(portal.query("select * from signup_no_count")).rejects.toThrow(/permission denied/);
    await expect(admin.query(COUNT_NO)).rejects.toThrow(/permission denied/);
    expect((await admin.query(SIGNUP_NO_SQL)).rows).toHaveLength(1);
  });
});

describe("budgets", () => {
  it("a no stays inside the statement and time budgets; the staff read inside its page budget on a full year", async () => {
    const [, s] = await counted(() => signUp(person("s", { needsPermit: false })));
    expect(s, `${s} statements`).toBeLessThanOrEqual(BUDGET.statements);
    const ms: number[] = [];
    for (let i = 0; i < 9; i++) { const t = performance.now(); await signUp(person(`m${i}`, { needsPermit: false })); ms.push(performance.now() - t); }
    const median = ms.sort((a, b) => a - b)[4]!;
    expect(median).toBeLessThan(BUDGET.medianMs);
    await su.query("insert into signup_no_count(day, count) select current_date - g, 1 + g % 7 from generate_series(1, 1000) g");
    const c = await db.pool("app_admin").connect();
    try { assertPageBudget("signup no counts", await measurePages(c, [SIGNUP_NO_SQL]), BUDGET.pages); } finally { c.release(); }
    console.log(`signup no budget: ${s} statements, median ${median.toFixed(1)} ms`);
  });
});
