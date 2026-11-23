// The three root layouts, rendered with the data layer stood in (the real reads are tried on the test database in packages/db/test/shells.test.ts). The font loader
// is replaced because next/font only works inside the Next build. Every state of each shell: signed out, signed in, each role, counts.
import { SITE_NAME } from "@portal/ui";
import { renderToStaticMarkup as html } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminLayout from "./admin/app/layout";
import CandidateLayout, { generateMetadata as candidateMeta } from "./candidate/app/layout";
import PortalLayout, { metadata as portalMeta } from "./portal/app/layout";
import AdminPage from "./admin/app/page";
import PortalPage from "./portal/app/page";
import { metadata as adminMeta } from "./admin/app/layout";

vi.mock("next/font/google", () => ({
  Outfit: () => ({ variable: "outfit-var" }),
  DM_Sans: () => ({ variable: "dm-sans-var" }),
}));

const { frame, shell, sidebar } = vi.hoisted(() => ({
  frame: { value: { signedIn: false, standingLine: "Our check is guidance, not a permit decision. Only DETE decides. Rules last checked on 2026-11-16.", origin: "https://example.test" as string | null } },
  shell: { value: null as { companyName: string; role: string } | null },
  sidebar: { value: null as { name: string; roles: string[]; counts: Record<string, number | undefined> } | null },
}));
vi.mock("./candidate/lib/data", () => ({ readSiteFrame: async () => frame.value }));
vi.mock("./portal/lib/data", () => ({ readShell: async () => shell.value }));
vi.mock("./admin/lib/data", () => ({ readSidebar: async () => sidebar.value }));

// The candidate home page reads the database, so it has its own tests (candidate/app/_home, packages/db/test/home-page.test.ts); the layout is tried around a stand-in.
const CandidatePage = () => <p>Nothing here yet.</p>;
const candidate = async () => html(await CandidateLayout({ children: CandidatePage() }));
const portal = async () => html(await PortalLayout({ children: PortalPage() }));
const admin = async () => html(await AdminLayout({ children: AdminPage() }));
const links = (h: string) => [...h.matchAll(/<a [^>]*>([^<]*)/g)].map((m) => m[1]!);
beforeEach(() => {
  frame.value = { ...frame.value, signedIn: false, origin: "https://example.test" };
  shell.value = null;
  sidebar.value = null;
});

describe("candidate layout (P1)", () => {
  it("signed out: the public nav, the page and both fonts", async () => {
    const h = await candidate();
    for (const t of ["Find jobs", "Companies", "Guides", "Eligibility checker", "Permit services", "For employers", "Log in", "Create account", "Nothing here yet."]) expect(h).toContain(t);
    expect(h).toContain('lang="en"');
    expect(h).toContain("outfit-var dm-sans-var");
    expect(h).not.toContain("Sign out");
  });
  it("signed in: the account nav and sign out, no log in", async () => {
    frame.value.signedIn = true;
    const h = await candidate();
    for (const t of ["Account", "Tracker", "Saved", "Alerts", "Sign out"]) expect(h).toContain(t);
    expect(h).not.toContain("Create account");
  });
  it("footer: the standing line with the date it was given, the GeoNames credit, the report line, the Cookies link", async () => {
    const h = await candidate();
    expect(h).toContain("Rules last checked on 2026-11-16.");
    expect(h.match(/Rules last checked on/g)).toHaveLength(1);
    expect(h).toContain('href="https://www.geonames.org/"');
    expect(h).toContain("CC BY 4.0");
    expect(h).toContain("No genuine employer asks you to pay for a job offer.");
    expect(links(h)).toContain("Cookies");
    expect(h).toContain('href="/cookies"');
  });
  it("footer without a standing line when the rules could not be read (the frame never fails the page)", async () => {
    frame.value.standingLine = null as unknown as string;
    expect(await candidate()).not.toContain("Rules last checked on");
  });
  it("Organization and WebSite JSON-LD on every page, and none without an origin", async () => {
    const h = await candidate();
    expect(h.match(/<script type="application\/ld\+json">/g)).toHaveLength(2);
    expect(h).toContain('"@type":"Organization"');
    expect(h).toContain('"@type":"WebSite"');
    frame.value.origin = null;
    expect(await candidate()).not.toContain("ld+json");
  });
  it("one main landmark, no cookie banner (#290)", async () => {
    const h = await candidate();
    expect(h.match(/<main\b/g)).toHaveLength(1);
    expect(h).not.toContain("Cookies on");
    expect(h).not.toContain("Reject");
  });
});

