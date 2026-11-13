// The alert run command without a database: the usage and setting checks stop before any connection, and queueAlerts sends one statement
// with the run time (or null for the database's now()).
import { expect, it } from "vitest";
import { main, queueAlerts } from "./alerts-run-cli.ts";

it("refuses arguments and a missing login before connecting", async () => {
  const lines: string[] = [];
  expect(await main(["--now", "2026-11-16"], { ALERTS_ADMIN_DATABASE_URL: "postgres://x@127.0.0.1:1/x" }, (l) => lines.push(l))).toBe(2);
  expect(await main([], {}, (l) => lines.push(l))).toBe(2);
  expect(lines).toEqual(["usage: alerts-run-cli.ts (no arguments)", "ALERTS_ADMIN_DATABASE_URL is not set (the app_admin login)"]);
});

it("one statement, with the run time passed through", async () => {
  const calls: unknown[][] = [];
  const r = { alerts_due: 2, candidates_queued: 1, rows_written: 1 };
  const db = { query: async (...a: unknown[]) => (calls.push(a), { rows: [{ r }] }) } as never;
  const at = new Date("2026-11-16T06:00:00Z");
  expect(await queueAlerts(db, at)).toEqual(r);
  await queueAlerts(db);
  expect(calls).toEqual([
    ["select private.queue_job_alerts(coalesce($1::timestamptz, now())) r", [at]],
    ["select private.queue_job_alerts(coalesce($1::timestamptz, now())) r", [null]],
  ]);
});
