// Unit (check 3): the guides index and a guide (P10, frames C15 and C16), the updates feed (C17): every state, with fixtures. No database, network or browser.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UpdatesView, categoryLabel, chipHref, knownCategory, type UpdateData } from "../updates/updates-view";
import { GuideView, sourceOf } from "./guide-view";
import { GuidesView } from "./guides-view";

vi.mock("server-only", () => ({}));

const guides = [{ slug: "a-guide", title: "A guide", checkedOn: "2026-11-12" }, { slug: "unchecked", title: "Never checked", checkedOn: null }];
const ups = [{ slug: "u1", title: "First update", publishedAt: "2026-07-01T23:30:00.000Z" }];

describe("guides index (C15, without chips or covers, #287)", () => {
  it("lists every guide with its checked day, links each one, and shows the three updates card", () => {
    const h = html(<GuidesView guides={guides} updates={ups} signedIn={false} />);
    expect(h).toMatch(/<h1[^>]*>Guides and <span[^>]*>government updates<\/span><\/h1>/);
    expect(h).toContain('href="/guides/a-guide"');
    expect(h).toContain("Checked on 12 Nov 2026");
    expect(h).toContain("Not yet checked");
    expect(h).toContain("First update");
    expect(h).toContain("2 Jul 2026"); // 23:30 UTC in July is the next Irish day
    expect(h).toContain('href="/updates"');
    for (const t of ["Cover image", "Start here", "min read", "Sample"]) expect(h).not.toContain(t);
    expect(h.match(/<img[^>]*>/g)).toHaveLength(2); // one self-hosted cover per guide
    for (const img of h.match(/<img[^>]*>/g)!) expect(img).toMatch(/src="\/[^"]*\.webp" width="742" height="420" alt="[^"]{10,}" loading="lazy"/);
    expect(h).toContain("data-join");
  });
  it("says when there is no guide and when the updates could not be read", () => {
    expect(html(<GuidesView guides={[]} updates={[]} signedIn />)).toContain("No guides yet");
    expect(html(<GuidesView guides={[]} updates={[]} signedIn />)).toContain("There are no updates yet.");
    expect(html(<GuidesView guides={guides} updates={null} signedIn />)).toContain("The updates could not be loaded.");
    expect(html(<GuidesView guides={guides} updates={null} signedIn />)).not.toContain("data-join");
  });
});

describe("a guide (C16)", () => {
  const g = { slug: "a-guide", title: "How the route works", body: "First paragraph.\n\nSecond <b>one</b>.", sourceUrl: "https://www.enterprise.gov.ie/x", checkedOn: "2026-11-12" };
  it("shows the title, the checked day, the source host, the body as paragraphs, and the way to the checker", () => {
    const h = html(<GuideView guide={g} signedIn={false} />);
    expect(h.match(/<h1\b/g)).toHaveLength(1);
    for (const t of ["How the route works", "Checked on 12 Nov 2026", "Source: enterprise.gov.ie", "First paragraph.", "Check your own case", 'href="/eligibility-checker"']) expect(h).toContain(t);
    expect(h).toContain("Second &lt;b&gt;one&lt;/b&gt;.");
    expect(h).not.toContain("<b>one");
    for (const t of ["On this page", "Related guides", "Cover image"]) expect(h).not.toContain(t); // wait for the body format (Q2) and L23
  });
  it("shows no checked pill or source when the guide has none, and never links a script address", () => {
    const h = html(<GuideView guide={{ ...g, checkedOn: null, sourceUrl: "javascript:alert(1)" }} signedIn />);
    expect(h).not.toContain("Checked on");
    expect(h).not.toContain("javascript:");
    expect(sourceOf("ftp://x.test")).toBeNull();
    expect(sourceOf(null)).toBeNull();
  });
});

describe("updates feed (C17)", () => {
  const u = (o: Partial<UpdateData> = {}): UpdateData => ({ id: "1", slug: "u1", title: "An update", body: "Body text.", sourceUrl: "https://enterprise.gov.ie/n", publishedAt: "2026-10-14T10:00:00Z", category: "quotas", effectiveFrom: "2027-01-01", ...o });
  it("shows the day, the type, the body, the effective day and the source", () => {
    const h = html(<UpdatesView updates={[u(), u({ id: "2", effectiveFrom: null, category: null, sourceUrl: null, title: "Second" })]} signedIn={false} />);
    for (const t of ["14 Oct 2026", "Quotas", "Effective from 1 Jan 2027", "DETE notice", "Published 14 Oct 2026", "Government <span"]) expect(h).toContain(t);
    for (const t of ["Email me updates", "Sample"]) expect(h).not.toContain(t);
    expect(h.match(/data-update/g)).toHaveLength(2);
  });
  it("has the chips of the four types, marks the one in use, and keeps the filter in the empty state", () => {
    const h = html(<UpdatesView updates={[]} category="quotas" signedIn />);
    for (const [, label] of [["", "Salary minimums"], ["", "Quotas"], ["", "Occupation lists"], ["", "Processing"], ["", "All"]]) expect(h).toContain(`>${label}<`);
    expect(h).toMatch(/aria-current="true"[^>]*>Quotas</);
    expect(h).toContain("There are no updates of this type yet.");
    expect(chipHref("quotas")).toBe("/updates?category=quotas");
    expect(chipHref()).toBe("/updates");
  });
  it("shows Previous and Next only, never page numbers", () => {
    const h = html(<UpdatesView updates={[u()]} signedIn prevHref="/updates" nextHref="/updates?after=c&back=" />);
    expect(h).toContain(">Previous<");
    expect(h).toContain(">Next<");
    expect(h).not.toMatch(/>\s*[0-9]\s*<\/a>/);
  });
  it("accepts only a known category from the address", () => {
    expect(knownCategory("quotas")).toBe("quotas");
    for (const bad of ["Quotas", "quotas'--", "", "<script>", undefined, "all"]) expect(knownCategory(bad)).toBeUndefined();
    expect(knownCategory(["processing", "x"])).toBe("processing");
    expect(categoryLabel("salary_minimums")).toBe("Salary minimums");
    expect(categoryLabel("nope")).toBeNull();
  });
});
