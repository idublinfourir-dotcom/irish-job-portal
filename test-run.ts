// `npm test`: the suite, then, when every failure is a late wall-clock number (the rule of vitest.config.ts), the failed files once more on their own. The in-test
// retry cannot help a timing test that seeds fixed rows (48 tests cannot run twice, counted 25 Nov 2026), but every file makes its own database, so a whole file can.
// One failure of any other kind, a file or a set-up step that failed, or an unhandled error: nothing is tried again. A test that is really too slow fails alone too.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Reporter, TestModule } from "vitest/node";
import { CLOCK_RETRY } from "./vitest.config.ts";

/** One file that did not pass: the errors outside its tests (loading, beforeAll), and the FIRST message of each failed test (the first try). */
export type FailedFile = { file: string; outside: number; tests: string[] };

/** The files to run again: all that failed, if every failure is a clock number; else none. */
export const filesToRerun = (failed: readonly FailedFile[], unhandled: number): string[] =>
  unhandled === 0 && failed.every((f) => f.outside === 0 && f.tests.length > 0 && f.tests.every((m) => CLOCK_RETRY.condition.test(m.split("\n")[0]!))) ? failed.map((f) => f.file) : [];

/** Vitest loads this file as a reporter (below) and gets the class: it writes the files to run again, one a line, where TEST_RERUN_FILE says. */
export default class ClockReporter implements Reporter {
  onTestRunEnd(modules: readonly TestModule[], unhandled: readonly unknown[]) {
    const failed = modules.filter((m) => !m.ok()).map((m) => ({
      file: m.moduleId,
      outside: m.errors().length + [...m.children.allSuites()].reduce((n, s) => n + s.errors().length, 0),
      tests: [...m.children.allTests("failed")].map((t) => t.result().errors?.[0]?.message ?? ""),
    }));
    if (process.env.TEST_RERUN_FILE) writeFileSync(process.env.TEST_RERUN_FILE, filesToRerun(failed, unhandled.length).join("\n"));
  }
}

if (import.meta.main) {
  const dir = mkdtempSync(join(tmpdir(), "test-run-"));
  const list = join(dir, "files");
  const vitest = (args: string[]) => spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...args], { stdio: "inherit", env: { ...process.env, TEST_RERUN_FILE: list } }).status ?? 1;
  let code: number;
  try {
    const ci = process.env.GITHUB_ACTIONS ? ["--reporter=github-actions"] : [];
    // TL1: on the laptop, half the cores (6 of 12; Vitest's own default is all but one), so the timing budgets are not read under a load of 20. CI keeps its default.
    const cap = process.env.GITHUB_ACTIONS || process.argv.some((a) => a.startsWith("--maxWorkers")) ? [] : ["--maxWorkers=50%"];
    code = vitest([...process.argv.slice(2), ...cap, "--reporter=default", ...ci, "--reporter=./test-run.ts"]);
    const files = code !== 0 && existsSync(list) ? readFileSync(list, "utf8").split("\n").filter(Boolean) : [];
    if (files.length) {
      console.log(`\nOnly wall-clock numbers were late, in ${files.length} file(s). Once more, on their own:\n${files.join("\n")}`);
      code = vitest([...files, "--maxWorkers=2"]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(code);
}
