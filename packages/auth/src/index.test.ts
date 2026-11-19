// No database: the pool points at a closed port, and nothing here sends a query.
import pg from "pg";
import { describe, expect, it } from "vitest";
import { authSettings, candidateSettings, checkSettings, createAuth, googleSettings, portalSettings, refuseEmail, STAFF_IDLE_SECONDS, STAFF_REFRESH_SECONDS, staffSettings, type LoginPool } from ".";

const secret = "a".repeat(32);
const database = new pg.Pool({ connectionString: "postgres://nobody:none@127.0.0.1:1/none" });
const make = (name: LoginPool, baseURL = "http://localhost:3000") => createAuth(name, { database, baseURL, secret, sendEmail: async () => {} });

describe("createAuth refuses bad settings", () => {
  it("refuses a secret shorter than 32 characters", () => {
    expect(() => createAuth("candidate", { database, baseURL: "https://example.test", secret: "a".repeat(31), sendEmail: async () => {} })).toThrow(/32 characters/);
    expect(() => checkSettings("https://example.test", secret)).not.toThrow();
  });
  it("refuses a base URL that is not https, except http://localhost and http://127.0.0.1", () => {
    for (const bad of ["http://example.test", "http://localhost.example.test", "http://127.0.0.1.example.test", "ftp://localhost", "localhost:3000", ""])
      expect(() => checkSettings(bad, secret), bad).toThrow();
    for (const good of ["https://example.test", "http://localhost:3000", "http://127.0.0.1:3000"])
      expect(() => checkSettings(good, secret), good).not.toThrow();
  });
  it("secure cookies are on whenever the base URL is https", async () => {
    expect((await make("portal", "https://portal.example.test").$context).authCookies.sessionToken.name).toBe("__Secure-portal.session_token");
    expect((await make("portal").$context).authCookies.sessionToken.name).toBe("portal.session_token");
  });
});

describe("each pool is separate", () => {
  for (const name of ["candidate", "portal", "staff"] as const)
    it(`${name}: own table names, cookie prefix and sign-up setting`, async () => {
      const ctx = await make(name).$context;
      expect([ctx.tables.user?.modelName, ctx.tables.session?.modelName, ctx.tables.account?.modelName, ctx.tables.verification?.modelName, ctx.tables.rateLimit?.modelName])
        .toEqual(["user", "session", "account", "verification", "rate_limit"].map((t) => `${name}_${t}`));
      expect(ctx.authCookies.sessionToken.name).toBe(`${name}.session_token`);
      expect(ctx.options.emailAndPassword?.disableSignUp).toBe(name === "staff");
      expect(ctx.options.emailAndPassword?.requireEmailVerification).toBe(name !== "staff");
    });
});

describe("staff settings and idle limit (#172)", () => {
  it("staffSettings fails closed when a setting is missing or bad", () => {
    expect(() => staffSettings({})).toThrow(/STAFF_AUTH_URL and STAFF_AUTH_SECRET/);
    expect(() => staffSettings({ STAFF_AUTH_URL: "https://admin.example.test" })).toThrow(/must be set/);
    expect(() => staffSettings({ STAFF_AUTH_SECRET: secret })).toThrow(/must be set/);
    expect(() => staffSettings({ STAFF_AUTH_URL: "https://admin.example.test", STAFF_AUTH_SECRET: "short" })).toThrow(/32 characters/);
    expect(() => staffSettings({ STAFF_AUTH_URL: "http://admin.example.test", STAFF_AUTH_SECRET: secret })).toThrow(/https/);
    expect(staffSettings({ STAFF_AUTH_URL: "https://admin.example.test", STAFF_AUTH_SECRET: secret })).toEqual({ baseURL: "https://admin.example.test", secret });
  });
  it("refuseEmail sends nothing and says why", async () => {
    await expect(refuseEmail("staff", "reset", "a@example.test", "https://x.test/r")).rejects.toThrow(/not set up for the staff pool/);
  });
  it("only the staff pool has the 8-hour idle limit; candidate and portal keep Better Auth's defaults", async () => {
    for (const name of ["candidate", "portal", "staff"] as const) {
      const c = (await make(name).$context).sessionConfig;
      expect([c.expiresIn, c.updateAge], name).toEqual(name === "staff" ? [STAFF_IDLE_SECONDS, STAFF_REFRESH_SECONDS] : [7 * 86400, 86400]);
    }
    expect(STAFF_IDLE_SECONDS).toBe(8 * 3600);
  });
});

