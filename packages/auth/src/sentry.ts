// Sentry options for all three apps, server and browser (decision #267). Errors and tracing only; no personal data, no Session Replay,
// no Sentry logs. No DSN means Sentry is off (local runs, the test suite). SDK 11 turns most of dataCollection on by default, so every key
// is set here. The scrubbers below are the second guard: they strip the query and fragment from every URL (presigned S3 links and reset or
// verify links carry secrets there), redact email addresses and drop cookies, headers, bodies and user data if anything set them anyway.
// Never call Sentry.setUser: what it sets is sent whatever these options say.
// An email is found from its @ (or %40, an encoded @ in a path) and its domain; the local part is then walked back at most 64 characters. Starting
// from the @ keeps this linear on hostile input: a regex starting at every letter of a 1 MB string took over a second.
const AT_DOMAIN = /(?:@|%40)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,8}/gi;
const LOCAL = /[\w.%+-]/;
function redactEmails(s: string): string {
  let out = "", from = 0;
  for (const m of s.matchAll(AT_DOMAIN)) {
    let start = m.index;
    while (start > from && m.index - start < 64 && LOCAL.test(s[start - 1]!)) start--;
    if (start === m.index) continue; // no local part: not an address
    out += s.slice(from, start) + "[email]";
    from = m.index + m[0].length;
  }
  return out + s.slice(from);
}
// Keys dropped wherever they appear: cookies, headers, user data, query strings and fragments (event fields and span attributes), and the
// culture context (locale and time zone: a visitor's time zone is location; Sentry's server-side rules cannot remove it, checked 19 Nov 2026).
const DROP = /^(cookies?|headers|user|query_string|env|culture)$|^user\.|header|cookie|(^|\.)(query|fragment)$/i;

export function scrubText(s: string): string {
  const out = s.includes("@") || s.includes("%40") ? redactEmails(s) : s;
  // A token with a slash is a URL or a path: cut it at the first ? or #.
  return /[?#]/.test(out) ? out.replace(/\S+/g, (t) => (t.includes("/") ? t.replace(/[?#][\s\S]*/, "") : t)) : out;
}

export function scrub<T>(value: T, depth = 0): T {
  if (typeof value === "string") return scrubText(value) as T;
  if (!value || typeof value !== "object") return value;
  if (depth > 20) return "[Filtered]" as T;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1)) as T;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !DROP.test(k))
      // The SDK's own scope objects; removed before sending.
      .map(([k, v]) => [k, k === "sdkProcessingMetadata" ? v : scrub(v, depth + 1)]),
  ) as T;
}

// The request keeps only its URL (scrubbed) and method: never cookies, headers, body, query or the client address.
export function scrubEvent<E extends { request?: { url?: string; method?: string } }>(event: E): E {
  const { request, ...rest } = event;
  const out = scrub(rest) as E;
  if (request) out.request = scrub({ url: request.url, method: request.method });
  return out;
}

export function sentryOptions(dsn: string | undefined, env: Record<string, string | undefined>) {
  return {
    dsn,
    enabled: Boolean(dsn),
    environment: env.VERCEL_ENV ?? "development",
    // Left out when unset so the SDK keeps the release the build injected.
    ...(env.APP_VERSION ? { release: env.APP_VERSION } : {}),
    tracesSampleRate: env.VERCEL_ENV === "production" ? 0.1 : 1.0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeSend: scrubEvent,
    // Runs only for whole transaction events (traceLifecycle "static"); SDK 11 streams spans by default, and those go through beforeSendSpan.
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: <B>(b: B) => scrub(b),
    beforeSendSpan: <S>(span: S) => scrub(span),
    beforeSendLog: () => null,
  };
}
