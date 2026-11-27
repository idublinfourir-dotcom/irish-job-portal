// The outbox workflow's shape (no workflow linter in the repo): started only by a call (the database's own scheduler, scheduler-setup-cli.ts),
// read-only permissions, pinned actions, its secrets on the one step that sends, and the same command as the daily fetch's fallback step.
import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const dir = new URL("../../../.github/workflows/", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, dir), "utf8");
const yml = read("outbox.yml");
const steps = (text: string) => text.split(/^ {6}- /m).slice(1);
const send = (text: string) => steps(text).find((s) => s.startsWith("name: Send queued emails")) ?? "";

it("starts only when called: no schedule (GitHub's is late and drops runs), no push, no pull request", () => {
  expect(yml.slice(yml.indexOf("\non:"), yml.indexOf("\npermissions:"))).toBe("\non:\n  workflow_dispatch:\n");
  expect(yml).not.toMatch(/^\s+schedule:|^\s+- cron:|pull_request|^ {2}push:|workflow_run|repository_dispatch|^\s+inputs:/m);
});
it("has read-only permissions, one run at a time without cancelling, a timeout, and keeps no checkout credentials", () => {
  expect(yml).toMatch(/^permissions:\n {2}contents: read\n\n/m);
  expect(yml).toMatch(/group: outbox\n\s+cancel-in-progress: false/);
  expect(yml).toMatch(/^ {4}timeout-minutes: 10$/m);
  expect(yml).toMatch(/actions\/checkout@\w{40} # v[\d.]+\n\s+with:\n\s+persist-credentials: false/);
});
it("pins every action to a full commit, the same pins the other workflows use", () => {
  const uses = [...yml.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
  expect(uses.length).toBeGreaterThan(1);
  const others = readdirSync(dir).filter((f) => f !== "outbox.yml" && f.endsWith(".yml")).map(read).join("\n");
  for (const u of uses) { expect(u).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/); expect(others, u).toContain(u); }
});
it("gives the admin login and the Brevo key to the sending step only, as environment values never put in a script", () => {
  const s = send(yml);
  expect([...new Set([...yml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))].sort()).toEqual(["ADMIN_DATABASE_URL", "BREVO_API_KEY"]);
  expect(s.match(/secrets\./g)).toHaveLength(2);
  for (const other of steps(yml).filter((x) => x !== s)) expect(other).not.toMatch(/secrets\./);
  expect(s).not.toMatch(/continue-on-error|if:/); // a failure must turn the run red
  expect(s.slice(s.indexOf("run: |"))).not.toMatch(/\$\{\{/);
  expect(yml).not.toMatch(/set -\w*x|set -o xtrace|--debug|ACTIONS_STEP_DEBUG|printenv|echo[^\n]*\$\{?(DATABASE_URL|BREVO_API_KEY)/); // the off message names the secret, it never prints a value
});
it("sends with the same command, values and off switch as the daily fetch's own step, which stays as the fallback", () => {
  const daily = send(read("daily-fetch.yml"));
  expect(daily).not.toBe("");
  const body = (s: string) => s.slice(s.indexOf("env:")).replace(/^\s*#.*\n/gm, "").trim();
  expect(body(send(yml))).toBe(body(daily).replace(/^if: .*\n\s*/m, ""));
  expect(send(yml)).toMatch(/node packages\/db\/src\/outbox-cli\.ts --batch 200$/m);
});
