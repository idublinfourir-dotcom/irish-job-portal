// Step 15: Vercel BotID on the candidate site's routes, through the real route handlers on the test database. The BotID service is a
// fake (vi.mock of botid/server), never the real one. With BOT_CHECK=on and the fake saying "bot", sign-up, sign-in, the reset
// request, the confirmation resend and report a job answer 403 BOT_SUSPECTED before anything is read or written: no statement is sent,
// so there is no user, no session, no report and no rate-limit count. Fake people only.
// Measured 16 November 2026 (three runs): a refused request is 0 statements and under 1 ms. Budget: 0 statements, median 25 ms.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkBotId } from "botid/server";
import { createTestDb, urlFor, type TestDb } from "./db";
import { answers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";

vi.mock("botid/server", () => ({ checkBotId: vi.fn() }));
const verdict = vi.mocked(checkBotId) as unknown as ReturnType<typeof vi.fn>;
const BUDGET = { statements: 0, medianMs: 25 };
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let AUTH: Handler, REPORT: Handler;
let live: string;
const before = { BOT_CHECK: process.env.BOT_CHECK };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ POST: REPORT } = await import("../../../apps/candidate/app/api/report/route"));
  const org = await (fixtures(db) as unknown as { F: { org(): Promise<string> } }).F.org();
  const src = (await su.query("insert into job_source(kind,board) values ('portal','bot-b') returning id")).rows[0].id;
  live = (await su.query(`insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,search_vector,salary_low,salary_high,pay_grade)
    values ($1,'admin_manual',$2,'Cook','Fake Org','it','critical_skills','live',now()+interval '20 days','https://example.test/a',to_tsvector('english','cook'),30000,40000,'g1') returning id`, [org, src])).rows[0].id as string;
});
afterAll(async () => {
  if (before.BOT_CHECK === undefined) delete process.env.BOT_CHECK; else process.env.BOT_CHECK = before.BOT_CHECK;
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
beforeEach(() => { verdict.mockReset(); process.env.BOT_CHECK = "on"; });

let n = 0;
const ip = () => `198.51.100.${(++n % 200) + 10}`;
const post = (url: string, body: unknown, extra: Record<string, string> = {}) =>
  new Request(`${BASE}${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": ip(), ...extra } });
const person = (tag: string) => ({ email: `fake.bot.${tag}@example.test`, password: `Fake-${tag}-password-1`, name: `Fake ${tag}`, ...answers });
const count = async (sql: string) => (await su.query(`select count(*)::int n from (${sql}) t`)).rows[0].n as number;
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const AUTH_PATHS = ["sign-up/email", "sign-in/email", "request-password-reset", "send-verification-email"];
const calls = (who = person("x")) => [
  ["sign-up/email", who], ["sign-in/email", { email: who.email, password: who.password }],
  ["request-password-reset", { email: who.email, redirectTo: "/" }], ["send-verification-email", { email: who.email }],
] as const;

describe("BOT_CHECK=on, the fake says bot", () => {
  beforeEach(() => verdict.mockResolvedValue({ isBot: true, isHuman: false, isVerifiedBot: false, bypassed: false }));

  it("refuses sign-up, sign-in, the reset request and the resend with 403 and only the code; nothing is read or written", async () => {
    const [res, statements] = await counted(async () => {
      const out = [];
      for (const [p, body] of calls(person("refused"))) { const r = await AUTH(post(`/api/auth/candidate/${p}`, body)); out.push([r.status, await r.text()]); }
      return out;
    });
    expect(res).toEqual(AUTH_PATHS.map(() => [403, '{"code":"BOT_SUSPECTED"}']));
    expect(statements).toBe(0);
    expect([await count("select 1 from candidate_user"), await count("select 1 from candidate_session"), await count("select 1 from candidate_rate_limit"), await count("select 1 from consent_record")]).toEqual([0, 0, 0, 0]);
  });
  it("refuses a report before the body is read, and files nothing", async () => {
    const req = post("/api/report", { jobId: live, reason: "other" });
    const [r, statements] = await counted(() => REPORT(req));
    expect([r.status, await r.text(), req.bodyUsed, statements]).toEqual([403, '{"code":"BOT_SUSPECTED"}', false, 0]);
    expect(await count("select 1 from report")).toBe(0);
  });
  it("refuses a contact message before the body is read: nothing is counted or written (added at the combine)", async () => {
    const { POST: CONTACT } = await import("../../../apps/candidate/app/api/contact/route");
    const req = post("/api/contact", { topic: "general", name: "Fake Bot", email: "fake.bot.contact@example.test", body: "hello" });
    const [r, statements] = await counted(() => CONTACT(req));
    expect([r.status, await r.text(), req.bodyUsed, statements]).toEqual([403, '{"code":"BOT_SUSPECTED"}', false, 0]);
    expect([await count("select 1 from contact_message"), await count("select 1 from candidate_rate_limit where key like 'contact:%'")]).toEqual([0, 0]);
  });
  it("a bot is refused before the route reads the body: a refused sign-up with a broken body still says BOT_SUSPECTED", async () => {
    const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", body: "not json", headers: { origin: BASE } }));
    expect([r.status, await r.text()]).toEqual([403, '{"code":"BOT_SUSPECTED"}']);
  });
  it("the Google start is checked (C5): a bot is refused before any state is stored or any 'no' counted", async () => {
    const req = post("/api/auth/candidate/sign-in/social", { provider: "google", callbackURL: "/", additionalData: { needsPermit: false } });
    const [r, statements] = await counted(() => AUTH(req));
    expect([r.status, await r.text(), req.bodyUsed, statements]).toEqual([403, '{"code":"BOT_SUSPECTED"}', false, 0]);
    expect([await count("select 1 from candidate_verification"), await count("select 1 from signup_no_count")]).toEqual([0, 0]);
  });
  it("the Google callback and the other Better Auth routes are not checked", async () => {
    const r = await AUTH(new Request(`${BASE}/api/auth/candidate/callback/google?code=x&state=y`, { method: "POST", headers: { origin: BASE } }));
    expect(await r.text()).not.toContain("BOT_SUSPECTED");
    expect(verdict).not.toHaveBeenCalled();
    const out = await AUTH(post("/api/auth/candidate/sign-out", {}));
    expect(out.status).not.toBe(403);
    expect(verdict).not.toHaveBeenCalled();
  });
  it("is fast: a refused request sends no statement and its median is inside the budget", async () => {
    const times: number[] = [];
    for (let i = 0; i < 21; i++) {
      const t = performance.now();
      await AUTH(post("/api/auth/candidate/sign-up/email", person("perf")));
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[10]).toBeLessThan(BUDGET.medianMs);
    const [, statements] = await counted(() => AUTH(post("/api/auth/candidate/sign-in/email", person("perf"))));
    expect(statements).toBe(BUDGET.statements);
  });
});

describe("BOT_CHECK=on, the fake says human", () => {
  beforeEach(() => verdict.mockResolvedValue({ isBot: false, isHuman: true, isVerifiedBot: false, bypassed: false }));

  it("sign-up, sign-in, the reset request, the resend and a report work as today", async () => {
    const who = person("human");
    expect((await AUTH(post("/api/auth/candidate/sign-up/email", who))).status).toBe(200);
    await su.query("update candidate_user set email_verified=true where email=$1", [who.email]);
    const inn = await AUTH(post("/api/auth/candidate/sign-in/email", { email: who.email, password: who.password }));
    expect(inn.status).toBe(200);
    const cookie = inn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect((await AUTH(post("/api/auth/candidate/request-password-reset", { email: who.email, redirectTo: "/" }))).status).toBe(200);
    expect((await AUTH(post("/api/auth/candidate/send-verification-email", { email: who.email }))).status).toBe(200);
    expect((await REPORT(post("/api/report", { jobId: live, reason: "other" }, { cookie }))).status).toBe(200);
    expect(verdict).toHaveBeenCalledTimes(5);
    expect(await count("select 1 from report")).toBe(1);
  });
});

describe("BOT_CHECK=on, the fake throws", () => {
  it("refuses (fail closed)", async () => {
    verdict.mockRejectedValue(new Error("service down"));
    const r = await AUTH(post("/api/auth/candidate/sign-up/email", person("throws")));
    expect([r.status, await r.text()]).toEqual([403, '{"code":"BOT_SUSPECTED"}']);
    expect((await REPORT(post("/api/report", { jobId: live, reason: "other" }))).status).toBe(403);
  });
});

describe("BOT_CHECK off or not exactly on: today's behaviour, and the service is never called", () => {
  it.each([undefined, "", "off", "ON", "true", "1", " on"])("%j", async (value) => {
    if (value === undefined) delete process.env.BOT_CHECK; else process.env.BOT_CHECK = value;
    verdict.mockResolvedValue({ isBot: true, isHuman: false, isVerifiedBot: false, bypassed: false });
    const who = person(`off${String(value).replace(/\W/g, "_")}`);
    const [r, statements] = await counted(() => AUTH(post("/api/auth/candidate/sign-up/email", who)));
    expect(r.status).toBe(200);
    expect(statements).toBeGreaterThan(0);
    expect((await REPORT(post("/api/report", { jobId: live, reason: "other" }))).status).toBe(401); // reaches the session check as before
    expect(verdict).not.toHaveBeenCalled();
  });
  it("a request cannot turn it on: a BOT_CHECK header or query value changes nothing", async () => {
    delete process.env.BOT_CHECK;
    verdict.mockResolvedValue({ isBot: true, isHuman: false, isVerifiedBot: false, bypassed: false });
    const r = await AUTH(post("/api/auth/candidate/sign-up/email?BOT_CHECK=on", person("hdr"), { "bot-check": "on", "x-bot-check": "on", BOT_CHECK: "on" }));
    expect(r.status).toBe(200);
    expect(verdict).not.toHaveBeenCalled();
  });
});
