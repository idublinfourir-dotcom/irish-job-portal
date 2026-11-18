// The fetch watch workflow's shape (no workflow linter in the repo): two late slots, permissions, the one secret in its one step.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const yml = readFileSync(new URL("../../../.github/workflows/fetch-watch.yml", import.meta.url), "utf8");
const step = (name: string) => yml.split(/^ {6}- /m).find((s) => s.startsWith(`name: ${name}`)) ?? "";

it("runs twice late in the day and by hand", () => {
  expect([...yml.matchAll(/^\s*- cron: "([^"]+)"/gm)].map((m) => m[1])).toEqual(["11 12 * * *", "41 17 * * *"]);
  expect(yml).toMatch(/^ {2}workflow_dispatch:/m);
});
it("has read contents, write actions (to start the run), nothing else, and a one-at-a-time group", () => {
  expect(yml).toMatch(/^permissions:\n {2}contents: read\n {2}actions: write\n/m);
  expect(yml).toMatch(/group: fetch-watch\n\s+cancel-in-progress: false/);
});
it("uses only the fetcher login, in the check step, plus the job's own token", () => {
  expect([...new Set([...yml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))]).toEqual(["FETCHER_DATABASE_URL"]);
  const s = step("Check today's fetch");
  expect(s).toMatch(/FETCHER_DATABASE_URL: \$\{\{ secrets\.FETCHER_DATABASE_URL \}\}/);
  expect(s).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
  expect(s).toMatch(/node packages\/db\/src\/fetch-watch-cli\.ts/);
  expect(s).not.toMatch(/continue-on-error/); // red is the whole point
  expect(yml.match(/secrets\./g)).toHaveLength(1);
});
it("the watch's cron lines do not collide with the daily fetch's own slots", () => {
  const daily = readFileSync(new URL("../../../.github/workflows/daily-fetch.yml", import.meta.url), "utf8");
  expect(daily).not.toMatch(/- cron: "(11 12|41 17) /);
});
it("leaves the Workday boards, fetched on the laptop, out of its questions (W1b)", () => {
  expect(step("Check today's fetch")).toMatch(/\n {10}FETCHER_SKIP_KINDS: workday\n/);
});
