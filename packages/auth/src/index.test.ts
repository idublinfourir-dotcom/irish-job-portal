// No database: the pool points at a closed port, and nothing here sends a query.
import pg from "pg";
import { describe, expect, it } from "vitest";
import { checkSettings, createAuth, refuseEmail, STAFF_IDLE_SECONDS, STAFF_REFRESH_SECONDS, staffSettings, type LoginPool } from ".";

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
