// The /search page's parts in every state: a role with each kind, none, empty, more, a problem, and hostile text shown as text. react-dom/server, no database.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SearchView } from "./search-view";

const org = { id: "12", displayName: "Fake Orchard Ltd", croNumber: "123456", kind: "public_body", status: "verified" };
const job = { id: "99", title: "Fake Welder", employerName: "Fake Orchard Ltd", county: null, status: "under_review" };
const kase = { id: "555", status: "documents_needed", permitType: "critical_skills", createdAt: "2026-11-24 09:00:00+00" };

describe("SearchView", () => {
  it("before a search: the field only, no result sections", () => {
    const p = html(<SearchView q="" />);
    expect(p).toMatch(/<form[^>]*action="\/search"[^>]*method="get"/);
    expect(p).not.toMatch(/<h2/);
  });
  it("a problem shows as a notice, and no section", () => {
    const p = html(<SearchView q="ab" problem="Type at least 3 characters." />);
    expect(p).toMatch(/Type at least 3 characters/);
    expect(p).not.toMatch(/<h2/);
  });
  it("a role with every kind: three sections, the rows, no raw status codes", () => {
    const p = html(<SearchView q="fake" found={{ organisations: { items: [org], more: false }, jobs: { items: [job], more: false }, cases: { items: [kase], more: false } }} />);
    expect(p.match(/<h2/g)).toHaveLength(3);
    expect(p).toMatch(/CRO 123456/);
    expect(p).toMatch(/public body/);
    expect(p).toMatch(/under review/);
    expect(p).toMatch(/No county/);
    expect(p).toMatch(/Case 555/);
    expect(p).toMatch(/documents needed/);
    expect(p).not.toMatch(/Showing the first 10/);
  });
  it("a kind that is absent is not shown at all, not even as empty", () => {
    const p = html(<SearchView q="fake" found={{ cases: { items: [], more: false } }} />);
    expect(p).not.toMatch(/Organisations|Jobs/);
    expect(p).toMatch(/Services cases/);
    expect(p).toMatch(/found by its number/);
  });
  it("no kind at all: says the roles cannot search", () => {
    expect(html(<SearchView q="fake" found={{}} />)).toMatch(/Your roles do not let you search/);
  });
  it("empty kind and more: the empty state, and the 'first 10' line", () => {
    const e = html(<SearchView q="zzz" found={{ organisations: { items: [], more: false } }} />);
    expect(e).toMatch(/No organisations match/);
    const m = html(<SearchView q="fake" found={{ jobs: { items: [job], more: true } }} />);
    expect(m).toMatch(/Showing the first 10/);
  });
  it("hostile text and names are escaped, never markup", () => {
    const evil = "<script>alert(1)</script>\"'&";
    const p = html(<SearchView q={evil} found={{ organisations: { items: [{ ...org, displayName: evil }], more: false } }} />);
    expect(p).not.toMatch(/<script/);
    expect(p).toMatch(/&lt;script&gt;/);
  });
});
