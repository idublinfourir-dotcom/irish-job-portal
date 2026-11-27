// PERF-5: prefetch is off by default for our own paths, loading.tsx exists for the five main segments, the pending mark adds nothing to the server HTML.
import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { A } from "./link";

const app = (p: string) => new URL(`../../../apps/candidate/app/${p}`, import.meta.url);

describe("A", () => {
  it("renders the same markup as a plain link until a click, and an outside link as a plain anchor", () => {
    expect(html(<A href="/jobs">Jobs</A>)).toBe('<a href="/jobs">Jobs</a>');
    expect(html(<A href="https://x.ie/a">X</A>)).toBe('<a href="https://x.ie/a">X</a>');
  });
  it("turns prefetch off for our own paths unless asked", () => {
    const src = readFileSync(new URL("./link.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/prefetch = false/);
    expect(src).toMatch(/prefetch=\{prefetch\}/);
  });
});

describe("loading.tsx", () => {
  it.each(["jobs", "jobs/[job]", "companies/[slug]", "occupations/[slug]", "account"])("%s has a skeleton with no data in it", (seg) => {
    const f = app(`${seg}/loading.tsx`);
    expect(existsSync(f)).toBe(true);
    const src = readFileSync(f, "utf8");
    expect(src).toContain("mo-sk");
    expect(src).not.toMatch(/import|fetch|cookie|session/i);
  });
});
