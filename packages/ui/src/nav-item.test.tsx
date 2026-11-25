import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isClosest, isCurrent, NavItem } from "./nav-item";

describe("the sidebar link marks the page you are on", () => {
  it("matches the page and pages under it, and / only itself", () => {
    expect(isCurrent("/jobs", "/jobs")).toBe(true);
    expect(isCurrent("/jobs/12", "/jobs")).toBe(true);
    expect(isCurrent("/jobsearch", "/jobs")).toBe(false);
    expect(isCurrent("/jobs", "/")).toBe(false);
    expect(isCurrent("/", "/")).toBe(true);
    expect(isCurrent(null, "/jobs")).toBe(false);
  });
  it("a page under two links of one menu marks only the closest", () => {
    const menu = ["/", "/jobs", "/jobs/new", "/team"];
    expect(menu.filter((h) => isClosest("/jobs/new", h, menu))).toEqual(["/jobs/new"]);
    expect(menu.filter((h) => isClosest("/jobs/12/edit", h, menu))).toEqual(["/jobs"]);
    expect(menu.filter((h) => isClosest("/", h, menu))).toEqual(["/"]);
    expect(menu.filter((h) => isClosest(null, h, menu))).toEqual([]);
  });
  it("sets aria-current and the on style only for the current page (outside a Next router the address is unknown, so nothing is marked)", () => {
    const on = html(<NavItem href="/team" current="/team" base="b" on="ON" off="OFF">Team</NavItem>);
    expect(on).toContain('aria-current="page"');
    expect(on).toContain("ON");
    const off = html(<NavItem href="/team" base="b" on="ON" off="OFF">Team</NavItem>);
    expect(off).not.toContain("aria-current");
    expect(off).toContain("OFF");
  });
});
