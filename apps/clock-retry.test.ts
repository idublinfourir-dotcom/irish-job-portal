// The rule of vitest.config.ts: only a late wall-clock number is tried again, never any other failure. Messages below are real ones from CI.
import { describe, expect, it } from "vitest";
import config, { CLOCK_RETRY } from "../vitest.config";
import { filesToRerun } from "../test-run";

const { condition } = CLOCK_RETRY;

describe("clock retry", () => {
  it.each([
    "expected 29.53226799999993 to be less than 25",
    "expected 15.125807999999779 to be less than or equal to 15",
    "attachMs: expected 29.571925000000192 to be less than 20",
    "expected 3158.641448 to be less than 3000",
    "expected 101.37 to be less than or equal to 100", // a time of EXPLAIN
    "expected 101.4 to be less than 100",
  ])("tries again: %s", (m) => expect(condition.test(m)).toBe(true));
  it.each([
    "expected 14 to be less than or equal to 13", // a statement or row count
    "expected 'live' to be 'closed' // Object.is equality",
    "promise resolved \"Result{}\" instead of rejecting",
    "expected 0.5 to be greater than 4.5",
    "expected 3.75 to be less than 4.5", // a ratio, not a clock
    "expected 101.37 to be less than 100.5",
    "expected 101.37 to be greater than 100",
    "expected [ 1, 2 ] to deeply equal [ 1 ]",
    "expected 40 to be less than 30",
    "Test timed out in 60000ms.",
    "",
  ])("never: %j", (m) => expect(condition.test(m)).toBe(false));
  // `npm test` runs the failed files once more, alone, when every failure began as a clock number (a seed that cannot run twice fails the in-test tries).
  const LATE = "expected 20.957023999999365 to be less than 20", TAKEN = "a staff login with this email already exists; nothing was written";
  const f = (file: string, tests: string[], outside = 0) => ({ file, outside, tests });
  it.each([
    ["one late file", [f("a", [LATE])], 0, ["a"]],
    ["two late files, one with two late tests", [f("a", [LATE]), f("b", [LATE, `${LATE}\n    at x`])], 0, ["a", "b"]],
    ["nothing failed", [], 0, []],
    ["a wrong answer in the same file", [f("a", [LATE, "expected 1 to be 2"])], 0, []],
    ["a wrong answer in another file", [f("a", [LATE]), f("b", ["expected 'live' to be 'closed'"])], 0, []],
    ["a seed that fails at the first try", [f("a", [TAKEN])], 0, []],
    ["a statement count", [f("a", ["expected 14 to be less than or equal to 13"])], 0, []],
    ["a clock number only on a later line", [f("a", [`refused\n${LATE}`])], 0, []],
    ["a file that did not load, or a set-up step that failed", [f("a", [], 1), f("b", [LATE])], 0, []],
    ["a set-up step that failed beside a late test", [f("a", [LATE], 1)], 0, []],
    ["a failure with no test and no error", [f("a", [])], 0, []],
    ["a failure with no message", [f("a", [""])], 0, []],
    ["an unhandled error beside a late test", [f("a", [LATE])], 1, []],
  ])("files to run again: %s", (_n, failed, unhandled, files) => expect(filesToRerun(failed, unhandled)).toEqual(files));
  it("is set for both projects, two more tries only", () => {
    expect(CLOCK_RETRY.count).toBe(2);
    const projects = (config as { test: { projects: { test: { name: string; retry?: unknown } }[] } }).test.projects;
    expect(projects.map((p) => [p.test.name, p.test.retry])).toEqual([["unit", CLOCK_RETRY], ["db", CLOCK_RETRY]]);
  });
});
