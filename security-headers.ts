// One list of response headers for all three apps, so they cannot drift.
// Script policy (SEC-15) is Report-Only only, never enforcing. Portal and admin get a nonce policy per request from their proxy.ts
// (dynamic pages anyway); candidate gets the nonce-free policy below so its pages can stay cached. Reports go to Sentry's security endpoint.
// The outside host list is not guessed: Sentry only, and Report-Only shows what else the pages load.
import { NextResponse, type NextRequest } from "next/server";

// Strict-Transport-Security has no includeSubDomains or preload until the domain is bought.
const base = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
];

// Sentry security report URL built from the public DSN (https://KEY@HOST/PROJECT); empty when no DSN is set.
export function reportUri(dsn = process.env.NEXT_PUBLIC_SENTRY_DSN): string {
  const m = /^https:\/\/([^@/]+)@([^/]+)\/(\d+)$/.exec(dsn ?? "");
  return m ? `https://${m[2]}/api/${m[3]}/security/?sentry_key=${m[1]}` : "";
}

export function scriptPolicy(nonce?: string, dsn?: string): string {
  const dev = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const script = nonce ? `'self' 'nonce-${nonce}' 'strict-dynamic'` : "'self' 'unsafe-inline'";
  const report = reportUri(dsn);
  return [
    "default-src 'self'",
    `script-src ${script}${dev}`,
    "style-src 'self' 'unsafe-inline'", // scripts are the goal; style nonces would add noise
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self' https://*.sentry.io",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(report ? [`report-uri ${report}`] : []),
  ].join("; ");
}

// For proxy.ts in portal and admin: fresh nonce per request, given to Next (it reads the request header and stamps its own inline scripts).
export function nonceProxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = scriptPolicy(nonce);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy-Report-Only", policy);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy-Report-Only", policy);
  return res;
}

// perRequest: the app's proxy.ts sends the script policy, so it is not sent here too (two reports per page).
export function securityHeaders(extra: { key: string; value: string }[] = [], opts: { perRequest?: boolean } = {}) {
  const policy = opts.perRequest ? [] : [{ key: "Content-Security-Policy-Report-Only", value: scriptPolicy() }];
  return async () => [{ source: "/:path*", headers: [...base, ...policy, ...extra] }];
}