describe("candidate settings and sessions (#177)", () => {
  it("candidateSettings fails closed when a setting is missing or bad, and names the right variables", () => {
    expect(() => candidateSettings({})).toThrow(/CANDIDATE_AUTH_URL and CANDIDATE_AUTH_SECRET/);
    expect(() => candidateSettings({ STAFF_AUTH_URL: "https://admin.example.test", STAFF_AUTH_SECRET: secret })).toThrow(/CANDIDATE_AUTH_URL/);
    expect(() => candidateSettings({ CANDIDATE_AUTH_URL: "https://x.example.test", CANDIDATE_AUTH_SECRET: "short" })).toThrow(/32 characters/);
    expect(() => candidateSettings({ CANDIDATE_AUTH_URL: "http://x.example.test", CANDIDATE_AUTH_SECRET: secret })).toThrow(/https/);
    expect(candidateSettings({ CANDIDATE_AUTH_URL: "http://localhost:3000", CANDIDATE_AUTH_SECRET: secret })).toEqual({ baseURL: "http://localhost:3000", secret });
    expect(authSettings("PORTAL", { PORTAL_AUTH_URL: "https://p.example.test", PORTAL_AUTH_SECRET: secret }).baseURL).toBe("https://p.example.test");
  });
  it("a candidate session lasts 7 days and is moved out at most once a day (Better Auth's defaults, pinned)", async () => {
    const c = (await make("candidate").$context).sessionConfig;
    expect([c.expiresIn, c.updateAge]).toEqual([604800, 86400]);
  });
  it("the candidate and portal pools check the sign-up answers before the route runs; the staff pool does not", async () => {
    const candidate = await make("candidate").$context, portal = await make("portal").$context;
    expect(candidate.options.plugins?.map((p) => p.id)).toEqual(["candidate-email-limit", "candidate-signup", "candidate-reauth"]);
    expect(portal.options.plugins?.map((p) => p.id)).toEqual(["portal-email-limit", "portal-signup", "portal-reauth"]);
    expect((await make("staff").$context).options.plugins?.map((p) => p.id)).not.toContain("staff-signup");
  });
  it("sign-in, sign-up, the Google start, reset and resend each have their own rate limit", async () => {
    const rules = (await make("candidate").$context).options.rateLimit?.customRules ?? {};
    expect(Object.keys(rules).sort()).toEqual(["/change-email", "/request-password-reset", "/send-verification-email", "/sign-in/email", "/sign-in/social", "/sign-up/email"]);
    expect(rules["/change-email"]).toEqual({ window: 300, max: 3 }); // C4: each change sends an email
    expect(rules["/sign-in/social"]).toEqual({ window: 60, max: 5 }); // C5: each Google "no" costs a limited start
    expect(rules["/send-verification-email"]).toEqual({ window: 300, max: 3 });
  });
});

describe("Google sign-in settings (#179)", () => {
  const g = { clientId: "fake-id", clientSecret: "fake-secret" };
  it("is on only when both variables are set and not empty", () => {
    expect(googleSettings({ GOOGLE_CLIENT_ID: "fake-id", GOOGLE_CLIENT_SECRET: "fake-secret" })).toEqual(g);
    for (const env of [{}, { GOOGLE_CLIENT_ID: "fake-id" }, { GOOGLE_CLIENT_SECRET: "fake-secret" }, { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "fake-secret" }, { GOOGLE_CLIENT_ID: "fake-id", GOOGLE_CLIENT_SECRET: "" }])
      expect(googleSettings(env), JSON.stringify(env)).toBeUndefined();
  });
  it("only the candidate pool gets the provider, and only when settings are passed", async () => {
    const on = (name: LoginPool, google?: typeof g) => createAuth(name, { database, baseURL: "http://localhost:3000", secret, sendEmail: async () => {}, google }).$context;
    expect((await on("candidate", g)).socialProviders.map((p) => p.id)).toEqual(["google"]);
    expect((await on("candidate")).socialProviders).toEqual([]);
    for (const name of ["portal", "staff"] as const) expect((await on(name, g)).socialProviders, name).toEqual([]);
  });
  it("account linking is pinned: no trusted providers, and the local email must be confirmed", async () => {
    const o = (await make("candidate").$context).options.account?.accountLinking;
    expect(o).toEqual({ enabled: true, requireLocalEmailVerified: true, trustedProviders: [] });
  });
});

describe("portal settings and sessions (#189, #190)", () => {
  it("portalSettings fails closed when a setting is missing or bad, and names the right variables", () => {
    expect(() => portalSettings({})).toThrow(/PORTAL_AUTH_URL and PORTAL_AUTH_SECRET/);
    expect(() => portalSettings({ CANDIDATE_AUTH_URL: "http://localhost:3000", CANDIDATE_AUTH_SECRET: secret })).toThrow(/PORTAL_AUTH_URL/);
    expect(() => portalSettings({ PORTAL_AUTH_URL: "http://localhost:3001" })).toThrow(/must be set/);
    expect(() => portalSettings({ PORTAL_AUTH_URL: "https://p.example.test", PORTAL_AUTH_SECRET: "short" })).toThrow(/32 characters/);
    expect(() => portalSettings({ PORTAL_AUTH_URL: "http://p.example.test", PORTAL_AUTH_SECRET: secret })).toThrow(/https/);
    expect(portalSettings({ PORTAL_AUTH_URL: "http://localhost:3001", PORTAL_AUTH_SECRET: secret })).toEqual({ baseURL: "http://localhost:3001", secret });
  });
  it("a portal session lasts 7 days and is moved out at most once a day (Better Auth's defaults, pinned); email confirmation is required", async () => {
    const ctx = await make("portal").$context;
    expect([ctx.sessionConfig.expiresIn, ctx.sessionConfig.updateAge]).toEqual([604800, 86400]);
    expect(ctx.options.emailAndPassword?.requireEmailVerification).toBe(true);
    expect(ctx.options.session?.cookieCache?.enabled).toBe(false);
  });
});
