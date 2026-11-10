import { describe, expect, it } from "vitest";
import { summarize } from "./summary.mjs";

// Unit test: no database. A canned results file (as parsed lines) goes in, the table comes out.
describe("mutation summary", () => {
  const rows = [
    { kind: "baseline", result: "passed", failed: 0 },
    { class: "A", id: "A:job_guard", object: "trigger job_guard on job", sql: "drop trigger job_guard on job", result: "caught", failed: 3 },
    { class: "A", id: "A:t2", object: "trigger t2 on x", sql: "drop trigger t2 on x", result: "survived", failed: 0 },
    { class: "B", id: "B:c1", object: "check c1 on x", sql: "alter table x drop constraint c1", result: "error", failed: 0 },
    { class: "C", id: "C:u1", object: "unique u1 on x", sql: "", result: "skipped", failed: 0 },
  ];

  it("counts each class and ignores the baseline line", () => {
    const out = summarize(rows).split("\n");
    expect(out).toContain("A | 2 | 1 | 1 | 0 | 0");
    expect(out).toContain("B | 1 | 0 | 0 | 0 | 1");
    expect(out).toContain("C | 0 | 0 | 0 | 1 | 0");
  });

  it("lists only survivors, with the SQL that was run", () => {
    const out = summarize(rows);
    expect(out).toContain("A | trigger t2 on x | drop trigger t2 on x");
    expect(out).not.toContain("job_guard | ");
    expect(out.split("survivors:")[1]).not.toContain("job_guard");
  });
});
