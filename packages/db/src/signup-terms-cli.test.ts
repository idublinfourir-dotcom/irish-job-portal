// No database: the placeholder wording command's input checks. The end-to-end run is packages/db/test/candidate-login.test.ts.
import { describe, expect, it } from "vitest";
import { main, parseTermsArgs, PLACEHOLDER_BODY, PLACEHOLDER_VERSION, PORTAL_PLACEHOLDER_BODY } from "./signup-terms-cli.ts";

describe("placeholder wording command input checks", () => {
  it("takes two different plain staff ids", () => {
    expect(parseTermsArgs(["abc-123", "def_456"]).ids).toEqual(["abc-123", "def_456"]);
  });
  it("takes --portal first, and only first, with or without it giving the same two ids", () => {
    expect(parseTermsArgs(["abc", "def"])).toEqual({ ids: ["abc", "def"], portal: false });
    expect(parseTermsArgs(["--portal", "abc", "def"])).toEqual({ ids: ["abc", "def"], portal: true });
    for (const argv of [["abc", "def", "--portal"], ["abc", "--portal", "def"], ["--portal"], ["--portal", "a"], ["--portal", "a", "b", "c"], ["--Portal", "a", "b"]])
      expect(parseTermsArgs(argv).ids, argv.join(" ")).toBeUndefined();
    expect(parseTermsArgs(["--portal", "a", "a"]).error).toMatch(/two different/);
    expect(parseTermsArgs(["--portal", "x'; drop table consent_text;--", "b"]).error).toMatch(/staff id is 1 to 64/);
  });
  it("refuses the same id twice, odd ids and the wrong number of arguments", () => {
    expect(parseTermsArgs(["a", "a"]).error).toMatch(/two different/);
    for (const bad of ["", "a b", "a;b", "x'; drop table consent_text;--", "x".repeat(65), "a\nb", "é"]) expect(parseTermsArgs([bad, "b"]).error, bad).toMatch(/staff id is 1 to 64/);
    for (const argv of [[], ["a"], ["a", "b", "c"]]) expect(parseTermsArgs(argv).error).toMatch(/usage/);
  });
  it("names the text as placeholder wording", () => {
    expect(PLACEHOLDER_VERSION).toBe("placeholder-2026-11-12");
    expect(PLACEHOLDER_BODY).toMatch(/^PLACEHOLDER TEXT/);
    expect(PORTAL_PLACEHOLDER_BODY).toMatch(/^PLACEHOLDER TEXT.*employer and agency/);
  });
  it("main refuses before it connects when the input or DATABASE_URL is missing", async () => {
    const lines: string[] = [];
    expect(await main(["a", "a"], { DATABASE_URL: "postgres://x@127.0.0.1:1/x" }, (l) => lines.push(l))).toBe(2);
    expect(await main(["a", "b"], {}, (l) => lines.push(l))).toBe(2);
    expect(lines.join("\n")).toMatch(/two different[\s\S]*DATABASE_URL is not set/);
  });
});
