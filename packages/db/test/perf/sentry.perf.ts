// Performance: the Sentry scrubbers (decision #267) on a large error event. No SDK, no network, no database rows. The extra time Sentry adds to
// a route call is measured with the real @sentry/nextjs init in apps/sentry.test.ts.
import { expect, it } from "vitest";
import { scrubEvent } from "@portal/auth/sentry";

// Measured on 19 Nov 2026: 37 ms (median of 5; 59 to 61 ms before the email search started from the @). The budget is about 4 times the measure.
export const SCRUB_MS = 150;

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
  const ms = [...times].sort((a, b) => a - b)[2] as number;
  console.log(`scrub large event: ${ms.toFixed(1)} ms (budget ${SCRUB_MS})`);
  expect(JSON.stringify(out)).not.toMatch(/token=|X-Amz|jane@|user\d+@/);
  expect(ms).toBeLessThan(SCRUB_MS);
});
