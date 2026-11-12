// The daily fetch workflow's shape (no workflow linter in the repo): both cron slots, the guard's condition, and that the later steps depend on it.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const yml = readFileSync(new URL("../../../.github/workflows/daily-fetch.yml", import.meta.url), "utf8");
const step = (name: string) => yml.split(/^ {6}- /m).find((s) => s.startsWith(`name: ${name}`) || s.startsWith(`uses: ${name}`)) ?? "";

it("has the first slot and the backup slot", () => {
  expect([...yml.matchAll(/^\s*- cron: "([^"]+)"/gm)].map((m) => m[1])).toEqual(["17 5 * * *", "2 6 * * *"]);
});
it("the guard runs for scheduled runs only, as the fetcher login, and only reads", () => {
  const g = step("Already fetched today?");
  expect(g).toMatch(/id: guard/);
  expect(g).toMatch(/if: \$\{\{ github\.event_name == 'schedule' \}\}/);
  expect(g).toMatch(/FETCHER_DATABASE_URL: \$\{\{ secrets\.FETCHER_DATABASE_URL \}\}/);
  expect(g).toMatch(/node packages\/db\/src\/fetch-guard-cli\.ts/);
  expect(g).not.toMatch(/continue-on-error/); // a guard failure must fail the run
  expect(yml.indexOf("Already fetched today?")).toBeGreaterThan(yml.indexOf("run: npm ci"));
  expect(yml.indexOf("Already fetched today?")).toBeLessThan(yml.indexOf("name: Fetch\n"));
});
it("the Fetch and Refresh steps both wait for the guard", () => {
  expect(step("Fetch")).toMatch(/if: \$\{\{ steps\.guard\.outputs\.skip != 'true' \}\}/);
  const r = step("Refresh permit history labels");
  expect(r).toMatch(/steps\.guard\.outputs\.skip != 'true'/);
  expect(r).toMatch(/steps\.guard\.outcome != 'failure'/); // it runs after a failed fetch, but not after a failed guard
});
it("keeps read-only permissions, the one-at-a-time group, and adds no secret", () => {
  expect(yml).toMatch(/^permissions:\n {2}contents: read$/m);
  expect(yml).toMatch(/group: daily-fetch\n\s+cancel-in-progress: false/);
  expect([...new Set([...yml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))].sort()).toEqual(["ADMIN_DATABASE_URL", "FETCHER_DATABASE_URL", "FETCHER_MODEL_KEY"]);
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
  expect(yml.trimEnd().endsWith("node packages/db/src/rules-run-cli.ts")).toBe(true);
});
