// Step 15: Vercel BotID on the portal's routes, through the real route handlers on the test database. BotID is a fake (vi.mock of
// botid/server). With BOT_CHECK=on and the fake saying "bot", sign-up, sign-in, the reset request, the resend and report a job answer
// 403 BOT_SUSPECTED before anything is read or written. With "human" they work as today. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkBotId } from "botid/server";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";

vi.mock("botid/server", () => ({ checkBotId: vi.fn() }));
const verdict = vi.mocked(checkBotId) as unknown as ReturnType<typeof vi.fn>;
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let AUTH: Handler, REPORT: Handler;
let live: string;
const before = { BOT_CHECK: process.env.BOT_CHECK };
const bot = { isBot: true, isHuman: false, isVerifiedBot: false, bypassed: false };
const human = { isBot: false, isHuman: true, isVerifiedBot: false, bypassed: false };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ POST: REPORT } = await import("../../../apps/portal/app/api/portal/report/route"));
  const org = await (fixtures(db) as unknown as { F: { org(): Promise<string> } }).F.org();
  const src = (await su.query("insert into job_source(kind,board) values ('portal','bot-p') returning id")).rows[0].id;
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
const post = (url: string, body: unknown, extra: Record<string, string> = {}) =>
  new Request(`${BASE}${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${(++n % 200) + 10}`, ...extra } });
const person = (tag: string) => ({ email: `fake.bot.${tag}@example.test`, password: `Fake-${tag}-password-1`, name: `Fake ${tag}`, ...portalAnswers });
const count = async (sql: string) => (await su.query(`select count(*)::int n from (${sql}) t`)).rows[0].n as number;
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}

describe("portal, BOT_CHECK=on, the fake says bot", () => {
  it("refuses sign-up, sign-in, the reset request, the resend and a report with 403; nothing is read or written", async () => {
    verdict.mockResolvedValue(bot);
    const who = person("refused");
    const [res, statements] = await counted(async () => {
      const out = [];
      for (const [p, body] of [["sign-up/email", who], ["sign-in/email", { email: who.email, password: who.password }], ["request-password-reset", { email: who.email, redirectTo: "/" }], ["send-verification-email", { email: who.email }]] as const) {
        const r = await AUTH(post(`/api/auth/portal/${p}`, body)); out.push([r.status, await r.text()]);
      }
      const req = post("/api/portal/report", { jobId: live, reason: "other" });
      const r = await REPORT(req); out.push([r.status, await r.text(), req.bodyUsed]);
      return out;
    });
    expect(res).toEqual([...Array(4).fill([403, '{"code":"BOT_SUSPECTED"}']), [403, '{"code":"BOT_SUSPECTED"}', false]]);
    expect(statements).toBe(0);
    expect([await count("select 1 from portal_user"), await count("select 1 from portal_session"), await count("select 1 from portal_rate_limit"), await count("select 1 from report")]).toEqual([0, 0, 0, 0]);
  });
  it("refuses a contact message before the body is read or the login is looked up (added at the combine)", async () => {
    verdict.mockResolvedValue(bot);
    const { POST: CONTACT } = await import("../../../apps/portal/app/api/portal/contact/route");
    const req = post("/api/portal/contact", { topic: "general", body: "hello" });
    const [r, statements] = await counted(() => CONTACT(req));
    expect([r.status, await r.text(), req.bodyUsed, statements]).toEqual([403, '{"code":"BOT_SUSPECTED"}', false, 0]);
    expect(await count("select 1 from contact_message")).toBe(0);
  });
  it("refuses a signed-out appeal (C3) the same way: nothing is read, counted or written", async () => {
    verdict.mockResolvedValue(bot);
    const { POST: CONTACT } = await import("../../../apps/portal/app/api/portal/contact/route");
    const req = post("/api/portal/contact", { topic: "appeal", name: "Fake Bot", email: "fake.bot.appeal@example.test", body: "let me back in" });
    const [r, statements] = await counted(() => CONTACT(req));
    expect([r.status, await r.text(), req.bodyUsed, statements]).toEqual([403, '{"code":"BOT_SUSPECTED"}', false, 0]);
    expect([await count("select 1 from contact_message"), await count("select 1 from portal_rate_limit where key like 'contact:%'")]).toEqual([0, 0]);
  });
});

describe("portal, BOT_CHECK=on, the fake says human", () => {
  it("sign-up, sign-in, the reset request, the resend and a report work as today", async () => {
    verdict.mockResolvedValue(human);
    const who = person("human");
    expect((await AUTH(post("/api/auth/portal/sign-up/email", who))).status).toBe(200);
    await su.query("update portal_user set email_verified=true where email=$1", [who.email]);
    const inn = await AUTH(post("/api/auth/portal/sign-in/email", { email: who.email, password: who.password }));
    expect(inn.status).toBe(200);
    const cookie = inn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect((await AUTH(post("/api/auth/portal/request-password-reset", { email: who.email, redirectTo: "/" }))).status).toBe(200);
    expect((await AUTH(post("/api/auth/portal/send-verification-email", { email: who.email }))).status).toBe(200);
    expect((await REPORT(post("/api/portal/report", { jobId: live, reason: "other" }, { cookie }))).status).toBe(200);
    expect(verdict).toHaveBeenCalledTimes(5);
    expect(await count("select 1 from report")).toBe(1);
  });
  it("with the setting off, the service is never called and sign-up works", async () => {
    delete process.env.BOT_CHECK;
    verdict.mockResolvedValue(bot);
    expect((await AUTH(post("/api/auth/portal/sign-up/email", person("off")))).status).toBe(200);
    expect(verdict).not.toHaveBeenCalled();
  });
});
