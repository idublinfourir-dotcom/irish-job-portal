// Step 15: the shared bot check, with a fake BotID (never the real service). Only the exact text "on" turns it on; with it off the service
// is never called and nothing else happens. The time budgets are in the performance test below.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkBotId } from "botid/server";
import { botRefused, botResponse, withBotCheck } from "./bot-check";

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
