// The name merges page (frame D07): the DETE links list and the two-company merge, every state and role. react-dom/server, no browser, no network.
import type { CompanyPreview } from "@portal/db";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { href, NameMerges, type Suggestion } from "./view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/name-merges" }));

const s = (o: Partial<Suggestion> = {}): Suggestion => ({ deteName: "Fake Northquay Group DAC", permits: 12, organisationId: "310", organisation: "Fake Northquay Group", matchedName: "Fake Northquay Group", kind: "exact", ...o });
const co = (o: Partial<CompanyPreview> = {}): CompanyPreview => ({ id: "310", slug: "fake-a", display_name: "Fake A Ltd", kind: "employer", status: "verified", cro_number: "810001", merged_into_id: null, active_members: 2, jobs: 5, names: 1, ...o });
const page = (o: { links?: { suggestions: Suggestion[]; total: number } | null; roles?: string[]; page?: number; a?: string; b?: string; found?: CompanyPreview[] | null } = {}) =>
  html(<NameMerges links={o.links === undefined ? { suggestions: [s()], total: 1 } : o.links} roles={o.roles ?? ["account_reviewer"]} page={o.page ?? 1} a={o.a} b={o.b} found={o.found ?? null} />);
const clean = (t: string) => expect(t).not.toMatch(/[\u2013\u2014]|undefined|\[object|Launch B|Sample|\d+% match|automatically merged/);

describe("the DETE links", () => {
  it("an account reviewer sees both names, the kind of match and the two buttons; no percentage, no 'suggested automatically'", () => {
    const p = page();
    expect(p).toMatch(/Fake Northquay Group DAC/);
    expect(p).toMatch(/DETE legal name · 12 permits/);
    expect(p).toMatch(/Same name as Fake Northquay Group/);
    expect(p).toMatch(/>Confirm link</);
    expect(p).toMatch(/>Not the same</);
    expect(p).toMatch(/Nothing is linked or merged automatically/);
    expect(p).not.toMatch(/Suggested automatically|Eircode|directors/);
    clean(p);
  });
  it("a similar name says so; one permit is singular", () => {
    const p = page({ links: { suggestions: [s({ kind: "suggested", permits: 1, matchedName: "Fake Care" })], total: 1 } });
    expect(p).toMatch(/Similar name/);
    expect(p).toMatch(/Similar to Fake Care/);
    expect(p).toMatch(/· 1 permit</);
  });
  it("another role that reads the list sees it with no button and a note", () => {
    for (const roles of [["trust_and_safety"], ["administrator"]]) {
      const p = page({ roles });
      expect(p).toMatch(/Only an account reviewer confirms a link/);
      expect(p).not.toMatch(/>Confirm link</);
      expect(p).not.toMatch(/>Not the same</);
    }
  });
  it("a role that cannot read the list gets the note and the merge part only", () => {
    const p = page({ links: null, roles: ["rules_data_editor"] });
    expect(p).toMatch(/The DETE name links are not for your roles/);
    expect(p).not.toMatch(/Fake Northquay/);
    expect(p).toMatch(/Merge two companies/);
  });
  it("empty first page, empty later page, and Previous and Next by the page size", () => {
    expect(page({ links: { suggestions: [], total: 0 } })).toMatch(/No DETE names to link/);
    expect(page({ links: { suggestions: [], total: 3 }, page: 4 })).toMatch(/Back to the first page/);
    const mid = page({ links: { suggestions: [s()], total: 120 }, page: 2 });
    expect(mid).toMatch(/Previous/);
    expect(mid).toMatch(/Next/);
    expect(page({ links: { suggestions: [s()], total: 50 } })).not.toMatch(/Previous|rel="next"/);
    expect(href(1)).toBe("/name-merges");
    expect(href(3, "1", "2")).toBe("/name-merges?page=3&a=1&b=2");
  });
  it("names are text, never markup", () => {
    const p = page({ links: { suggestions: [s({ deteName: "<img src=x onerror=alert(1)> DAC", organisation: "<script>x</script>" })], total: 1 } });
    expect(p).not.toMatch(/<img|<script/);
    expect(p).toMatch(/&lt;img src=x onerror=alert\(1\)&gt; DAC/);
  });
});

describe("the two-company merge", () => {
  it("shows the form with no result before anything is asked", () => {
    const p = page();
    expect(p).toMatch(/name="a"/);
    expect(p).toMatch(/name="b"/);
    expect(p).toMatch(/>Compare</);
  });
  it("two found companies show their counts and a Keep button for each; the reviewers may merge", () => {
    const p = page({ a: "310", b: "311", found: [co(), co({ id: "311", display_name: "Fake B Ltd", jobs: 0, status: "pending_review" })], roles: ["fetched_job_reviewer"] });
    expect(p).toMatch(/Fake A Ltd/);
    expect(p).toMatch(/Fake B Ltd/);
    expect(p).toMatch(/Active members/);
    expect(p).toMatch(/>Keep Fake A Ltd</);
    expect(p).toMatch(/>Keep Fake B Ltd</);
    expect(page({ a: "310", b: "311", found: [co(), co({ id: "311" })], roles: ["rules_data_editor"] })).toMatch(/Only an account reviewer or a fetched-job reviewer merges companies/);
    expect(page({ a: "310", b: "311", found: [co(), co({ id: "311" })], roles: ["rules_data_editor"] })).not.toMatch(/>Keep /);
  });
  it("one missing company, none found and the same number twice are notices, not errors", () => {
    expect(page({ a: "310", b: "999", found: [co()] })).toMatch(/Company number 999 was not found/);
    expect(page({ a: "998", b: "999", found: [] })).toMatch(/Neither company number was found/);
    const same = page({ a: "310", b: "310", found: [co()] });
    expect(same).toMatch(/Pick two different companies/);
    expect(same).not.toMatch(/>Keep /);
  });
  it("an already merged company says so", () => {
    expect(page({ a: "310", b: "311", found: [co({ merged_into_id: "5" }), co({ id: "311" })] })).toMatch(/Already merged into another company/);
  });
});
