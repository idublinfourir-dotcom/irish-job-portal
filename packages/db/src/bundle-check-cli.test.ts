// The client bundle check (bundle-check-cli.ts) on made-up bundle files, and its place in check.yml: after the build, with a fake token set.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { leaks } from "./bundle-check-cli";

const dir = mkdtempSync(path.join(tmpdir(), "bundle-check-"));
afterAll(() => rmSync(dir, { recursive: true }));
const bundle = (name: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), text);
};

describe("leaks", () => {
  it("passes a bundle with Sentry tracing and the SDK's envelope type names only", () => {
    bundle("chunks/ok.js", 'new BrowserTracing();var m={replay_event:"replay",replay_recording:"replay"};');
    bundle("chunks/ok.css", "rrweb fake-token-for-test"); // not a script: not read
    expect(leaks(dir, "fake-token-for-test")).toEqual([]);
  });

  it("names each file with Replay code, the token's name or its value, without printing the value", () => {
    bundle("chunks/a.js", 'import "rrweb";');
    bundle("chunks/deep/b.js", 'e={name:"Replay"};');
    bundle("chunks/c.js", 'process.env.SENTRY_AUTH_TOKEN;t="fake-token-for-test"');
    const found = leaks(dir, "fake-token-for-test");
    expect(found.sort()).toEqual([
      "chunks/a.js: Session Replay code",
      "chunks/c.js: the SENTRY_AUTH_TOKEN value",
      "chunks/c.js: the name SENTRY_AUTH_TOKEN",
      "chunks/deep/b.js: Session Replay code",
    ]);
    expect(leaks(dir).some((l) => l.includes("value"))).toBe(false); // no token set: only the name and Replay are checked
  });

  it("throws when the build is missing, so the step fails", () => {
    expect(() => leaks(path.join(dir, "nope"))).toThrow();
  });
});

describe("check.yml", () => {
  const yml = readFileSync(new URL("../../../.github/workflows/check.yml", import.meta.url), "utf8");
  const job = yml.slice(0, yml.indexOf("\n  perf:"));
  const steps = job.split(/^ {6}- /m).slice(1);
  it("builds with a fake token pointed at a closed local port, then runs the bundle check with the same token", () => {
    const build = steps.find((s) => s.startsWith("run: npm run check")) ?? "";
    const check = steps.find((s) => s.startsWith("run: node packages/db/src/bundle-check-cli.ts")) ?? "";
    expect(build).toMatch(/SENTRY_AUTH_TOKEN: fake-token-for-ci\n {10}SENTRY_URL: http:\/\/127\.0\.0\.1:9/);
    expect(check).toMatch(/SENTRY_AUTH_TOKEN: fake-token-for-ci/);
    expect(steps.indexOf(check)).toBe(steps.indexOf(build) + 1);
    expect(job).not.toMatch(/secrets\./);
  });
});
