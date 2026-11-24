import { describe, expect, it } from "vitest";
import { standingLine, writtenDate } from "./index";

describe("a date on a page is written out, never ISO", () => {
  it("writes a plain date as day, month and year", () => {
    expect(writtenDate("2026-11-12")).toBe("12 Nov 2026");
    expect(writtenDate("2027-03-01")).toBe("1 Mar 2027");
    expect(writtenDate("2026-12-31")).toBe("31 Dec 2026");
  });
  it("leaves anything that is not a plain date as it is", () => {
    for (const x of ["", "tomorrow", "2026-13-01", "2026-11-12T10:00:00Z", "12 Nov 2026"]) expect(writtenDate(x)).toBe(x);
  });
  it("puts the written date in the standing line", () => {
    expect(standingLine("2026-11-12")).toBe("Our check is guidance, not a permit decision. Only DETE decides. Rules last checked on 12 Nov 2026.");
    expect(standingLine()).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