describe("portal layout (P3)", () => {
  it("a visitor, or a login with no company, gets the bare page: no sidebar, no company", async () => {
    const h = await portal();
    expect(h).toContain("Nothing here yet.");
    for (const t of ["Dashboard", "Company profile", "Post a job"]) expect(h).not.toContain(t);
    expect(h.match(/<main\b/g)).toHaveLength(1);
  });
  it("a member: the company name, the role label and the Launch A links, never Launch B ones", async () => {
    shell.value = { companyName: "Fake Company Ltd", role: "account_owner" };
    const h = await portal();
    for (const t of ["Fake Company Ltd", "Account owner", "Dashboard", "Jobs", "Post a job", "Permit services", "Company profile", "Team", "Account status", "Help"]) expect(h).toContain(t);
    for (const t of ["Applicants", "Candidate search", "Contact requests"]) expect(h).not.toContain(t);
    expect(h.match(/<main\b/g)).toHaveLength(1);
  });
  it.each([
    ["viewer", { post: false, services: false }],
    ["poster", { post: true, services: false }],
    ["recruiter", { post: true, services: true }],
    ["account_owner", { post: true, services: true }],
  ])("%s sees only the links the role can use", async (role, want) => {
    shell.value = { companyName: "Fake Company Ltd", role };
    const l = links(await portal());
    expect(l.includes("Post a job")).toBe(want.post);
    expect(l.includes("Permit services")).toBe(want.services);
    for (const t of ["Dashboard", "Jobs", "Company profile", "Team", "Account status", "Help"]) expect(l).toContain(t);
  });
  it("an unknown role string gets the bare page (fail closed)", async () => {
    shell.value = { companyName: "Fake Company Ltd", role: "superuser" };
    expect(await portal()).not.toContain("Dashboard");
  });
  it("a hostile company name is escaped", async () => {
    shell.value = { companyName: "<script>alert(1)</script>", role: "viewer" };
    const h = await portal();
    expect(h).not.toContain("<script>alert");
    expect(h).toContain("&lt;script&gt;");
  });
});

describe("admin layout (P4)", () => {
  it("a visitor gets the bare page: no sidebar, no staff links", async () => {
    const h = await admin();
    expect(h).toContain("Nothing here yet.");
    expect(h).not.toContain("Internal, staff only");
    expect(links(h)).not.toContain("Audit log");
  });
  it("a member with no role: name, internal tag, only the links every staff member may open", async () => {
    sidebar.value = { name: "Fake Staff", roles: [], counts: {} };
    const h = await admin();
    for (const t of ["Fake Staff", "Internal, staff only", "Nothing here yet."]) expect(h).toContain(t);
    expect(links(h)).toEqual(["Skip to content", "Overview", "Rules data", "Audit log"]);
    expect(h).not.toContain("Account reviews");
  });
  it("each role sees its own links and its counts", async () => {
    sidebar.value = { name: "Fake Staff", roles: ["account_reviewer", "services_case_handler"], counts: { "Account reviews": 7, "Services cases": 3, "Fetched jobs": 0 } };
    const h = await admin();
    const l = links(h);
    for (const t of ["Account reviews", "Services cases", "Name merges", "Manual posting"]) expect(l).toContain(t);
    for (const t of ["Fetched jobs", "Reports and strikes", "Ban list", "Staff and roles", "Content editor", "Big-company list"]) expect(l).not.toContain(t);
    expect(h).toMatch(/data-count[^>]*>7</);
    expect(h).toMatch(/data-count[^>]*>3</);
    expect(h).toContain("account reviewer, services case handler");
  });
  it("a role the shell does not know is dropped, not shown", async () => {
    sidebar.value = { name: "Fake Staff", roles: ["superuser"], counts: {} };
    expect(links(await admin())).toEqual(["Skip to content", "Overview", "Rules data", "Audit log"]);
  });
  it("no global search box until B58 exists", async () => {
    sidebar.value = { name: "Fake Staff", roles: ["administrator"], counts: {} };
    expect(await admin()).not.toMatch(/type="search"|role="search"/);
  });
});

describe.each([["candidate", candidate], ["portal", portal], ["admin", admin]] as const)("%s", (_n, render) => {
  it("has no Sample text and no mock logo", async () => expect(await render()).not.toMatch(/Sample|Permitly|<img/i));
  it("keeps the brand name from the one constant", async () => {
    sidebar.value = { name: "Fake Staff", roles: [], counts: {} };
    shell.value = { companyName: "Fake Company Ltd", role: "viewer" };
    expect(await render()).toContain(SITE_NAME);
  });
});

describe("search engines", () => {
  it("stay out of the portal and admin always", () => {
    for (const m of [portalMeta, adminMeta]) expect(m.robots).toEqual({ index: false, follow: false });
  });
  it("stay out of the candidate site until SITE_INDEXABLE=1", () => {
    const was = process.env.SITE_INDEXABLE;
    try {
      delete process.env.SITE_INDEXABLE;
      expect(candidateMeta().robots).toEqual({ index: false, follow: false });
      process.env.SITE_INDEXABLE = "1";
      expect(candidateMeta().robots).toEqual({ index: true, follow: true });
    } finally {
      if (was === undefined) delete process.env.SITE_INDEXABLE; else process.env.SITE_INDEXABLE = was;
    }
  });
});
