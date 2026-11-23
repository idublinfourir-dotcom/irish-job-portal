// P4: the sidebar counts mapping (pure, no database).
import { describe, expect, it } from "vitest";
import { sidebarCounts } from "./sidebar";

const base = { queues: {}, oldestSeconds: {}, reportsOpen: null, reportsNew: null, reportsJobHidden: null, appeals: null, contact: null, approvals: null, casesUnassigned: null, casesMine: null, casesOpen: null, mergeSuggestions: null };
describe("sidebarCounts", () => {
  it("maps each count to its link label, an empty queue to 0, and a count the roles do not cover to nothing", () => {
    expect(sidebarCounts({ ...base, queues: { account_review: 4 }, reportsOpen: 2, casesOpen: 9 })).toEqual({ "Account reviews": 4, "Fetched jobs": 0, "Reports and strikes": 2, "Services cases": 9 });
    expect(sidebarCounts(base)["Reports and strikes"]).toBeUndefined();
    expect(sidebarCounts(base)["Services cases"]).toBeUndefined();
  });
  it("never runs the name matcher count for the sidebar", () => expect(Object.keys(sidebarCounts({ ...base, mergeSuggestions: 14 }))).not.toContain("Name merges"));
});
