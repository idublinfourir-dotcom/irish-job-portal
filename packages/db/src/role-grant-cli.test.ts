// No database: the role grant command's input checks. The end-to-end run is packages/db/test/role-grant.test.ts.
import { describe, expect, it } from "vitest";
import { main, parseGrantArgs } from "./role-grant-cli.ts";

describe("role grant command input checks", () => {
  it("takes three plain emails and a known role, trimmed and lowercased", () => {
    expect(parseGrantArgs([" A@Example.test ", "b@example.test", "c@example.test", " trust_and_safety "]).input).toEqual({
      proposer: "a@example.test", confirmer: "b@example.test", staff: "c@example.test", role: "trust_and_safety",
    });
  });
  it("refuses the wrong number of arguments", () => {
    for (const argv of [[], ["a@x.test"], ["a@x.test", "b@x.test", "c@x.test"], ["a@x.test", "b@x.test", "c@x.test", "administrator", "x"]])
      expect(parseGrantArgs(argv).error, argv.join(" ")).toMatch(/usage/);
  });
  it("refuses odd emails and hostile strings", () => {
    for (const bad of ["", "nope", "a b@x.test", "a@x.test; drop table staff_role;--", "x'--@x.test", "a@x", "a\n@x.test", "é@x.test", `${"a".repeat(250)}@x.test`])
      for (let slot = 0; slot < 3; slot++) {
        const argv = ["p@x.test", "q@x.test", "r@x.test", "administrator"];
        argv[slot] = bad;
        expect(parseGrantArgs(argv).error, `${slot}: ${bad}`).toBeTruthy();
      }
  });
  it("refuses an unknown role, including hostile ones", () => {
    for (const role of ["", "root", "Administrator", "administrator,content_editor", "x'; drop table staff_role;--"])
      expect(parseGrantArgs(["p@x.test", "q@x.test", "r@x.test", role]).error, role).toMatch(/unknown role/);
  });
  it("refuses the same proposer and confirmer, even in other case", () => {
    expect(parseGrantArgs(["p@x.test", " P@X.test", "r@x.test", "administrator"]).error).toMatch(/two different/);
  });
  it("main refuses before it connects when the input or DATABASE_URL is missing", async () => {
    const lines: string[] = [];
    expect(await main(["a@x.test", "a@x.test", "c@x.test", "administrator"], { DATABASE_URL: "postgres://x@127.0.0.1:1/x" }, (l) => lines.push(l))).toBe(2);
    expect(await main(["a@x.test", "b@x.test", "c@x.test", "administrator"], {}, (l) => lines.push(l))).toBe(2);
    expect(lines.join("\n")).toMatch(/two different[\s\S]*DATABASE_URL is not set/);
  });
});
