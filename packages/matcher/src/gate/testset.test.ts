import { describe, expect, it } from "vitest";
import { checkFrozen, parseTestSet, sha256 } from "./testset";

const line = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ id: "t-1", advert: { source: "greenhouse", title: "Architect", description: "d", salaryBox: null }, label: { qualifies: true, occupationCode: "2135", note: "n" }, ...o });

describe("checkFrozen", () => {
  const set = line() + "\n";
  it("accepts the matching hash, bare or in the sha256sum layout, in any case", () => {
    expect(checkFrozen(set, sha256(set))).toBe(sha256(set));
    expect(checkFrozen(set, `${sha256(set)}  testset.jsonl\n`)).toBe(sha256(set));
    expect(checkFrozen(set, sha256(set).toUpperCase())).toBe(sha256(set));
  });
  it("refuses a changed set", () => {
    expect(() => checkFrozen(set + " ", sha256(set))).toThrow(/does not match its frozen hash/);
  });
  it("refuses a frozen file that holds no hash", () => {
    expect(() => checkFrozen(set, "")).toThrow(/64 character/);
    expect(() => checkFrozen(set, "abc")).toThrow(/64 character/);
  });
});

describe("parseTestSet", () => {
  it("reads good lines and skips blank ones", () => {
    const rows = parseTestSet(line() + "\n\n" + line({ id: "t-2" }) + "\n");
    expect(rows.map((r) => r.id)).toEqual(["t-1", "t-2"]);
    expect(rows[0]?.label).toEqual({ qualifies: true, occupationCode: "2135", note: "n" });
  });

  it.each([
    ["not JSON", "{oops", /line 1: not JSON/],
    ["no id", line({ id: "" }), /id must be/],
    ["a repeated id", line() + "\n" + line(), /line 2: id t-1 is used twice/],
    ["no source", line({ advert: { title: "x" } }), /needs a string "source"/],
    ["an unknown advert field", line({ advert: { source: "s", cv: "x" } }), /unknown advert field "cv"/],
    ["a number field", line({ advert: { source: "s", title: 5 } }), /"title" must be a string or null/],
    ["a label that is not a yes or no", line({ label: { qualifies: "yes", occupationCode: "1", note: "" } }), /label needs/],
    ["no label", line({ label: undefined }), /label needs/],
  ])("refuses %s, naming the line and never the advert text", (_n, text, message) => {
    expect(() => parseTestSet(text)).toThrow(message);
    try {
      parseTestSet(text);
    } catch (e) {
      expect((e as Error).message).not.toContain("Architect");
    }
  });
});
