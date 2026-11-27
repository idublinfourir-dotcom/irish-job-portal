// Step 15: the shared bot check, with a fake BotID (never the real service). Only the exact text "on" turns it on; with it off the service
// is never called and nothing else happens. The time budgets are in the performance test below.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkBotId } from "botid/server";
import { botCheckOn, botRefused, botResponse, CHECKED, withBotCheck } from "./bot-check";

vi.mock("botid/server", () => ({ checkBotId: vi.fn() }));
const fake = vi.mocked(checkBotId) as unknown as ReturnType<typeof vi.fn>;
const verdict = (isBot: boolean) => ({ isBot, isHuman: !isBot, isVerifiedBot: false, bypassed: false });
beforeEach(() => { fake.mockReset(); vi.unstubAllEnvs(); });

describe("botRefused", () => {
  it("is false at once with the setting missing or off, and never calls the service", async () => {
    fake.mockResolvedValue(verdict(true));
    expect(await botRefused({})).toBe(false);
    expect(await botRefused({ BOT_CHECK: "off" })).toBe(false);
    expect(fake).not.toHaveBeenCalled();
  });
  it("only the exact text on turns it on: ON, true, 1, empty and spaces are off", async () => {
    fake.mockResolvedValue(verdict(true));
    for (const v of ["ON", "On", "true", "1", "", " on", "on "]) expect(await botRefused({ BOT_CHECK: v }), JSON.stringify(v)).toBe(false);
    expect(fake).not.toHaveBeenCalled();
    expect(await botRefused({ BOT_CHECK: "on" })).toBe(true);
  });
  it("on with a human: not refused", async () => {
    fake.mockResolvedValue(verdict(false));
    expect(await botRefused({ BOT_CHECK: "on" })).toBe(false);
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it("on with a bot: refused", async () => {
    fake.mockResolvedValue(verdict(true));
    expect(await botRefused({ BOT_CHECK: "on" })).toBe(true);
  });
  it("on with a check that throws: refused (fail closed)", async () => {
    fake.mockRejectedValue(new Error("boom"));
    expect(await botRefused({ BOT_CHECK: "on" })).toBe(true);
    fake.mockImplementation(() => { throw new Error("sync boom"); });
    expect(await botRefused({ BOT_CHECK: "on" })).toBe(true);
  });
  it("performance: with the setting off the added work is one string compare (1,000 calls well under 50 ms); with the fake on, 1,000 calls under 100 ms", async () => {
    let t = performance.now();
    for (let i = 0; i < 1000; i++) await botRefused({});
    expect(performance.now() - t).toBeLessThan(50);
    expect(fake).not.toHaveBeenCalled();
    fake.mockResolvedValue(verdict(false));
    t = performance.now();
    for (let i = 0; i < 1000; i++) await botRefused({ BOT_CHECK: "on" });
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe("SEC-2: the default on Vercel's production", () => {
  const prod = { VERCEL_ENV: "production" };
  it("with the variable missing, empty or mistyped the check is on, and a bot is refused", async () => {
    fake.mockResolvedValue(verdict(true));
    for (const v of [undefined, "", "ON", "true", "of", "OFF", " off"]) {
      const env = v === undefined ? prod : { ...prod, BOT_CHECK: v };
      expect(botCheckOn(env), JSON.stringify(v)).toBe(true);
      expect(await botRefused(env), JSON.stringify(v)).toBe(true);
    }
  });
  it("only the exact text off turns it off; a human passes; a throwing check refuses", async () => {
    fake.mockResolvedValue(verdict(true));
    expect(await botRefused({ ...prod, BOT_CHECK: "off" })).toBe(false);
    expect(fake).not.toHaveBeenCalled();
    fake.mockResolvedValue(verdict(false));
    expect(await botRefused(prod)).toBe(false);
    fake.mockRejectedValue(new Error("boom"));
    expect(await botRefused(prod)).toBe(true);
  });
  it("previews, development and NODE_ENV=production off Vercel keep the old rule: on only with on", () => {
    for (const env of [{ VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, { NODE_ENV: "production" }, { VERCEL_ENV: "Production" }])
      expect([botCheckOn(env), botCheckOn({ ...env, BOT_CHECK: "on" })], JSON.stringify(env)).toEqual([false, true]);
  });
  it("withBotCheck refuses a bot on sign-up in production with the variable unset", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("BOT_CHECK", undefined);
    fake.mockResolvedValue(verdict(true));
    const handler = vi.fn(async () => new Response("handled"));
    expect((await withBotCheck(new Request("https://x.test/api/auth/candidate/sign-up/email", { method: "POST", body: "{}" }), handler)).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
});

// A route the server checks but the page does not protect is refused by BotID for everyone, so the lists must match (SEC-2: with the check on
// by default, a gap here would lock every visitor out of that route). Read as text: the client files run initBotId on import.
describe("SEC-2: the browser lists equal the server's", () => {
  const protectedPaths = (app: string) => [...readFileSync(new URL(`../../../apps/${app}/instrumentation-client.ts`, import.meta.url), "utf8").matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]!);
  it("candidate: every checked auth route, report and contact", () => {
    const paths = protectedPaths("candidate");
    expect(paths.filter((p) => p.startsWith("/api/auth/candidate/")).map((p) => p.slice("/api/auth/candidate".length)).sort()).toEqual([...CHECKED].sort());
    expect(paths.filter((p) => !p.startsWith("/api/auth/")).sort()).toEqual(["/api/contact", "/api/report"]);
  });
  it("portal: every checked auth route the portal pool has (no Google, no unverified-email change), report and contact", () => {
    const paths = protectedPaths("portal");
    expect(paths.filter((p) => p.startsWith("/api/auth/portal/")).map((p) => p.slice("/api/auth/portal".length)).sort())
      .toEqual(CHECKED.filter((p) => p !== "/sign-in/social" && p !== "/change-unverified-email").sort());
    expect(paths.filter((p) => !p.startsWith("/api/auth/")).sort()).toEqual(["/api/portal/contact", "/api/portal/report"]);
  });
});

describe("botResponse", () => {
  it("is 403 with the code and nothing else", async () => {
    const r = botResponse();
    expect([r.status, await r.text()]).toEqual([403, '{"code":"BOT_SUSPECTED"}']);
  });
});

describe("withBotCheck", () => {
  const handler = vi.fn(async () => new Response("handled"));
  const req = (path: string, method = "POST", body = "{}") => new Request(`https://x.test${path}`, { method, body: method === "GET" ? undefined : body });
  beforeEach(() => { handler.mockClear(); vi.stubEnv("BOT_CHECK", "on"); fake.mockResolvedValue(verdict(true)); });

  it("refuses a bot on the five checked routes (any case, trailing slash) without calling the handler or reading the body", async () => {
    for (const p of ["sign-up/email", "sign-in/email", "request-password-reset", "send-verification-email", "sign-in/social"])
      for (const variant of [`/api/auth/candidate/${p}`, `/api/auth/candidate/${p}/`, `/API/AUTH/CANDIDATE/${p.toUpperCase()}`, `/api/auth/candidate/${p.replace("e", "%65")}`, "/api/auth/candidate/sign-in/email%zz"]) {
        const r = req(variant);
        const out = await withBotCheck(r, handler);
        expect([out.status, await out.text(), r.bodyUsed], variant).toEqual([403, '{"code":"BOT_SUSPECTED"}', false]);
      }
    expect(handler).not.toHaveBeenCalled();
  });
  it("lets other routes and GETs through without asking the service", async () => {
    for (const r of [req("/api/auth/candidate/sign-out"), req("/api/auth/candidate/link-social"), req("/api/auth/candidate/callback/google"), req("/api/auth/candidate/sign-up/email", "GET")])
      expect(await (await withBotCheck(r, handler)).text()).toBe("handled");
    expect(fake).not.toHaveBeenCalled();
  });
  it("lets a human through to the handler", async () => {
    fake.mockResolvedValue(verdict(false));
    expect(await (await withBotCheck(req("/api/auth/portal/sign-up/email"), handler)).text()).toBe("handled");
  });
  it("with the setting off, calls the handler and never the service", async () => {
    vi.stubEnv("BOT_CHECK", "off");
    expect(await (await withBotCheck(req("/api/auth/candidate/sign-up/email"), handler)).text()).toBe("handled");
    expect(fake).not.toHaveBeenCalled();
  });
});
