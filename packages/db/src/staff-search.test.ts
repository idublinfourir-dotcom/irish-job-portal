// B58 unit tests: the text check and the LIKE pattern, no database.
import { describe, expect, it } from "vitest";
import { QueueRefused } from "./admin-queue";
import { CASE_SEARCHERS, checkSearchText, COMPANY_SEARCHERS, like, SEARCH_LIMIT, SEARCH_JOBS, SEARCH_ORGANISATIONS, searchStaff } from "./staff-search";

describe("checkSearchText", () => {
  it("trims, and accepts 3 to 100 characters", () => {
    expect(checkSearchText("  abc  ")).toBe("abc");
    expect(checkSearchText("x".repeat(100))).toHaveLength(100);
    expect(checkSearchText("😀😀😀")).toBe("😀😀😀"); // counted in UTF-16 units: three emoji are 6, fine
  });
  it("refuses a short, long, missing, non-text or control-character text with bad_query", () => {
    for (const bad of ["", "ab", "  ab  ", "x".repeat(101), undefined, null, 123, ["abc"], { a: 1 }, "ab\u0000c", "ab\nc", "a\tbc", "abc\u009f"])
      expect(() => checkSearchText(bad), String(bad)).toThrowError(new QueueRefused("bad_query"));
  });
});

describe("like", () => {
  it("escapes % _ and the backslash, and adds the wildcards the place asks for", () => {
    expect(like("a%b_c\\d", "inside")).toBe("%a\\%b\\_c\\\\d%");
    expect(like("700", "start")).toBe("700%");
  });
});

describe("the statements and the roles", () => {
  it("each statement is constant text with parameters and limits itself", () => {
    for (const sql of [SEARCH_ORGANISATIONS, SEARCH_JOBS]) {
      expect(sql).toMatch(new RegExp(`limit ${SEARCH_LIMIT + 1}$`));
      expect(sql).not.toMatch(/select \*|\.\*/);
    }
    expect(SEARCH_JOBS).toContain("status <> 'draft'");
    expect(SEARCH_ORGANISATIONS).toContain("merged_into_id is null");
  });
  it("no role stands in for another: the case searchers are exactly the handler and the administrator, the company searchers exclude the handler and the content editor", () => {
    expect(CASE_SEARCHERS).toEqual(["services_case_handler", "administrator"]);
    expect(COMPANY_SEARCHERS).not.toContain("services_case_handler");
    expect(COMPANY_SEARCHERS).not.toContain("content_editor");
  });
  it("a bad text is refused before any statement runs", async () => {
    const db = { query: async () => { throw new Error("must not run"); } };
    await expect(searchStaff(db as never, "s1", "ab")).rejects.toThrow("bad_query");
  });
});
