// No database: the pool points at a closed port, and nothing here sends a query.
import pg from "pg";
import { describe, expect, it } from "vitest";
import { checkSettings, createAuth, type LoginPool } from ".";

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
