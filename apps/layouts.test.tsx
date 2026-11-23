// Integration: each app's real layout renders its shell around a page. The font loader is replaced because next/font only works inside the Next build.
import { SITE_NAME } from "@portal/ui";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AdminLayout, { metadata as adminMeta } from "./admin/app/layout";
import AdminPage from "./admin/app/page";
import CandidateLayout, { metadata as candidateMeta } from "./candidate/app/layout";
import CandidatePage from "./candidate/app/page";
import PortalLayout, { metadata as portalMeta } from "./portal/app/layout";
import PortalPage from "./portal/app/page";

vi.mock("next/font/google", () => ({
  Outfit: () => ({ variable: "outfit-var" }),
  DM_Sans: () => ({ variable: "dm-sans-var" }),
}));

const render = (L: typeof CandidateLayout, P: () => React.ReactNode) => html(<L>{P()}</L>);

describe("candidate layout", () => {
  const h = render(CandidateLayout, CandidatePage);
  it("has the public nav, the page and both fonts", () => {
    for (const t of ["Find jobs", "Companies", "Guides", "Eligibility checker", "Permit services", "For employers", "Log in", "Create account", "Nothing here yet."]) expect(h).toContain(t);
    expect(h).toContain('lang="en"');
    expect(h).toContain("outfit-var dm-sans-var");
  });
  it("has the footer lines", () => {
    expect(h).toContain("Place names from");
    expect(h).toContain('href="https://www.geonames.org/"');
    expect(h).toContain("No genuine employer asks you to pay for a job offer.");
  });
  it("has one main landmark and no cookie banner while K11 is open", () => {
    expect(h.match(/<main\b/g)).toHaveLength(1);
    expect(h).not.toContain("Cookies on");
  });
});

describe("portal layout", () => {
  const h = render(PortalLayout, PortalPage);
  it("has the employer sidebar around the page", () => {
    for (const t of ["Dashboard", "Post a job", "Company profile", "Account status", "Nothing here yet."]) expect(h).toContain(t);
    expect(h).not.toContain("Candidate search");
    expect(h.match(/<main\b/g)).toHaveLength(1);
  });
});

describe("admin layout", () => {
  const h = render(AdminLayout, AdminPage);
  it("has the staff sidebar, tagged internal, with no role-only links for a member with no role", () => {
    for (const t of ["Internal, staff only", "Overview", "Audit log", "Nothing here yet."]) expect(h).toContain(t);
    expect(h).not.toContain("Account reviews");
    expect(h.match(/<main\b/g)).toHaveLength(1);
  });
});

describe.each([["candidate", render(CandidateLayout, CandidatePage)], ["portal", render(PortalLayout, PortalPage)], ["admin", render(AdminLayout, AdminPage)]])("%s", (_n, markup) => {
  it("has no Sample text and no mock logo", () => {
    expect(markup).not.toMatch(/Sample|Permitly|<img/i);
  });
  it("keeps the brand name", () => expect(markup).toContain(SITE_NAME));
});

describe("search engines", () => {
  it("stay out of all three apps until the SEO slice flips it", () => {
    for (const m of [candidateMeta, portalMeta, adminMeta]) expect(m.robots).toEqual({ index: false, follow: false });
  });
});
