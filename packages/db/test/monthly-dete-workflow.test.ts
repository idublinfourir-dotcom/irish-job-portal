// The monthly DETE workflow's shape (no workflow linter in the repo): schedule, permissions, and the admin login only in the import step.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const yml = readFileSync(new URL("../../../.github/workflows/monthly-dete.yml", import.meta.url), "utf8");
const step = (name: string) => yml.split(/^ {6}- /m).find((s) => s.startsWith(`name: ${name}`)) ?? "";

it("runs once a month on the 15th at about 07:00 UTC, and by hand", () => {
  expect([...yml.matchAll(/^\s*- cron: "([^"]+)"/gm)].map((m) => m[1])).toEqual(["17 7 15 * *"]);
  expect(yml).toMatch(/^ {2}workflow_dispatch:$/m);
});
it("has read-only permissions and one run at a time", () => {
  expect(yml).toMatch(/^permissions:\n {2}contents: read$/m);
  expect(yml).toMatch(/group: monthly-dete\n\s+cancel-in-progress: false/);
});
it("gives the admin secret to the import step only, under the name the command reads", () => {
  expect([...yml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1])).toEqual(["ADMIN_DATABASE_URL"]);
  const s = step("Import the DETE company file");
  expect(s).toMatch(/DETE_ADMIN_DATABASE_URL: \$\{\{ secrets\.ADMIN_DATABASE_URL \}\}/);
  expect(s).toMatch(/node packages\/db\/src\/dete-monthly-cli\.ts/);
  expect(s).not.toMatch(/continue-on-error|if:/); // a failure must turn the run red
  expect(yml.indexOf("Import the DETE company file")).toBeGreaterThan(yml.indexOf("run: npm ci"));
});
it("has no other step that could see the secret, and no write token", () => {
  expect(yml.replace(step("Import the DETE company file"), "")).not.toMatch(/secrets\./);
  expect(yml).not.toMatch(/contents: write|actions: write|pull-requests: write/);
});
