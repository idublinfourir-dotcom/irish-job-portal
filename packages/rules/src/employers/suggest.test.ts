import { describe, expect, it } from "vitest";
import { buildNameMatcher } from "./suggest";

// Expected values were produced by running prototype/employer_match.py on the same made-up list.
const NAMES = ["Alpha Care Ltd", "Beta Systems Ltd", "Gamma Meats Ireland UC", "Gamma Foods Ltd", "Delta Engineering Ltd", "Delta Wind Engineering Ltd", "Kappa Zeta Ltd", "Kappa Omega Ltd", "Ltd"];
const m = buildNameMatcher(NAMES);

describe("buildNameMatcher (R23)", () => {
  it("exact match after cleaning, score 1", () => {
    expect(m.suggest("gamma meats")).toEqual({ name: "Gamma Meats Ireland UC", score: 1, kind: "exact" });
    expect(m.suggest("DELTA ENGINEERING LIMITED")).toEqual({ name: "Delta Engineering Ltd", score: 1, kind: "exact" });
  });
  it("only generic words: no suggestion", () => {
    expect(m.suggest("Care Hospital")).toEqual({ name: null, score: 0, kind: "only generic words" });
  });
  it("a distinctive word no candidate has: no candidate", () => {
    expect(m.suggest("Unknownco")).toEqual({ name: null, score: 0, kind: "no candidate" });
    expect(m.suggest("Gamma Foods and Meats Unknownco")).toEqual({ name: null, score: 0, kind: "no candidate" });
  });
  it("every distinctive word of the job's employer must be in the candidate", () => {
    expect(m.suggest("Gamma Foods and Meats")).toEqual({ name: null, score: 0, kind: "no candidate" });
  });
  it("scores by shared rare words, rounded to two places", () => {
    expect(m.suggest("Delta")).toEqual({ name: "Delta Engineering Ltd", score: 0.67, kind: "suggested" });
    expect(m.suggest("Zeta")).toEqual({ name: "Kappa Zeta Ltd", score: 0.75, kind: "suggested" });
    expect(m.suggest("Delta Wind")).toEqual({ name: "Delta Wind Engineering Ltd", score: 0.83, kind: "suggested" });
    expect(m.suggest("Wind")).toEqual({ name: "Delta Wind Engineering Ltd", score: 0.59, kind: "suggested" });
  });
  it("word order does not matter", () => {
    expect(m.suggest("Engineering Wind Delta")).toEqual({ name: "Delta Wind Engineering Ltd", score: 1, kind: "suggested" });
  });
  it("generic words in the job's employer are skipped, not required", () => {
    expect(m.suggest("Alpha")).toEqual({ name: "Alpha Care Ltd", score: 1, kind: "suggested" });
  });
  it("empty and suffix-only names clean to an empty key and match a candidate that cleans to empty", () => {
    expect(m.suggest("")).toEqual({ name: "Ltd", score: 1, kind: "exact" });
    expect(buildNameMatcher(["Acme"]).suggest("Ltd")).toEqual({ name: null, score: 0, kind: "only generic words" });
  });
  it("known quirk: the first of two names that clean the same is the exact match", () => {
    const x = buildNameMatcher(["Zed Co Ltd", "Zed Co Ireland", "Other One", "Other Two"]);
    expect(x.suggest("Zed Co")).toEqual({ name: "Zed Co Ltd", score: 1, kind: "exact" });
  });
  it("known quirk: a name listed twice counts twice in the word frequencies", () => {
    const twice = buildNameMatcher(["Zed Co", "Zed Co", "Other 1", "Other 2", "Other 3"]);
    expect(twice.suggest("Zed")).toEqual({ name: "Zed Co", score: 0.67, kind: "suggested" });
  });
  it("known quirk: ties go to the first candidate in list order here; the Python picks by set order, which changes with the hash seed", () => {
    expect(buildNameMatcher(["Tie One", "Tie Two", "Other Thing", "More Stuff"]).suggest("Tie")).toEqual({ name: "Tie One", score: 0.5, kind: "suggested" });
    expect(buildNameMatcher(["Tie Two", "Tie One", "Other Thing", "More Stuff"]).suggest("Tie")).toEqual({ name: "Tie Two", score: 0.5, kind: "suggested" });
  });
  it("known quirk: the Python divides by zero when every word of the name is in every candidate (list of one); here that gives no candidate", () => {
    expect(buildNameMatcher(["Lone Ltd"]).suggest("Lone x")).toEqual({ name: null, score: 0, kind: "no candidate" });
  });
  it("known quirk: accented letters are cut by the cleaning, so only the ASCII part of a name is compared", () => {
    expect(buildNameMatcher(["Ünited Zeta", "Beta"]).suggest("nited Zeta").kind).toBe("exact");
  });
  it("an empty candidate list gives no candidate for any name", () => {
    expect(buildNameMatcher([]).suggest("Anything")).toEqual({ name: null, score: 0, kind: "no candidate" });
  });
  it("skip rules a candidate out, the exact one included, and the next best wins", () => {
    expect(m.suggest("Delta", (c) => c === "Delta Engineering Ltd")).toEqual({ name: "Delta Wind Engineering Ltd", score: 0.45, kind: "suggested" });
    expect(m.suggest("gamma meats", (c) => c === "Gamma Meats Ireland UC")).toEqual({ name: null, score: 0, kind: "no candidate" });
    expect(m.suggest("Zeta", () => false)).toEqual(m.suggest("Zeta"));
  });
  it("names like constructor or __proto__ are plain words", () => {
    expect(m.suggest("constructor")).toEqual({ name: null, score: 0, kind: "no candidate" });
    expect(m.suggest("__proto__")).toEqual({ name: null, score: 0, kind: "no candidate" });
  });
});
