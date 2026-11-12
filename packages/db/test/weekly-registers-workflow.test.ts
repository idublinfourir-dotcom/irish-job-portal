// The weekly registers workflow's shape (no workflow linter in the repo): cron, permissions, secret scoping, and that the WRC step still runs after a CRO failure.
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const yml = readFileSync(new URL("../../../.github/workflows/weekly-registers.yml", import.meta.url), "utf8");
const step = (name: string) => yml.split(/^ {6}- /m).find((s) => s.startsWith(`name: ${name}`)) ?? "";
const cro = step("Import CRO companies");
const wrc = step("Import WRC agency list");

it("runs weekly on Sunday and by hand", () => {
  expect([...yml.matchAll(/^\s*- cron: "([^"]+)"/gm)].map((m) => m[1])).toEqual(["23 3 * * 0"]);
  expect(yml).toMatch(/^ {2}workflow_dispatch:/m);
});
it("keeps read-only permissions and the one-at-a-time group", () => {
  expect(yml).toMatch(/^permissions:\n {2}contents: read$/m);
  expect(yml).toMatch(/group: weekly-registers\n\s+cancel-in-progress: false/);
});
it("uses only the two existing secrets, each in its own step", () => {
  expect([...new Set([...yml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))].sort()).toEqual(["ADMIN_DATABASE_URL", "FETCHER_DATABASE_URL"]);
  expect(cro).toMatch(/FETCHER_DATABASE_URL: \$\{\{ secrets\.FETCHER_DATABASE_URL \}\}/);
  expect(cro).not.toMatch(/ADMIN_DATABASE_URL/);
  expect(wrc).toMatch(/WRC_ADMIN_DATABASE_URL: \$\{\{ secrets\.ADMIN_DATABASE_URL \}\}/);
  expect(wrc).not.toMatch(/FETCHER_DATABASE_URL/);
  expect(yml.match(/secrets\./g)).toHaveLength(2);
});
it("the WRC steps run even when the CRO step failed", () => {
  expect(wrc).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/);
  expect(step("Install pdftotext")).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/);
  expect(yml.indexOf("Import WRC agency list")).toBeGreaterThan(yml.indexOf("Import CRO companies"));
});
it("calls the registers CLI, which exists", () => {
  expect(cro).toMatch(/node packages\/db\/src\/registers-cli\.ts cro/);
  expect(wrc).toMatch(/node packages\/db\/src\/registers-cli\.ts wrc/);
  expect(existsSync(new URL("../src/registers-cli.ts", import.meta.url))).toBe(true);
});
