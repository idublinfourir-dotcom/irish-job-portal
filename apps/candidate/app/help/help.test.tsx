// Unit (check 3): the help page, one help page ("Not sure?", C25), the contact form and the report page, for every state. Fixtures only; the contact form is rendered as the server renders it.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReportView } from "../report/report-view";
import { ContactForm } from "./contact-form";
import { GROUPS, HelpView, grouped, type HelpItem } from "./help-view";
import { HelpPageView, WHO_NEEDS_PERMIT } from "./help-page-view";

vi.mock("server-only", () => ({}));

const pages: HelpItem[] = [
  { slug: "delete", title: "How do I delete my account?", category: "account" }, { slug: "badge", title: "What is a badge?", category: "jobs_badges" },
  { slug: "who-needs-a-permit", title: "Who needs a permit?", category: "permit_services" }, { slug: "scam", title: "How do I report a scam?", category: "report_problem" },
  { slug: "odd", title: "An odd one", category: null }, { slug: "odder", title: "Another", category: "a_new_group" },
];

describe("the help page (C21, without search, #287 L62)", () => {
  it("groups the pages in the order of the four cards, then the rest, and drops empty groups", () => {
    expect(grouped(pages).map((g) => [g.key, g.pages.length])).toEqual([["account", 1], ["jobs_badges", 1], ["permit_services", 1], ["report_problem", 1], ["other", 2]]);
    expect(grouped([pages[0]!]).map((g) => g.key)).toEqual(["account"]);
    expect(grouped([])).toEqual([]);
  });
  it("shows the four cards, each question as a link to its own page, the contact form, the report card and the employer link", () => {
    const h = html(<HelpView pages={pages} signedIn={false} />);
    for (const g of GROUPS) { expect(h).toContain(g.title); expect(h).toContain(`href="#${g.key}"`); }
    expect(h).toContain('href="/help/delete"');
    expect(h).toContain("How do I report a scam?");
    expect(h).toContain("More questions");
    expect(h).toContain('aria-label="Contact us"');
    expect(h).toContain('href="/report"');
    expect(h).toContain('href="/employers"');
    expect(h.match(/<h1\b/g)).toHaveLength(1);
    for (const t of ["Search help", "A job listing", "2 working days", "Sample"]) expect(h).not.toContain(t);
    expect(h).toContain("data-join");
  });
  it("says when the list could not be read or is empty, and still has the form", () => {
    expect(html(<HelpView pages={null} signedIn />)).toContain("The questions could not be loaded.");
    expect(html(<HelpView pages={[]} signedIn />)).toContain("There are no help pages yet.");
    expect(html(<HelpView pages={null} signedIn />)).toContain('aria-label="Contact us"');
  });
});

describe("the contact form", () => {
  it("asks a visitor for a name and an email and offers the appeal topic", () => {
    const h = html(<ContactForm signedIn={false} />);
    expect(h).toContain('name="name"');
    expect(h).toContain('name="email"');
    expect(h).toContain('value="appeal"');
    expect(h).toContain('maxLength="5000"');
  });
  it("asks a signed-in candidate for neither, and does not offer the appeal topic (the route refuses it)", () => {
    const h = html(<ContactForm signedIn />);
    expect(h).not.toContain('name="name"');
    expect(h).not.toContain('name="email"');
    expect(h).not.toContain('value="appeal"');
    for (const t of ["general", "account", "data_request", "other"]) expect(h).toContain(`value="${t}"`);
  });
});

describe("one help page (C25)", () => {
  const p = { slug: "x", title: "How do I delete my account?", body: "Go to settings.\n\nThen confirm.", sourceUrl: null, checkedOn: "2026-11-12" };
  it("shows the title, the checked day, and the plain body", () => {
    const h = html(<HelpPageView page={p} signedIn />);
    expect(h).toContain("Checked on 12 Nov 2026");
    expect(h).toContain("Go to settings.");
    expect(h).not.toContain("Still not sure?");
    expect(h).not.toContain("data-join");
  });
  it("the sign-up question ends with 'Still not sure?' and the way back to sign-up", () => {
    const h = html(<HelpPageView page={{ ...p, slug: WHO_NEEDS_PERMIT, title: "Who needs an employment permit?", checkedOn: null }} signedIn={false} />);
    expect(h).toContain("Still not sure?");
    expect(h).toContain('href="/signup"');
    expect(h).toMatch(/<h1[^>]*>Who needs an <span[^>]*>employment permit\?<\/span><\/h1>/);
    expect(h).not.toContain("Checked on");
  });
});

describe("the report page (decision #259: a report needs a login)", () => {
  it("asks a visitor to sign in, and has the contact form", () => {
    const h = html(<ReportView signedIn={false} />);
    expect(h).toContain("Sign in to report a job");
    expect(h).toContain("/login?next=%2Freport");
    expect(h).toContain('aria-label="Contact us"');
    expect(h).not.toContain("Open the job and use its Report button");
  });
  it("tells a signed-in candidate to use the job's Report button, and has the contact form", () => {
    const h = html(<ReportView signedIn />);
    expect(h).toContain("Open the job and use its Report button");
    expect(h).not.toContain("Sign in to report a job");
    expect(h).toContain('aria-label="Contact us"');
    expect(h.match(/<h1\b/g)).toHaveLength(1);
  });
});
