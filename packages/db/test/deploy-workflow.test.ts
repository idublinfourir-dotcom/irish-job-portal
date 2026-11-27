// The deploy workflow's shape (no workflow linter in the repo): when it runs, its permissions, that each app's token reaches only the deploy
// step, that it deploys a plain copy (no .git, so Vercel Hobby does not block it by the commit's author) and that a missing token skips the app.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const yml = readFileSync(new URL("../../../.github/workflows/deploy.yml", import.meta.url), "utf8");
const step = yml.split(/^ {6}- /m).find((s) => s.startsWith("name: Deploy the three apps")) ?? "";
const PROJECTS = { admin: "prj_d4UD3QwfTfojpF7tFp1KZtYdGmP1", candidate: "prj_ihOGwSmteseWB7oWfpFkMk4QD5Ut", portal: "prj_cba6rpOgoMrlynCFTz7Y5QUPWtd8" };

it("runs on a push to main and by hand, never on a pull request", () => {
  expect(yml).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
  expect(yml).toMatch(/^ {2}workflow_dispatch:$/m);
  expect(yml.slice(yml.indexOf("\non:"), yml.indexOf("\npermissions:"))).toBe("\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\n");
});
it("keeps read-only permissions, one deploy at a time, and does not keep the checkout's credentials", () => {
  expect(yml).toMatch(/^permissions:\n {2}contents: read$/m);
  expect(yml).toMatch(/group: deploy\n\s+cancel-in-progress: false/);
  expect(yml).toMatch(/persist-credentials: false/);
});
it("gives the three tokens to the deploy step only, and the read-only backup login to the schema check only (DEP-5)", () => {
  expect([...yml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]).sort()).toEqual(["BACKUP_DATABASE_URL", "VERCEL_TOKEN_ADMIN", "VERCEL_TOKEN_CANDIDATE", "VERCEL_TOKEN_PORTAL"]);
  expect(step.match(/secrets\./g)).toHaveLength(3);
  expect(step).not.toMatch(/BACKUP_DATABASE_URL/);
  const schema = yml.split(/^ {6}- /m).find((s) => s.startsWith("name: Check the live schema matches the code")) ?? "";
  expect(schema.match(/secrets\.(\w+)/g)).toEqual(["secrets.BACKUP_DATABASE_URL"]);
  expect(yml.indexOf("name: Check the live schema matches the code")).toBeLessThan(yml.indexOf("name: Deploy the three apps"));
});
it("deploys each app to its own project, from a plain copy, with a pinned CLI", () => {
  for (const [app, id] of Object.entries(PROJECTS)) expect(step).toMatch(new RegExp(`^ +deploy ${app} ${id} "\\$TOKEN_${app.toUpperCase()}"$`, "m"));
  expect(step).toMatch(/git archive HEAD \| tar -x -C "\$copy"/);
  expect(step).toMatch(/npx -y vercel@65\.14\.0 deploy --prod --yes/);
  expect(step).not.toMatch(/--token/); // the token goes in VERCEL_TOKEN, never on the command line
  // GET /api shows the deployed commit (#265); the build gets it too, so the browser bundle and the source maps carry the same Sentry release (#267)
  expect(step).toMatch(/deploy --prod --yes --env APP_VERSION="\$\{GITHUB_SHA::7\}" --build-env APP_VERSION="\$\{GITHUB_SHA::7\}"\)/);
});
it("skips an app whose token is not set, and fails the run when any deploy fails", () => {
  expect(step).toMatch(/if \[ -z "\$3" \]; then echo "\$1: its token secret is not set: skipped"; return 0; fi/);
  expect(step).toMatch(/\|\| \{ echo "\$1: deploy FAILED"; failed=1; \}/);
  expect(step).toMatch(/exit "\$failed"/);
});
