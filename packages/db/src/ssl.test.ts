import { describe, expect, it } from "vitest";
import { sslOptions } from "./ssl";

describe("sslOptions", () => {
  it("verifies the certificate by default", () => {
    expect(sslOptions({})).toEqual({ rejectUnauthorized: true });
  });

  it("uses the CA certificate when one is set, restoring newlines from a single-line value", () => {
    expect(sslOptions({ DATABASE_CA_CERT: "line1\\nline2" })).toEqual({ ca: "line1\nline2", rejectUnauthorized: true });
  });

  it("allows no TLS for a local database", () => {
    expect(sslOptions({ DATABASE_SSL: "disable", NODE_ENV: "development" })).toBe(false);
  });

  it("refuses to turn TLS off in production", () => {
    expect(() => sslOptions({ DATABASE_SSL: "disable", NODE_ENV: "production" })).toThrow(/not allowed in production/);
  });
});
