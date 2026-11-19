// Unit tests for the shared Sentry options and scrubbers (decision #267). No SDK, no network.
import { describe, expect, it } from "vitest";
import { scrub, scrubEvent, scrubText, sentryOptions } from "./sentry";

const S3 = "https://bucket.s3.eu-west-1.amazonaws.com/cv/1.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAFAKE&X-Amz-Signature=deadbeef";
const RESET = "https://jobs.example.ie/reset-password?token=secret-reset-token#frag";

describe("sentryOptions", () => {
  it("is off without a DSN", () => {
    const o = sentryOptions(undefined, {});
    expect(o.enabled).toBe(false);
    expect(o.dsn).toBeUndefined();
    expect(sentryOptions("", {}).enabled).toBe(false);
  });

  it("samples 10% of traces in production and all elsewhere", () => {
    expect(sentryOptions("https://k@o1.ingest.de.sentry.io/1", { VERCEL_ENV: "production" }).tracesSampleRate).toBe(0.1);
    expect(sentryOptions("x", { VERCEL_ENV: "preview" }).tracesSampleRate).toBe(1.0);
    expect(sentryOptions("x", {}).tracesSampleRate).toBe(1.0);
  });

  it("takes release and environment from the settings, and leaves release out when unset", () => {
    const o = sentryOptions("x", { APP_VERSION: "abc1234", VERCEL_ENV: "production" });
    expect(o.enabled).toBe(true);
    expect(o).toMatchObject({ release: "abc1234", environment: "production" });
    const local = sentryOptions("x", {});
    expect(local.environment).toBe("development");
    expect("release" in local).toBe(false);
  });

  it("sets every dataCollection key off and drops every log", () => {
    const o = sentryOptions("x", {});
    expect(o.dataCollection).toEqual({
      userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
      graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false }, mcp: { inputs: false, outputs: false },
      databaseQueryData: false, queues: false, stackFrameVariables: false,
    });
    expect(o.beforeSendLog()).toBeNull();
    expect(o).not.toHaveProperty("integrations"); // no replay integration
    expect(o).not.toHaveProperty("sendDefaultPii");
  });
});

describe("scrubbers on hostile input", () => {
  it("strips the query and fragment from a presigned S3 link and a reset link", () => {
    expect(scrubText(S3)).toBe("https://bucket.s3.eu-west-1.amazonaws.com/cv/1.pdf");
    expect(scrubText(`fetch failed: GET ${RESET} (500)`)).toBe("fetch failed: GET https://jobs.example.ie/reset-password (500)");
    expect(scrubText("/api/auth/verify-email?token=abc")).toBe("/api/auth/verify-email");
  });

  it("redacts email addresses, plain and URL-encoded", () => {
    expect(scrubText('duplicate key value (email)=(jane.doe+x@example.co.uk) violates "u"')).toBe('duplicate key value (email)=([email]) violates "u"');
    expect(scrubText("/api/users/jane%40example.com/cv")).toBe("/api/users/[email]/cv");
  });

  it("keeps ordinary text", () => {
    expect(scrubText("Job 42 not found")).toBe("Job 42 not found");
  });

  it("handles a 1 MB message in linear time", () => {
    const big = "a".repeat(1_000_000) + "@";
    const t = performance.now();
    expect(scrubText(big)).toBe(big);
    expect(scrubText("/" + "a".repeat(1_000_000) + "?token=x")).toBe("/" + "a".repeat(1_000_000));
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it("drops request data, user and headers, and scrubs nested breadcrumbs", () => {
    const event = {
      message: "boom for jane@example.com",
      user: { id: "u1", email: "jane@example.com", ip_address: "203.0.113.9" },
      request: { url: RESET, method: "POST", cookies: { session: "s" }, headers: { authorization: "Bearer t" }, data: { email: "jane@example.com" }, query_string: "token=x", env: { REMOTE_ADDR: "203.0.113.9" } },
      exception: { values: [{ type: "Error", value: `upload ${S3} failed for bob@example.org` }] },
      breadcrumbs: [{ message: "sent to jane@example.com", data: { url: RESET, nested: { deeper: [{ url: S3, cookie: "c" }] } } }],
      contexts: { response: { headers: { "set-cookie": "s" }, status_code: 500 } },
      sdkProcessingMetadata: { keep: "as is" },
    };
    const out = scrubEvent(event);
    const text = JSON.stringify(out);
    expect(out.request).toEqual({ url: "https://jobs.example.ie/reset-password", method: "POST" });
    expect(out).not.toHaveProperty("user");
    for (const bad of ["jane@", "bob@", "token", "X-Amz", "Bearer", "203.0.113.9", "set-cookie", "session"]) expect(text).not.toContain(bad);
    expect(out.breadcrumbs[0]?.data.nested.deeper[0]).toEqual({ url: "https://bucket.s3.eu-west-1.amazonaws.com/cv/1.pdf" });
    expect(out.contexts.response).toEqual({ status_code: 500 });
    expect(out.sdkProcessingMetadata).toBe(event.sdkProcessingMetadata);
  });

  it("scrubs span names and URL attributes, and drops query and header attributes", () => {
    const span = scrub({
      name: `GET ${S3}`,
      attributes: { "url.full": RESET, "url.query": "token=x", "http.target": "/api/x?token=y", "http.request.header.cookie": ["c"], "user.email": "a@b.ie", "db.query.text": "select $1" },
    });
    expect(span).toEqual({
      name: "GET https://bucket.s3.eu-west-1.amazonaws.com/cv/1.pdf",
      attributes: { "url.full": "https://jobs.example.ie/reset-password", "http.target": "/api/x", "db.query.text": "select $1" },
    });
  });

  it("cleans a transaction event: name, request URL, tags and contexts", () => {
    const o = sentryOptions("x", {});
    expect(o.beforeSendTransaction).toBe(scrubEvent);
    const out = o.beforeSendTransaction({
      type: "transaction",
      transaction: "/reset-password?token=secret-reset-token for jane@example.com",
      request: { url: RESET, method: "GET", headers: { cookie: "c" } },
      tags: { url: S3, who: "jane@example.com" },
      contexts: { trace: { data: { "url.full": RESET, "url.query": "token=x" } } },
      user: { email: "jane@example.com" },
    });
    expect(out.transaction).toBe("/reset-password for [email]");
    expect(out.request).toEqual({ url: "https://jobs.example.ie/reset-password", method: "GET" });
    expect(out.tags).toEqual({ url: "https://bucket.s3.eu-west-1.amazonaws.com/cv/1.pdf", who: "[email]" });
    expect(out.contexts.trace.data).toEqual({ "url.full": "https://jobs.example.ie/reset-password" });
    expect(JSON.stringify(out)).not.toMatch(/token|jane|X-Amz|cookie|user/);
  });

  it("cuts objects nested deeper than 20 levels", () => {
    let deep: Record<string, unknown> = { url: RESET };
    for (let i = 0; i < 30; i++) deep = { next: deep };
    expect(JSON.stringify(scrub(deep))).not.toContain("token");
  });
});
