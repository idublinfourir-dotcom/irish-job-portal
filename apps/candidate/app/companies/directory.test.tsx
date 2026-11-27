// Unit (check 3): the companies directory (frame C13), with fixtures. No database, network or browser.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DirectoryView, moreHref, type CompanyRow } from "./directory-view";

vi.mock("server-only", () => ({}));

const row = (o: Partial<CompanyRow> = {}): CompanyRow => ({ slug: "acme-ltd", name: "Acme Ltd", initials: "AL", county: "Cork", labels: ["First-time sponsor"], permitsSince2019: 12, liveJobs: 3, ...o });

describe("companies directory (C13)", () => {
  it("shows each row with its link, county, label, permits and live jobs, and no sector", () => {
    const h = html(<DirectoryView companies={[row()]} next={null} q="" />);
    for (const t of ["Companies that", "Permit history from DETE records since 2019.", "Acme Ltd", "AL", "Cork", "First-time sponsor", ">12<", ">3<", "Search a company or legal name", 'maxLength="100"']) expect(h).toContain(t);
    expect(h).toContain('href="/companies/acme-ltd"');
    expect(h).not.toMatch(/sector/i);
    expect(h).not.toContain("More companies");
  });
  it("says the permit history is not linked when there is no count", () => {
    expect(html(<DirectoryView companies={[row({ permitsSince2019: null, labels: [] })]} next={null} q="" />)).toContain("Permit history not linked yet");
    expect(html(<DirectoryView companies={[row({ permitsSince2019: 0 })]} next={null} q="" />)).not.toContain("not linked");
  });
  it("shows the no-results state with a way to clear the search, and the empty state without one", () => {
    const none = html(<DirectoryView companies={[]} next={null} q="zzz" />);
    expect(none).toContain("No companies found");
    expect(none).toContain('href="/companies"');
    const empty = html(<DirectoryView companies={[]} next={null} q="" />);
    expect(empty).toContain("No companies yet");
    expect(empty).not.toContain("Clear the search");
  });
  it("links More companies with the search and the cursor", () => {
    const h = html(<DirectoryView companies={[row()]} next="c1" q="acme" />);
    expect(h).toContain('href="/companies?q=acme&amp;after=c1"');
    expect(moreHref("", "c1")).toBe("/companies?after=c1");
  });
  it("renders a hostile search as text and encodes it in the more link", () => {
    const q = `<script>alert("x")</script>'%`;
    const h = html(<DirectoryView companies={[row()]} next={`a&b="`} q={q} />);
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
    expect(h).toContain(`q=${encodeURIComponent(q).replace("'", "&#x27;")}&amp;after=${encodeURIComponent('a&b="')}`);
  });
});
