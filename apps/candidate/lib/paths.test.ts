// The public addresses of decision #288, made in one place (paths.ts). No database.
import { describe, expect, it } from "vitest";
import { occupationCodeOfSlug, occupationSlug } from "./occupations";
import { companyPath, guidePath, jobIdOf, jobPath, occupationPath, updatePath } from "./paths";

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
