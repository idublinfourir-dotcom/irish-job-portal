// Performance: Sentry (decision #267). The scrubbers on a large error event, and the extra time the server SDK adds to one call of the candidate
// health route through a real local HTTP server (median of 9 with and without Sentry). Sentry sends to an in-memory transport, never to sentry.io.
// No database rows are read (the health route answers 503 when the database check fails and caches that answer).
import http from "node:http";
import type { AddressInfo } from "node:net";
// @sentry/node is the server SDK that @sentry/nextjs wraps; importing the Next.js package here would pull Next types into this package.
import * as Sentry from "@sentry/node";
import { createTransport } from "@sentry/core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { scrubEvent, sentryOptions } from "@portal/auth/sentry";
import { GET } from "../../../../apps/candidate/app/api/health/route";

// Measured on 19 Nov 2026: 61 ms for the large event (median of 5); the route 1.05 ms without and 2.05 ms with Sentry, so 1 ms extra. Each budget
// is about 4 to 10 times the measure, for a busy machine.
export const SCRUB_MS = 250;
export const EXTRA_MS = 10;

let server: http.Server;
let base = "";
let traced = false;
const sent: unknown[] = [];

beforeAll(async () => {
  server = http.createServer(async (_req, res) => {
    const run = async () => {
      const reply = await GET();
      res.writeHead(reply.status).end(await reply.text());
    };
    await (traced ? Sentry.startSpan({ name: "GET /api/health", op: "http.server" }, run) : run());
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
async function routeMedian() {
  await fetch(`${base}/api/health`); // warm
  const times: number[] = [];
  for (let i = 0; i < 9; i++) {
    const t = performance.now();
    await (await fetch(`${base}/api/health?token=perf`)).text();
    times.push(performance.now() - t);
  }
  return median(times);
}

it("the scrubbers clean a 1 MB message and 500 breadcrumbs inside the budget", () => {
  const event = {
    message: ("Insert failed for jane@example.com at https://x.example/a?token=t ".repeat(15_000)).slice(0, 1_000_000),
    exception: { values: [{ type: "Error", value: "a".repeat(100_000) + "@" }] },
    breadcrumbs: Array.from({ length: 500 }, (_, i) => ({
      message: `fetch ${i} for user${i}@example.com`,
      data: { url: `https://bucket.s3.eu-west-1.amazonaws.com/f/${i}.pdf?X-Amz-Signature=${i}`, nested: { list: [{ url: `/reset?token=${i}` }] } },
    })),
    request: { url: "https://x.example/reset?token=t", method: "GET", headers: { cookie: "c" } },
  };
  const times: number[] = [];
  let out: typeof event = event;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    out = scrubEvent(event);
    times.push(performance.now() - t);
  }
  const ms = median(times);
  console.log(`scrub large event: ${ms.toFixed(1)} ms (budget ${SCRUB_MS})`);
  expect(JSON.stringify(out)).not.toMatch(/token=|X-Amz|jane@|user\d+@/);
  expect(ms).toBeLessThan(SCRUB_MS);
});

it("Sentry adds less than the budget to one health route call", async () => {
  const without = await routeMedian();
  Sentry.init({
    ...sentryOptions("https://publickey@o1.ingest.de.sentry.io/1", { VERCEL_ENV: "preview" }),
    transport: (o) => createTransport(o, async (req) => {
      sent.push(req.body);
      return { statusCode: 200 };
    }),
  });
  traced = true;
  const withSentry = await routeMedian();
  await Sentry.flush(2000);
  console.log(`health route median of 9: ${without.toFixed(2)} ms without Sentry, ${withSentry.toFixed(2)} ms with (extra budget ${EXTRA_MS})`);
  expect(sent.length).toBeGreaterThan(0); // the traced calls went to the in-memory transport
  expect(withSentry - without).toBeLessThan(EXTRA_MS);
});
