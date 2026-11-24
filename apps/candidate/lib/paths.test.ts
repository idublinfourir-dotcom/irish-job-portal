// The public addresses of decision #288, made in one place (paths.ts). No database.
import { describe, expect, it } from "vitest";
import { occupationCodeOfSlug, occupationSlug } from "./occupations";
import { accountPath, afterSignInPath, casePath, companyPath, guidePath, helpPath, jobIdOf, jobPath, legalPath, loginPath, occupationPath, permitRequestPath, resetPath, signupPath, staticPath, updatePath, verifiedPath, verifyPath } from "./paths";

describe("the job address", () => {
  it("is title, county and id, in lower-case words", () => {
    expect(jobPath({ id: "4821", title: "Staff Nurse", county: "Cork" })).toBe("/jobs/staff-nurse-cork-4821");
    expect(jobPath({ id: "7", title: "Cook (Part-time) & Baker!", county: "Tipperary" })).toBe("/jobs/cook-part-time-baker-tipperary-7");
  });
  it("leaves the county out when there is none, and falls back to job for a title with no letters", () => {
    expect(jobPath({ id: "9", title: "Chef", county: null })).toBe("/jobs/chef-9");
    expect(jobPath({ id: "9", title: "!!!", county: null })).toBe("/jobs/job-9");
    expect(jobPath({ id: "9", title: "Café Manager", county: "Dún Laoghaire" })).toBe("/jobs/cafe-manager-dun-laoghaire-9");
  });
  it("caps a long title and never ends a word part in a hyphen", () => {
    const p = jobPath({ id: "1", title: "a".repeat(59) + " bbbbbb", county: "Cork" });
    expect(p).toBe(`/jobs/${"a".repeat(59)}-cork-1`);
    expect(jobPath({ id: "1", title: "x".repeat(10_000), county: null }).length).toBeLessThan(80);
  });
  it("only ever holds letters, digits and hyphens, whatever the title", () => {
    for (const title of ["<script>alert(1)</script>", "../../etc/passwd", "a/b?c=d#e", "x\u0000y\n", "🙂 emoji", "Ünïcödé", "%2e%2e"])
      expect(jobPath({ id: "5", title, county: "Cork" }), title).toMatch(/^\/jobs\/[a-z0-9-]+-5$/);
  });
  it("gives the id back from the last segment, and null when it ends in none", () => {
    for (const p of [jobPath({ id: "4821", title: "Staff Nurse 12", county: "Cork" }), jobPath({ id: "4821", title: "x", county: null })]) expect(jobIdOf(p.slice(6))).toBe("4821");
    expect(jobIdOf("4821")).toBe("4821");
    for (const s of ["", "staff-nurse", "staff-nurse-", "4821-staff", "staff-nurse-4821x", "a".repeat(5000), "1".repeat(19), "staff nurse 4821"]) expect(jobIdOf(s), s).toBeNull();
  });
});

describe("the other addresses", () => {
  it("are plural folders with the slug", () => {
    expect(companyPath("acme-ltd")).toBe("/companies/acme-ltd");
    expect(guidePath("working-in-ireland")).toBe("/guides/working-in-ireland");
    expect(updatePath("new-minimums")).toBe("/updates/new-minimums");
    expect(occupationPath(occupationSlug("1115")!)).toBe("/occupations/chief-executives-and-senior-officials");
    expect(occupationCodeOfSlug("chief-executives-and-senior-officials")).toBe("1115");
  });
  it("encode a hostile slug rather than pass it through", () => {
    for (const f of [companyPath, guidePath, updatePath, occupationPath]) expect(f("a/b?c#d ../").split("/").length, f.name).toBe(3);
    expect(companyPath("a/b")).toBe("/companies/a%2Fb");
  });
});

describe("the help, legal and static addresses (B21)", () => {
  it("make a help address from its slug, escaped", () => {
    expect(helpPath("who-needs-a-permit")).toBe("/help/who-needs-a-permit");
    expect(helpPath("a/b?c")).toBe("/help/a%2Fb%3Fc");
  });
  it("give each public legal text its page and any other purpose none", () => {
    expect(["privacy_notice", "signup_terms", "cookie_policy", "employer_acceptable_use", "data_retention"].map(legalPath)).toEqual(["/privacy", "/terms", "/cookies", "/employer-acceptable-use", "/data-retention"]);
    for (const p of ["portal_signup_terms", "visibility", "", "__proto__", "constructor", "toString"]) expect(legalPath(p), p).toBeNull();
  });
  it("give every static page of the sitemap its address and an unknown key none", () => {
    expect(["home", "jobs", "companies", "guides", "updates", "help", "eligibility-checker", "permit-services"].map(staticPath)).toEqual(["/", "/jobs", "/companies", "/guides", "/updates", "/help", "/eligibility-checker", "/permit-services"]);
    for (const k of ["", "nope", "__proto__", "constructor"]) expect(staticPath(k), k).toBeNull();
  });
});

describe("the sign-up, sign-in and permit service addresses (W2)", () => {
  it("are the ones the header, footer and job pages already link to", () => {
    expect([signupPath(), loginPath(), verifyPath(), resetPath(), accountPath()]).toEqual(["/signup", "/login", "/verify", "/reset", "/account"]);
    expect(staticPath("permit-services")).toBe("/permit-services");
    expect(afterSignInPath()).toBe("/jobs"); // P17 changes this to /account
  });
  it("keep the return address as one encoded value, and the verified landing keeps it too", () => {
    expect(loginPath("/jobs/staff-nurse-cork-4821?x=1&y=2")).toBe("/login?next=%2Fjobs%2Fstaff-nurse-cork-4821%3Fx%3D1%26y%3D2");
    expect(signupPath("/jobs/a-1")).toBe("/signup?next=%2Fjobs%2Fa-1");
    expect(verifiedPath("/jobs/a-1")).toBe("/verify?verified=1&next=%2Fjobs%2Fa-1");
    expect(verifiedPath()).toBe("/verify?verified=1");
    expect(loginPath(null)).toBe("/login");
  });
  it("name a job on the request form only by digits", () => {
    expect(permitRequestPath("1042")).toBe("/permit-services/request?job=1042");
    for (const bad of ["", null, undefined, "12a", "../1", "1".repeat(19), "1&x=2"]) expect(permitRequestPath(bad as string | null | undefined), String(bad)).toBe("/permit-services/request");
    expect(casePath("31")).toBe("/account/cases/31");
    expect(casePath("../x")).toBe("/account/cases/..%2Fx");
  });
});
