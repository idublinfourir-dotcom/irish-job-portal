// Unit test for the page counter's adding-up, on a canned EXPLAIN result. No database.
import { describe, expect, it } from "vitest";
import { assertPageBudget, costOf, pageOver } from "./pages";

const canned = [
  {
    Plan: {
      "Node Type": "Limit", "Shared Hit Blocks": 10, "Shared Read Blocks": 2,
      Plans: [{ "Node Type": "Index Only Scan", "Index Name": "job_live_newest", "Shared Hit Blocks": 8, "Shared Read Blocks": 2 }, { "Node Type": "CTE Scan" }],
    },
    Planning: { "Shared Hit Blocks": 13, "Shared Read Blocks": 4 },
    Serialization: { Time: 0.5, "Shared Hit Blocks": 3, "Shared Read Blocks": 1 },
    "Execution Time": 1.25,
  },
];

describe("page counter", () => {
  it("adds hit and read blocks of planning, execution and serialisation", () => {
    const c = costOf("select 1", canned);
    expect(c).toMatchObject({ planning: 17, execution: 12, serialisation: 4, pages: 33, ms: 1.75, scans: "job_live_newest+CTE Scan" });
  });

  it("counts a plan with no planning or serialisation block as zero for them", () => {
    const c = costOf("select 1", [{ Plan: { "Node Type": "Result", "Shared Hit Blocks": 5 }, "Execution Time": 0.1 }]);
    expect(c).toMatchObject({ planning: 0, serialisation: 0, pages: 5, scans: "" });
  });

  it("sums the statements of one page and names the worst one when over budget", () => {
    const a = costOf("select a", canned);
    const b = { ...costOf("select b", canned), pages: 900, execution: 900 - 17 };
    expect(pageOver("home", [a, a], 66)).toBeUndefined();
    expect(pageOver("home", [a, b], 933)).toBeUndefined();
    const message = pageOver("home", [a, b], 932)!;
    expect(message).toContain('page "home" touched 933 pages, budget 932');
    expect(message).toContain("select b");
    expect(() => assertPageBudget("home", [a, b], 932)).toThrow(/touched 933 pages/);
    expect(() => assertPageBudget("home", [a, b], 933)).not.toThrow();
  });
});
