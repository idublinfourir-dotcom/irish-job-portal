// Integration: the real Sentry server SDK with the shared options (decision #267), an in-memory transport in place of sentry.io, the candidate
// app's real health route behind a real HTTP server, and the app's real onRequestError hook. A request carries a cookie, an authorization
// header, a JSON body with an email and a token in the query; nothing of it may reach an event or a span. No database needed (the health
// route answers 503 without one).
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as Sentry from "@sentry/nextjs";
import { createTransport, parseEnvelope, type BaseTransportOptions } from "@sentry/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sentryOptions } from "@portal/auth/sentry";
import { GET } from "./candidate/app/api/health/route";
import { onRequestError } from "./candidate/instrumentation";

const DSN = "https://publickey@o1.ingest.de.sentry.io/1";
const SECRETS = ["session=s3cret-cookie", "Bearer s3cret-auth", "jane.doe@example.com", "s3cret-token", "?token", "x-amz", "X-Amz-Signature="];
const sent: string[] = [];
const hosts: string[] = [];
let base = "";
let server: http.Server;

beforeAll(async () => {
  // Every connection and fetch is recorded, so a request to a sentry.io host fails the last test even if the SDK swallowed the error.
  const connect = net.Socket.prototype.connect;
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: unknown[]) {
    const a = (Array.isArray(args[0]) ? args[0][0] : args[0]) as { host?: string; servername?: string } | number | string;
    hosts.push(String(typeof a === "object" && a ? a.servername ?? a.host : args[1]));
    return connect.apply(this, args as never);
  } as never);
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    hosts.push(String(input instanceof Request ? input.url : input));
    return realFetch(input, init);
  });

  Sentry.init({
    ...sentryOptions(DSN, { APP_VERSION: "abc1234", VERCEL_ENV: "preview" }),
    transport: (o: BaseTransportOptions) => createTransport(o, async (req) => {
      sent.push(typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body));
      return { statusCode: 200 };
    }),
  });

  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url!, base);
    // The span Next's own tracing would open for the request, named with the raw URL to prove the scrubber.
    await Sentry.startSpan({ name: `${req.method} ${req.url}`, op: "http.server", attributes: { "url.full": url.href, "http.target": req.url, "url.query": url.search } }, async () => {
      const reply = await GET();
      if (url.pathname === "/boom") {
        const err = new Error(`insert failed for ${JSON.parse(body).email} at ${url.href}`);
        await onRequestError(err, { path: req.url!, method: req.method!, headers: req.headers }, { routerKind: "App Router", routePath: "/api/health", routeType: "route", renderSource: undefined, revalidateReason: undefined, renderType: undefined } as never);
        res.writeHead(500).end();
        return;
      }
      res.writeHead(reply.status).end(await reply.text());
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  vi.restoreAllMocks();
});

const call = (p: string) => fetch(base + p, {
  method: "POST",
  headers: { cookie: "session=s3cret-cookie", authorization: "Bearer s3cret-auth", "content-type": "application/json" },
  body: JSON.stringify({ email: "jane.doe@example.com" }),
});
const items = () => sent.flatMap((e) => parseEnvelope(e)[1] as unknown as [{ type: string }, unknown][]);

describe("Sentry server SDK with the shared options", () => {
  it("captures a route error with route, release and environment, and none of the cookie, header, body, email, token or query", async () => {
    expect((await call("/boom?token=s3cret-token&X-Amz-Signature=x-amz")).status).toBe(500);
    await Sentry.flush(2000);
    const errors = items().filter(([h]) => h.type === "event").map(([, e]) => e as Sentry.ErrorEvent);
    expect(errors).toHaveLength(1);
    const event = errors[0]!;
    expect(event.release).toBe("abc1234");
    expect(event.environment).toBe("preview");
    expect(event.transaction).toBe("POST /api/health");
    expect(event.contexts?.nextjs).toMatchObject({ router_path: "/api/health", request_path: "/boom" });
    expect(event.exception?.values?.[0]?.value).toBe(`insert failed for [email] at ${base}/boom`);
    expect(event.user).toBeUndefined();
    expect(event.request).toEqual({ url: `${base}/boom`, method: "POST" }); // set by the SDK's HTTP integration; only these two stay
    const text = JSON.stringify(event);
    for (const s of SECRETS) expect(text).not.toContain(s);
  });

  it("sends the traced request as spans whose names and URLs carry no query string", async () => {
    sent.length = 0;
    expect((await call("/api/health?token=s3cret-token")).status).toBe(503);
    await Sentry.flush(2000);
    const spans = items().filter(([h]) => h.type === "span").flatMap(([, c]) => (c as { items: { name: string; attributes: Record<string, { value: unknown }> }[] }).items);
    const segment = spans.find((s) => s.name.startsWith("POST /api/health"));
    expect(segment?.name).toBe("POST /api/health");
    expect(segment?.attributes["url.full"]?.value).toBe(`${base}/api/health`);
    expect(segment?.attributes["http.target"]?.value).toBe("/api/health");
    expect(segment?.attributes["url.query"]).toBeUndefined();
    expect(segment?.attributes["sentry.release"]?.value).toBe("abc1234");
    const text = JSON.stringify(spans);
    for (const s of SECRETS) expect(text).not.toContain(s);
  });

  it("sends no log, no replay and nothing to a sentry.io host", async () => {
    Sentry.logger.info("a log for jane.doe@example.com");
    await Sentry.flush(2000);
    expect(sent.length).toBeGreaterThan(0);
    const types = new Set(items().map(([h]) => h.type));
    for (const t of ["log", "replay_event", "replay_recording"]) expect(types.has(t)).toBe(false);
    expect(hosts.filter((h) => h.includes("sentry.io"))).toEqual([]);
  });
});

describe("client code", () => {
  // Every file the browser loads Sentry from: only the public DSN and Vercel's public environment, never the auth token.
  it.each(["candidate", "portal", "admin"])("%s instrumentation-client.ts reads only NEXT_PUBLIC_ values", (app) => {
    const dir = path.join(__dirname, app);
    expect(readdirSync(dir)).toContain("instrumentation-client.ts");
    const src = readFileSync(path.join(dir, "instrumentation-client.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(src.match(/process\.env\.\w+/g)).toEqual(["process.env.NEXT_PUBLIC_SENTRY_DSN", "process.env.NEXT_PUBLIC_VERCEL_ENV"]);
    expect(src).not.toMatch(/replay|setUser|SENTRY_AUTH_TOKEN/i);
  });
});
