// The rule of vitest.config.ts: only a late wall-clock number is tried again, never any other failure. Messages below are real ones from CI.
import { describe, expect, it } from "vitest";
import config, { CLOCK_RETRY } from "../vitest.config";

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
  it("is set for both projects, two more tries only", () => {
    expect(CLOCK_RETRY.count).toBe(2);
    const projects = (config as { test: { projects: { test: { name: string; retry?: unknown } }[] } }).test.projects;
    expect(projects.map((p) => [p.test.name, p.test.retry])).toEqual([["unit", CLOCK_RETRY], ["db", CLOCK_RETRY]]);
  });
});
