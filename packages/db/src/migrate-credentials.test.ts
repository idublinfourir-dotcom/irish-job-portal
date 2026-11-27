import { describe, expect, it } from "vitest";
import { migrateCredentials } from "./migrate-credentials";

describe("migrateCredentials (DEP-5: drizzle-kit must get ssl)", () => {
  const url = "postgresql://postgres.abc:p%40ss%2Fw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres";
  it("production shape: parts plus verified TLS, password decoded", () => {
    const c = migrateCredentials({ DATABASE_URL_MIGRATE: url });
    expect(c).toMatchObject({ host: "aws-0-eu-west-1.pooler.supabase.com", port: 5432, user: "postgres.abc", password: "p@ss/w", database: "postgres", ssl: { rejectUnauthorized: true } });
    expect(c).not.toHaveProperty("url");
  });
  it("local test database: DATABASE_SSL=disable gives ssl false", () => {
    expect(migrateCredentials({ DATABASE_URL_MIGRATE: "postgres://u:p@localhost:5433/db", DATABASE_SSL: "disable" })).toMatchObject({ port: 5433, ssl: false });
  });
  it("unset: a url key only, so drizzle-kit reports the missing credentials", () => {
    expect(migrateCredentials({})).toEqual({ url: "" });
  });
  it("disable is refused in production", () => {
    expect(() => migrateCredentials({ DATABASE_URL_MIGRATE: url, DATABASE_SSL: "disable", NODE_ENV: "production" })).toThrow();
  });
});
