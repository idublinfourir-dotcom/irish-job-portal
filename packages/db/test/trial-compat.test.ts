// TEST-1: the rule() helper itself. A refusal with no expect is refused at registration; a refusal with a different message is not a pass.
import { describe, expect, it } from "vitest";
import { checkSpec, refusedBy } from "./trial-compat";

describe("trial-compat rule()", () => {
  it("a refuse step with no expect throws at registration", () => {
    expect(() => checkSpec("job", "x", { refuse: async () => {} })).toThrow(/needs expect/);
    expect(() => checkSpec("job", "x", { refuse: async () => {}, expect: "" })).toThrow(/needs expect/);
  });
  it("a spec with no refuse step, or with expect, registers", () => {
    expect(() => checkSpec("job", "x", { ok: async () => {} })).not.toThrow();
    expect(() => checkSpec("job", "x", { refuse: async () => {}, expect: "violates check" })).not.toThrow();
  });
  it("a refusal for a different reason does not count (case-insensitive match on the expected text)", () => {
    expect(refusedBy({ expect: "violates check constraint \"job_check\"" }, '23514 new row violates check constraint "job_check"')).toBe(true);
    expect(refusedBy({ expect: "violates check constraint \"job_check\"" }, '42703 column "tittle" does not exist')).toBe(false);
  });
});
