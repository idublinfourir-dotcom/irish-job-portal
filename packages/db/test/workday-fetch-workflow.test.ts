// The Workday fetch workflow's shape (W1b; no workflow linter in the repo). It runs on the engineer's laptop through a self-hosted runner, so
// what may start it is the security boundary: only the schedule and a person, never code from a pull request or a push.
import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const dir = new URL("../../../.github/workflows/", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, dir), "utf8");
const yml = read("workday-fetch.yml");
const steps = yml.split(/^ {6}- /m).slice(1);
const step = (name: string) => steps.find((s) => s.startsWith(`name: ${name}`)) ?? "";

it("starts only on its schedule or by hand: no pull_request, pull_request_target, push or other trigger", () => {
  expect(yml.slice(yml.indexOf("\non:"), yml.indexOf("\npermissions:"))).toMatch(/^\non:\n {2}schedule:\n {4}- cron: "17 8 \* \* \*".*\n {2}workflow_dispatch:\n$/);
  const code = yml.replace(/#.*$/gm, ""); // the header comment names the triggers it rules out
  expect(code).not.toMatch(/pull_request|^ {2}push:|workflow_run|repository_dispatch|workflow_call/m);
});
it("runs only on the laptop's runner, with read-only permissions, its own one-at-a-time group and no kept checkout token", () => {
  expect(yml).toMatch(/^ {4}runs-on: \[self-hosted, workday\]$/m);
  expect(yml).toMatch(/^permissions:\n {2}contents: read\n\n/m);
  expect(yml.match(/permissions:/g)).toHaveLength(1);
  expect(yml).toMatch(/group: workday-fetch\n\s+cancel-in-progress: false/);
  expect(yml).toMatch(/actions\/checkout@\w{40} # v[\d.]+\n\s+with:\n\s+persist-credentials: false/);
  expect(yml).toMatch(/^ {4}timeout-minutes: \d+$/m);
});
it("uses only actions pinned to a full commit, the same pins the daily fetch uses", () => {
  const uses = [...yml.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
  expect(uses).toHaveLength(2);
  const daily = read("daily-fetch.yml");
  for (const u of uses) {
    expect(u).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
    expect(daily, u).toContain(u);
  }
});
it("gives the two fetcher secrets to the Fetch step only, as environment values, and no admin, email or file secret at all", () => {
  expect([...new Set([...yml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))].sort()).toEqual(["FETCHER_DATABASE_URL", "FETCHER_MODEL_KEY"]);
  const f = step("Fetch");
  expect(f).toMatch(/FETCHER_DATABASE_URL: \$\{\{ secrets\.FETCHER_DATABASE_URL \}\}\n/);
  expect(f).toMatch(/FETCHER_MODEL_KEY: \$\{\{ secrets\.FETCHER_MODEL_KEY \}\}\n/);
  expect(f.match(/secrets\./g)).toHaveLength(2);
  for (const s of steps) if (s !== f) expect(s, s.slice(0, 40)).not.toMatch(/secrets\./);
  expect(f).not.toMatch(/continue-on-error|if:/); // a red fetch must turn the run red
  const scripts = [...yml.matchAll(/run: \|?\n?([\s\S]*?)(?=\n {6}- |\n*$)/g)].map((m) => m[1]!).join("\n");
  expect(scripts).not.toMatch(/\$\{\{/);
  expect(yml).not.toMatch(/set -\w*x|printenv|ACTIONS_STEP_DEBUG|echo[^\n]*(DATABASE_URL|MODEL_KEY)/);
});
it("fetches Workday only, with 10 model requests, no guard and no admin step", () => {
  const f = step("Fetch");
  expect(f).toMatch(/FETCHER_ONLY_KINDS: workday\n/);
  expect(yml).not.toMatch(/FETCHER_SKIP_KINDS/);
  expect(f).toMatch(/FETCHER_MAX_MODEL_REQUESTS: "10"\n/);
  expect(f).toMatch(/npx vitest run --config packages\/fetcher\/vitest\.run\.config\.ts/);
  expect(steps.map((s) => s.split("\n")[0])).toEqual([expect.stringMatching(/^uses: actions\/checkout@/), expect.stringMatching(/^uses: actions\/setup-node@/), "run: npm ci", "name: Fetch"]);
});
it("its schedule is clear of the other workflows' slots, and no other workflow runs on the laptop", () => {
  const others = readdirSync(dir).filter((f) => f !== "workday-fetch.yml" && f.endsWith(".yml"));
  for (const f of others) {
    expect(read(f), f).not.toMatch(/- cron: "17 8 /);
    expect(read(f), f).not.toMatch(/self-hosted/);
  }
});
