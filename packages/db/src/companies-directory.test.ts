// B25: the pure parts of the directory read: initials and the cursor. No database.
import { describe, expect, it } from "vitest";
import { decodeDirectoryCursor, initials, listCompanies } from "./companies-directory";

describe("companies directory", () => {
  it("initials take the first letter or digit of the first two words", () => {
    expect([initials("Northquay Hospital Group"), initials("ÉIRE care"), initials("3M"), initials("&&"), initials("o'neill & sons")]).toEqual(["NH", "ÉC", "3", "?", "ON"]);
  });
  it("a cursor round-trips only as [name, id]; anything else is a bad cursor", () => {
    const ok = Buffer.from(JSON.stringify(["Fake Co", "12"])).toString("base64url");
    expect(decodeDirectoryCursor(ok)).toEqual(["Fake Co", "12"]);
    for (const bad of ["", "x", Buffer.from("[1,2]").toString("base64url"), Buffer.from('["a","1;drop"]').toString("base64url"), Buffer.from(JSON.stringify(["a".repeat(501), "1"])).toString("base64url"), "a".repeat(1001)])
      expect(() => decodeDirectoryCursor(bad), bad).toThrow("bad cursor");
  });
  it("refuses a long search and finds nothing for one with no name key, before any statement", async () => {
    const db = { query: () => { throw new Error("no statement expected"); } };
    await expect(listCompanies(db, { q: "a".repeat(101) })).rejects.toThrow("search too long");
    expect(await listCompanies(db, { q: "%_%" })).toEqual({ companies: [], next: null });
  });
});
