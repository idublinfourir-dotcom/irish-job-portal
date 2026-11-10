// One list of response headers for all three apps, so they cannot drift.
// No script policy on purpose: it needs a nonce per request, which makes every page dynamic. That trade is the owner's.
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

export function securityHeaders(extra: { key: string; value: string }[] = []) {
  return async () => [{ source: "/:path*", headers: [...base, ...extra] }];
}
