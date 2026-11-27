import { existsSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import admin from "./admin/next.config";
import candidate from "./candidate/next.config";
import portal from "./portal/next.config";
import { proxy as adminProxy } from "./admin/proxy";
import { proxy as portalProxy } from "./portal/proxy";
import { reportUri } from "../security-headers";

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
    expect(Object.keys(sent).map((k) => k.toLowerCase())).not.toContain("cache-control"); // a rule on every path would cache signed-in pages
  });
  it("has no public/ folder: its files are sent max-age=0, so every visit asks for them again; import them instead", () => {
    expect(existsSync(path.join(import.meta.dirname, name, "public"))).toBe(false);
  });
});

describe("script policy (SEC-15), Report-Only only", () => {
  const dsn = "https://abc123@o1.ingest.de.sentry.io/456";
  const sent = async (config: typeof admin) => Object.fromEntries((await config.headers!())[0]!.headers.map((h) => [h.key, h.value]));

  it("builds the Sentry report URL from the DSN and none without one", () => {
    expect(reportUri(dsn)).toBe("https://o1.ingest.de.sentry.io/api/456/security/?sentry_key=abc123");
    expect(reportUri("")).toBe("");
    expect(reportUri("javascript:alert(1)")).toBe("");
  });
  it("candidate sends the nonce-free policy; portal and admin leave it to proxy.ts; nobody enforces", async () => {
    const c = await sent(candidate);
    expect(c["Content-Security-Policy-Report-Only"]).toContain("script-src 'self' 'unsafe-inline'");
    expect(c["Content-Security-Policy-Report-Only"]).not.toMatch(/nonce-/);
    for (const cfg of [portal, admin]) expect((await sent(cfg))["Content-Security-Policy-Report-Only"]).toBeUndefined();
    for (const cfg of [portal, admin, candidate]) expect((await sent(cfg))["Content-Security-Policy"]).not.toMatch(/script-src|default-src/);
  });
  it.each([["portal", portalProxy], ["admin", adminProxy]])("%s proxy gives each request its own nonce, in the request and response header", (_n, proxy) => {
    const a = proxy(new NextRequest("http://x.test/jobs"));
    const b = proxy(new NextRequest("http://x.test/jobs"));
    const pa = a.headers.get("Content-Security-Policy-Report-Only")!;
    const na = /'nonce-([^']+)'/.exec(pa)![1];
    expect(na).not.toBe(/'nonce-([^']+)'/.exec(b.headers.get("Content-Security-Policy-Report-Only")!)![1]);
    // Next reads the nonce from this forwarded request header and stamps its own inline scripts
    expect(a.headers.get("x-middleware-request-content-security-policy-report-only")).toBe(pa);
    expect(a.headers.get("x-middleware-request-x-nonce")).toBe(na);
    expect(a.headers.get("Content-Security-Policy")).toBeNull();
  });
});
