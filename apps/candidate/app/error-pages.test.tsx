// Unit tests (no database, no network): the 404 and error pages render with their buttons and read nothing.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import NotFound, { metadata } from "./not-found";
import ErrorPage from "./error";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

describe("not-found page", () => {
  it("has one h1, Find jobs and Home links, and is noindex", () => {
    const h = html(<NotFound />);
    expect(h.match(/<h1/g)).toHaveLength(1);
    expect(h).toContain('href="/jobs"');
    expect(h).toContain('href="/"');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

describe("error page", () => {
  it("has Try again and shows nothing from the error", () => {
    const h = html(<ErrorPage error={Object.assign(new Error("secret db password"), { digest: "d1" })} reset={() => {}} />);
    expect(h).toContain("Try again");
    expect(h).not.toContain("secret");
    expect(h).not.toContain("d1");
  });
});
