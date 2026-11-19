// Step 15 Q5: the pure suggestion list (no database). One row per company and DETE name at its best score, rejected pairs left out, best first.
import { describe, expect, it } from "vitest";
import { suggestLinks } from "./dete-links";

const UNLINKED = [{ name: "Acme Robotics Ireland Limited", permits: 50 }, { name: "Acme Robotics Services Ltd", permits: 9 }, { name: "Beta Foods Ltd", permits: 300 }, { name: "Ltd", permits: 1 }];
const COMPANIES = [
  { id: "1", display: "Acme", names: ["Acme Robotics", "Acme", "Acme Robotics"] },
  { id: "2", display: "Beta Foods", names: ["Beta Foods", "Beta"] },
  { id: "3", display: "Ltd", names: ["Ltd", "Limited"] },
];

describe("suggestLinks", () => {
  it("best first, one row per company and DETE name, a name that cleans to nothing never matches", () => {
    const s = suggestLinks(UNLINKED, COMPANIES, []);
    expect(s.map((x) => [x.organisationId, x.deteName, x.score, x.kind, x.permits])).toEqual([
      ["2", "Beta Foods Ltd", 1, "exact", 300],
      ["1", "Acme Robotics Ireland Limited", 1, "exact", 50],
    ]);
    expect(s[1]!.matchedName).toBe("Acme Robotics");
  });
  it("a rejected pair is left out and the next candidate comes up; the pair for another company stays", () => {
    const s = suggestLinks(UNLINKED, COMPANIES, [{ org: "1", name: "Acme Robotics Ireland Limited" }]);
    expect(s.filter((x) => x.organisationId === "1").map((x) => x.deteName)).toEqual(["Acme Robotics Services Ltd"]);
    expect(suggestLinks(UNLINKED, COMPANIES, [{ org: "9", name: "Beta Foods Ltd" }])[0]!.deteName).toBe("Beta Foods Ltd");
  });
  it("nothing to match gives an empty list", () => {
    expect(suggestLinks([], COMPANIES, [])).toEqual([]);
    expect(suggestLinks(UNLINKED, [], [])).toEqual([]);
  });
});
