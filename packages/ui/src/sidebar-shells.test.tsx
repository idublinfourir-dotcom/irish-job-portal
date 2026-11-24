// P3 and the P4 search box: the portal's banner, bell, top bar and footer, and the admin's search form, rendered to HTML with fixture props.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminShell, PortalShell } from "./index";

const portal = (p: Partial<Parameters<typeof PortalShell>[0]> = {}) => html(<PortalShell companyName="Fake Co" role="Poster" roleKey="poster" {...p}>BODY</PortalShell>);

describe("portal shell: company status banner", () => {
  it("shows a banner for suspended, closed and restricted, with the plain words and the status on the element", () => {
    expect(portal({ status: "suspended" })).toContain("This company account is suspended");
    expect(portal({ status: "closed" })).toContain('data-company-status="closed"');
    expect(portal({ status: "verified_restricted" })).toContain("restricted");
  });
  it("shows none for a verified, pending, unknown or missing status, and the page body stays", () => {
    for (const status of ["verified", "pending_review", "needs_info", "banned", "x", "", undefined]) {
      const h = portal({ status });
      expect(h, String(status)).not.toContain("data-company-status");
      expect(h).toContain("BODY");
    }
  });
  it("puts the banner before the page body", () => {
    const h = portal({ status: "suspended" });
    expect(h.indexOf("data-company-status")).toBeLessThan(h.indexOf("BODY"));
  });
});

describe("portal shell: bell, post button, footer", () => {
  it("shows the unread count, caps it at 200+, and says none when zero", () => {
    expect(portal({ unread: 3 })).toContain("Notices, 3 unread");
    expect(portal({ unread: 3 })).toMatch(/data-unread[^>]*>3</);
    expect(portal({ unread: 200 })).toContain("200+");
    expect(portal({ unread: 200 })).toContain("200 or more");
    const none = portal();
    expect(none).toContain("none unread");
    expect(none).not.toContain("data-unread");
  });
  it("shows Post a job in the top bar only to a role that may post", () => {
    expect(portal({ roleKey: "poster" })).toContain('href="/jobs/new"');
    expect(portal({ roleKey: "account_owner" })).toContain('href="/jobs/new"');
    expect(portal({ roleKey: "viewer" })).not.toContain("/jobs/new");
  });
  it("has a footer with the help link and the standing line when given, escaped", () => {
    const h = portal({ standingLine: '<img src=x onerror=alert(1)>' });
    expect(h).toContain("<footer");
    expect(h).toContain('href="/help"');
    expect(h).toContain("&lt;img");
    expect(h).not.toContain("<img");
    expect(portal()).not.toContain("standing-line");
  });
  it("escapes a hostile company name and has no search box (the portal has no search page)", () => {
    const h = portal({ companyName: "<script>1</script>" });
    expect(h).not.toContain("<script>");
    expect(h).not.toContain('role="search"');
  });
  it("is the dark floating sidebar with the logo, the ring and an icon on every link (frame NE2)", () => {
    const h = portal();
    expect(h).toContain("bg-ink text-white");
    expect(h).toContain("data-ring");
    expect(h).toContain("for employers");
    const nav = h.match(/<nav aria-label="Sections"[\s\S]*?<\/nav>/)![0];
    const links = [...nav.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)];
    expect(links.length).toBeGreaterThan(5);
    for (const m of links) expect(m[1]).toContain("<svg");
  });
  it("company chip: initials, role, and the status in words when known; a name of one letter or a missing status is fine", () => {
    expect(portal({ status: "verified", companyName: "Harbourline Hotels" })).toMatch(/data-company-chip[\s\S]*HH[\s\S]*Harbourline Hotels[\s\S]*Poster · Verified/);
    expect(portal({ status: "verified_restricted" })).toContain("Poster · Restricted");
    expect(portal({ status: "some_new_status" })).not.toContain("Poster ·");
    expect(portal({ companyName: "A" })).toContain(">A</span>");
  });
});

describe("admin shell: search box", () => {
  const h = html(<AdminShell roles={["administrator"]} name="Dara">x</AdminShell>);
  it("is a plain GET form to /search with a q field, no script", () => {
    expect(h).toContain('action="/search"');
    expect(h).toContain('method="get"');
    expect(h).toContain('role="search"');
    expect(h).toContain('name="q"');
    expect(h).toMatch(/maxlength="200"/i);
    expect(h).not.toContain("<script");
  });
  it("has a label for the field and sits in the bar above the page, before the page body (frame ND1)", () => {
    expect(h).toContain('for="staff-search"');
    expect(h).toContain('id="staff-search"');
    expect(h.indexOf('role="search"')).toBeGreaterThan(h.indexOf('aria-label="Sections"'));
    expect(h.indexOf('role="search"')).toBeLessThan(h.indexOf('id="main"'));
  });
  it("shows the badge, the person and their roles in plain words (frame ND1)", () => {
    expect(h).toContain("Internal, staff only");
    expect(h).toContain(">Dara</span>");
    expect(html(<AdminShell roles={["services_case_handler"]} name="Dara">x</AdminShell>)).toContain(">services case handler</span>");
    expect(html(<AdminShell roles={["administrator", "content_editor", "trust_and_safety"]} name="Dara">x</AdminShell>)).toContain(">administrator and 2 more</span>");
    expect(html(<AdminShell roles={[]} name="Dara">x</AdminShell>)).toContain(">no role</span>");
  });
  it("has an icon on every link and the count beside it", () => {
    const x = html(<AdminShell roles={["administrator"]} name="D" counts={{ "Account reviews": 9 }}>x</AdminShell>);
    for (const m of x.matchAll(/<a [^>]*href="\/(?:account-reviews|rules|audit|staff|fetched-jobs)"[^>]*>([\s\S]*?)<\/a>/g)) expect(m[1]).toContain("<svg");
    expect(html(<AdminShell roles={["account_reviewer"]} name="D" counts={{ "Account reviews": 9 }}>x</AdminShell>)).toMatch(/data-count="?[^>]*>9</);
  });
  it("is in every role's sidebar and has no banner, bell or footer", () => {
    for (const roles of [[], ["account_reviewer"], ["administrator"]] as const) {
      const x = html(<AdminShell roles={roles} name="D">x</AdminShell>);
      expect(x).toContain('role="search"');
      expect(x).not.toContain("<footer");
      expect(x).not.toContain("Notices");
    }
  });
  it("keeps the sidebar light (not the portal's dark one)", () => expect(h).not.toContain("bg-ink text-white"));
});
