// The daily fetch workflow's shape (no workflow linter in the repo): both cron slots, the guard's condition, and that the later steps depend on it.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const yml = readFileSync(new URL("../../../.github/workflows/daily-fetch.yml", import.meta.url), "utf8");
const step = (name: string) => yml.split(/^ {6}- /m).find((s) => s.startsWith(`name: ${name}`) || s.startsWith(`uses: ${name}`)) ?? "";

it("has the first slot and the backup slot", () => {
  expect([...yml.matchAll(/^\s*- cron: "([^"]+)"/gm)].map((m) => m[1])).toEqual(["17 5 * * *", "2 6 * * *"]);
});
it("the guard runs for scheduled runs and for runs started with guarded=true (the fetch watch), as the fetcher login, and only reads", () => {
  const g = step("Already fetched today?");
  expect(g).toMatch(/id: guard/);
  expect(g).toMatch(/if: \$\{\{ github\.event_name == 'schedule' \|\| inputs\.guarded \}\}/);
  expect(g).toMatch(/FETCHER_DATABASE_URL: \$\{\{ secrets\.FETCHER_DATABASE_URL \}\}/);
  expect(g).toMatch(/node packages\/db\/src\/fetch-guard-cli\.ts/);
  expect(g).not.toMatch(/continue-on-error/); // a guard failure must fail the run
  expect(yml.indexOf("Already fetched today?")).toBeGreaterThan(yml.indexOf("run: npm ci"));
  expect(yml.indexOf("Already fetched today?")).toBeLessThan(yml.indexOf("name: Fetch\n"));
});
it("the guarded input exists, is a boolean, and is off by default so a run started by a person always fetches", () => {
  expect(yml).toMatch(/workflow_dispatch:\n {4}inputs:\n(?: {6}#.*\n)? {6}guarded:\n {8}description: .*\n {8}type: boolean\n {8}default: false/);
});
it("the Fetch and Refresh steps both wait for the guard", () => {
  expect(step("Fetch")).toMatch(/if: \$\{\{ steps\.guard\.outputs\.skip != 'true' \}\}/);
  const r = step("Refresh permit history labels");
  expect(r).toMatch(/steps\.guard\.outputs\.skip != 'true'/);
  expect(r).toMatch(/steps\.guard\.outcome != 'failure'/); // it runs after a failed fetch, but not after a failed guard
});
it("keeps read-only permissions, the one-at-a-time group, and only the known secrets", () => {
  expect(yml).toMatch(/^permissions:\n {2}contents: read$/m);
  expect(yml).toMatch(/group: daily-fetch\n\s+cancel-in-progress: false/);
  expect([...new Set([...yml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))].sort()).toEqual(["ADMIN_DATABASE_URL", "BREVO_API_KEY", "FETCHER_DATABASE_URL", "FETCHER_MODEL_KEY", "FILES_S3_KEY_ID", "FILES_S3_SECRET"]);
});
it("closes expired employer jobs every day, with the admin login only in that step (0019)", () => {
  const s = step("Close expired employer jobs");
  expect(s).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/);
  expect(s).toMatch(/EXPIRY_ADMIN_DATABASE_URL: \$\{\{ secrets\.ADMIN_DATABASE_URL \}\}/);
  expect(s).toMatch(/node packages\/db\/src\/job-expiry-cli\.ts/);
});
it("applies a new minimum last, after the expiry step, every day, with the admin login only in that step (0021)", () => {
  const s = step("Apply a new minimum");
  expect(s).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/);
  expect(s).toMatch(/RULES_ADMIN_DATABASE_URL: \$\{\{ secrets\.ADMIN_DATABASE_URL \}\}/);
  expect(yml.indexOf("name: Apply a new minimum")).toBeGreaterThan(yml.indexOf("name: Close expired employer jobs"));
  expect(yml.indexOf("name: Apply the retention rules")).toBeGreaterThan(yml.indexOf("name: Apply a new minimum"));
});
it("applies the retention rules last, every day, with the admin login only in that step", () => {
  const s = step("Apply the retention rules");
  expect(s).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/);
  expect(s).toMatch(/RETENTION_ADMIN_DATABASE_URL: \$\{\{ secrets\.ADMIN_DATABASE_URL \}\}/);
  expect(s).not.toMatch(/FETCHER_/);
  expect(yml.trimEnd().endsWith("node packages/db/src/retention-cli.ts")).toBe(true);
  // the S3 files key reaches this step only: bucket and region are plain values
  expect(s).toMatch(/FILES_S3_KEY_ID: \$\{\{ secrets\.FILES_S3_KEY_ID \}\}\n {10}FILES_S3_SECRET: \$\{\{ secrets\.FILES_S3_SECRET \}\}\n {10}FILES_S3_BUCKET: irish-job-portal-files\n {10}FILES_S3_REGION: eu-west-1\n/);
  expect(yml.match(/^ +FILES_S3_\w+:/gm)).toHaveLength(4); // set on no other step
  expect(yml.match(/secrets\.ADMIN_DATABASE_URL/g)).toHaveLength(6); // refresh, expiry, minimum, alerts, outbox, retention: one step each
});
it("queues job alerts every day, after the fetch and the minimum and before retention, with the admin login only in that step (0024)", () => {
  const s = step("Queue job alerts");
  expect(s).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/);
  expect(s).toMatch(/ALERTS_ADMIN_DATABASE_URL: \$\{\{ secrets\.ADMIN_DATABASE_URL \}\}/);
  expect(s).toMatch(/node packages\/db\/src\/alerts-run-cli\.ts/);
  expect(s).not.toMatch(/FETCHER_/);
  expect(yml.indexOf("name: Queue job alerts")).toBeGreaterThan(yml.indexOf("name: Fetch\n"));
  expect(yml.indexOf("name: Queue job alerts")).toBeGreaterThan(yml.indexOf("name: Apply a new minimum"));
  expect(yml.indexOf("name: Apply the retention rules")).toBeGreaterThan(yml.indexOf("name: Queue job alerts"));
});
it("sends the queued emails every day after the alerts are queued and before retention, and does nothing while email is off (8.1b)", () => {
  const s = step("Send queued emails");
  expect(s).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/);
  expect(s).toMatch(/DATABASE_URL: \$\{\{ secrets\.ADMIN_DATABASE_URL \}\}/);
  expect(s).toMatch(/BREVO_API_KEY: \$\{\{ secrets\.BREVO_API_KEY \}\}/);
  expect(s).toMatch(/EMAIL_FROM: \$\{\{ vars\.EMAIL_FROM \}\}/);
  expect(s).toMatch(/SITE_URL: \$\{\{ vars\.SITE_URL \}\}/);
  expect(s).toMatch(/if \[ -z "\$BREVO_API_KEY" \]; then echo "email is off \(no BREVO_API_KEY secret\): nothing sent"; exit 0; fi/);
  expect(s).toMatch(/node packages\/db\/src\/outbox-cli\.ts --batch 200$/m);
  expect(s).not.toMatch(/FETCHER_/);
  expect(yml.match(/secrets\.BREVO_API_KEY/g)).toHaveLength(1);
  expect(yml.indexOf("name: Send queued emails")).toBeGreaterThan(yml.indexOf("name: Queue job alerts"));
  expect(yml.indexOf("name: Apply the retention rules")).toBeGreaterThan(yml.indexOf("name: Send queued emails"));
});
// W1b: Workday is fetched on the laptop (workday-fetch.yml), so this run and its guard leave it out, and its model budget shrinks to make room.
it("no longer fetches Workday: the Fetch step and the guard skip it, and the model budget is 30 of the key's 50 a day", () => {
  expect(step("Fetch")).toMatch(/\n {10}FETCHER_SKIP_KINDS: workday\n/);
  expect(step("Already fetched today?")).toMatch(/\n {10}FETCHER_SKIP_KINDS: workday\n/);
  expect(yml.match(/FETCHER_SKIP_KINDS/g)).toHaveLength(2); // nothing else changes
  expect(yml).not.toMatch(/FETCHER_ONLY_KINDS/);
  expect(step("Fetch")).toMatch(/FETCHER_MAX_MODEL_REQUESTS: "30"\n/);
  expect(yml).not.toMatch(/self-hosted/);
});
