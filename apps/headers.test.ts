import { describe, expect, it } from "vitest";
import admin from "./admin/next.config";
import candidate from "./candidate/next.config";
import portal from "./portal/next.config";

const must: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
};

describe.each([["admin", admin], ["candidate", candidate], ["portal", portal]])("%s next.config security headers", (name, config) => {
  it("sends every header on every path and hides x-powered-by", async () => {
    expect(config.poweredByHeader).toBe(false);
    const rules = await config.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe("/:path*");
    const sent = Object.fromEntries(rules[0]!.headers.map((h) => [h.key, h.value]));
    for (const [k, v] of Object.entries(must)) expect(sent[k]).toBe(v);
    expect(sent["Strict-Transport-Security"]).not.toMatch(/includeSubDomains|preload/);
    expect(sent["X-Robots-Tag"]).toBe(name === "admin" ? "noindex, nofollow" : undefined);
  });
});
